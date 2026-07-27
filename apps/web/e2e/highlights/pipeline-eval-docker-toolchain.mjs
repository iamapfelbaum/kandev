import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { capturePathIdentity } from "./pipeline-eval-docker-boundary.mjs";
import { captureTreeProof } from "./pipeline-eval-docker-cache.mjs";
import { acquirePrivateGoToolchain } from "./pipeline-eval-go-toolchain.mjs";
import { CONTAINER_GO_ROOT, compactTreeProof } from "./pipeline-eval-go-provision-contract.mjs";
import { provisionPrivateGoModuleCache } from "./pipeline-eval-go-provision.mjs";
import { runBoundedSubprocess } from "./pipeline-eval-shared.mjs";

export { provisionPrivateGoModuleCache } from "./pipeline-eval-go-provision.mjs";

const PNPM_VERSION_PATTERN = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const CONTAINER_GO_MOD_ROOT = "/kandev/toolchain/go-mod";

async function existingCanonicalPath(filePath, label) {
  const resolved = path.resolve(filePath);
  const canonical = await fs.realpath(resolved).catch((error) => {
    throw new Error(`${label} is unavailable: ${error.message}`, {
      cause: error,
    });
  });
  const value = await fs.lstat(canonical);
  if ((!value.isFile() && !value.isDirectory()) || value.isSymbolicLink()) {
    throw new Error(`${label} must resolve to a regular file or directory`);
  }
  return canonical;
}

async function toolMount(source, target) {
  const canonical = await existingCanonicalPath(source, `${target} toolchain source`);
  return {
    source: canonical,
    target,
    identity: await capturePathIdentity(canonical),
  };
}

async function commandOutput(runCommand, specification) {
  const result = await runCommand(specification);
  const output = result.stdout.trim();
  if (!output) {
    throw new Error(`${specification.phase} returned empty output`);
  }
  return output;
}

async function checkedInPnpmVersion(appsRoot) {
  const packageJson = JSON.parse(await fs.readFile(path.join(appsRoot, "package.json"), "utf8"));
  const value = PNPM_VERSION_PATTERN.exec(packageJson.packageManager ?? "")?.[1];
  if (!value) {
    throw new Error("Docker toolchain requires an exact checked-in pnpm packageManager version");
  }
  return value;
}

async function discoverPnpm(input, appsRoot) {
  const version = await checkedInPnpmVersion(appsRoot);
  const store = await commandOutput(input.runCommand, {
    command: "corepack",
    args: ["pnpm", "store", "path"],
    cwd: appsRoot,
    env: {
      ...input.inheritedEnv,
      COREPACK_ENABLE_NETWORK: "0",
    },
    phase: "docker-toolchain-pnpm-store",
    deadlineMs: 30_000,
  });
  const corepackHome =
    input.inheritedEnv.COREPACK_HOME ?? path.join(os.homedir(), ".cache", "node", "corepack");
  return {
    root: path.join(corepackHome, "v1", "pnpm", version),
    store,
  };
}

function acquisitionReceipt(acquired) {
  return {
    contract: acquired.contract,
    required: structuredClone(acquired.required),
    version: acquired.version,
    os: acquired.os,
    architecture: acquired.architecture,
    binary: structuredClone(acquired.binary),
    tree: structuredClone(acquired.tree),
    acquisition: structuredClone(acquired.acquisition),
  };
}

function provisionReceipt(provision, acquired) {
  const executable = `${CONTAINER_GO_ROOT}/bin/go`;
  return {
    contract: provision.contract,
    source: provision.source,
    command: {
      ...provision.command,
      executable,
    },
    offlineProof: {
      ...provision.offlineProof,
      executable,
    },
    telemetry: {
      ...provision.telemetry,
      executable,
    },
    toolchain: {
      version: provision.toolchain.version,
      root: CONTAINER_GO_ROOT,
      acquired: acquisitionReceipt(acquired),
    },
    proxyPolicy: provision.proxyPolicy,
    cache: compactTreeProof(provision.proof),
  };
}

async function executableMounts() {
  const sources = {
    make: "/usr/bin/make",
    gcc: "/usr/bin/gcc",
    ar: "/usr/bin/ar",
    as: "/usr/bin/as",
    ld: "/usr/bin/ld",
    ffmpeg: "/usr/bin/ffmpeg",
    ffprobe: "/usr/bin/ffprobe",
    "pkg-config": "/usr/bin/pkg-config",
  };
  return Promise.all(
    Object.entries(sources).map(([name, source]) =>
      toolMount(
        source,
        name === "gcc" ? "/usr/bin/x86_64-linux-gnu-gcc-13" : `/kandev/toolchain/bin/${name}`,
      ),
    ),
  );
}

async function buildMounts({ pnpm, acquired, snapshotRoot }) {
  const fixed = [
    [pnpm.root, "/kandev/toolchain/pnpm"],
    [pnpm.store, "/kandev/toolchain/pnpm-store/v3"],
    [acquired.root, CONTAINER_GO_ROOT],
    [snapshotRoot, CONTAINER_GO_MOD_ROOT],
    ["/usr/lib/gcc", "/usr/lib/gcc"],
    ["/usr/libexec/gcc", "/usr/libexec/gcc"],
    ["/usr/include", "/usr/include"],
    ["/usr/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu"],
  ];
  return Promise.all([
    ...fixed.map(([source, target]) => toolMount(source, target)),
    ...(await executableMounts()),
  ]);
}

async function acquireGo(input, backendRoot) {
  const bootstrapExecutable = await fs.realpath(input.bootstrapExecutable ?? "/usr/bin/go");
  return acquirePrivateGoToolchain({
    backendRoot,
    privateRoot: input.privateRoot,
    bootstrapRoot: input.bootstrapRoot,
    bootstrapExecutable,
    runCommand: input.runCommand,
  });
}

function validateDiscoveryInput(input) {
  for (const [label, value] of [
    ["snapshot", input.snapshotRoot],
    ["bootstrap", input.bootstrapRoot],
  ]) {
    if (!path.isAbsolute(value ?? "")) {
      throw new Error(`Docker toolchain requires an absolute private ${label} root`);
    }
  }
}

export async function discoverDockerToolchain(input = {}) {
  validateDiscoveryInput(input);
  const context = {
    ...input,
    inheritedEnv: input.inheritedEnv ?? process.env,
    runCommand: input.runCommand ?? runBoundedSubprocess,
  };
  const appsRoot = path.join(context.sourceRoot, "apps");
  const backendRoot = path.join(appsRoot, "backend");
  const acquired = await acquireGo(context, backendRoot);
  const pnpm = await discoverPnpm(context, appsRoot);
  const provision = await provisionPrivateGoModuleCache({
    sourceRoot: context.sourceRoot,
    backendRoot,
    privateRoot: context.privateRoot,
    targetRoot: context.snapshotRoot,
    sourceSha: context.sourceProof?.headSha,
    sourceProof: context.sourceProof,
    goVersion: acquired.version,
    goRoot: acquired.root,
    goExecutable: acquired.executable,
    runCommand: context.runCommand,
  });
  const proof = await captureTreeProof(context.snapshotRoot);
  return {
    mounts: await buildMounts({
      pnpm,
      acquired,
      snapshotRoot: context.snapshotRoot,
    }),
    goModuleCache: {
      sourceRoot: CONTAINER_GO_MOD_ROOT,
      targetRoot: "/kandev/eval/go-mod-cache",
      input: compactTreeProof(proof),
      provision: provisionReceipt(provision, acquired),
    },
    environment: {
      GOROOT: CONTAINER_GO_ROOT,
      npm_config_store_dir: "/kandev/toolchain/pnpm-store/v3",
    },
    cleanupRoot: acquired.cleanupRoot,
  };
}
