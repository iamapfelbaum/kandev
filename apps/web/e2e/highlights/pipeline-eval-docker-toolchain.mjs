import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { capturePathIdentity } from "./pipeline-eval-docker-boundary.mjs";
import { captureTreeProof, snapshotReadOnlyTree } from "./pipeline-eval-docker-cache.mjs";
import { runBoundedSubprocess } from "./pipeline-eval-shared.mjs";

const CONTAINER_GO_ROOT = "/kandev/toolchain/go";
const PNPM_VERSION_PATTERN = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

async function existingCanonicalPath(filePath, label) {
  const resolved = path.resolve(filePath);
  const canonical = await fs.realpath(resolved).catch((error) => {
    throw new Error(`${label} is unavailable: ${error.message}`, { cause: error });
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
  if (!output) throw new Error(`${specification.phase} returned empty output`);
  return output;
}

export async function discoverDockerToolchain({
  sourceRoot,
  snapshotRoot,
  inheritedEnv = process.env,
  runCommand = runBoundedSubprocess,
} = {}) {
  if (!path.isAbsolute(snapshotRoot ?? "")) {
    throw new Error("Docker toolchain requires an absolute private snapshot root");
  }
  const appsRoot = path.join(sourceRoot, "apps");
  const packageJson = JSON.parse(await fs.readFile(path.join(appsRoot, "package.json"), "utf8"));
  const pnpmVersion = PNPM_VERSION_PATTERN.exec(packageJson.packageManager ?? "")?.[1];
  if (!pnpmVersion) {
    throw new Error("Docker toolchain requires an exact checked-in pnpm packageManager version");
  }
  const goValues = (
    await commandOutput(runCommand, {
      command: "go",
      args: ["env", "GOROOT", "GOMODCACHE"],
      cwd: path.join(sourceRoot, "apps", "backend"),
      env: { ...inheritedEnv, GOTOOLCHAIN: "auto" },
      phase: "docker-toolchain-go",
      deadlineMs: 30_000,
    })
  ).split("\n");
  if (goValues.length !== 2 || !goValues.every(path.isAbsolute)) {
    throw new Error("Docker toolchain Go roots are invalid");
  }
  const [goRoot, goModCache] = goValues;
  const goSource = await fs.realpath(path.join(goRoot, "src"));
  if (path.dirname(goSource) !== goRoot) {
    throw new Error("Docker toolchain Go root must be self-contained");
  }
  const pnpmStore = await commandOutput(runCommand, {
    command: "corepack",
    args: ["pnpm", "store", "path"],
    cwd: appsRoot,
    env: { ...inheritedEnv, COREPACK_ENABLE_NETWORK: "0" },
    phase: "docker-toolchain-pnpm-store",
    deadlineMs: 30_000,
  });
  const corepackHome =
    inheritedEnv.COREPACK_HOME ?? path.join(os.homedir(), ".cache", "node", "corepack");
  const pnpmRoot = path.join(corepackHome, "v1", "pnpm", pnpmVersion);
  const executableSources = {
    make: "/usr/bin/make",
    gcc: "/usr/bin/gcc",
    ar: "/usr/bin/ar",
    as: "/usr/bin/as",
    ld: "/usr/bin/ld",
    ffmpeg: "/usr/bin/ffmpeg",
    ffprobe: "/usr/bin/ffprobe",
    "pkg-config": "/usr/bin/pkg-config",
  };
  const goModuleCacheSnapshot = await snapshotReadOnlyTree({
    sourceRoot: goModCache,
    targetRoot: snapshotRoot,
  });
  const goModuleCacheProof = await captureTreeProof(snapshotRoot);
  const mounts = await Promise.all([
    toolMount(pnpmRoot, "/kandev/toolchain/pnpm"),
    toolMount(pnpmStore, "/kandev/toolchain/pnpm-store/v3"),
    toolMount(goRoot, CONTAINER_GO_ROOT),
    toolMount(snapshotRoot, "/kandev/toolchain/go-mod"),
    toolMount("/usr/lib/gcc", "/usr/lib/gcc"),
    toolMount("/usr/libexec/gcc", "/usr/libexec/gcc"),
    toolMount("/usr/include", "/usr/include"),
    toolMount("/usr/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu"),
    ...Object.entries(executableSources).map(([name, source]) =>
      toolMount(
        source,
        name === "gcc" ? "/usr/bin/x86_64-linux-gnu-gcc-13" : `/kandev/toolchain/bin/${name}`,
      ),
    ),
  ]);
  return {
    mounts,
    goModuleCache: {
      sourceRoot: "/kandev/toolchain/go-mod",
      targetRoot: "/kandev/eval/go-mod-cache",
      input: {
        contract: goModuleCacheProof.contract,
        digest: goModuleCacheProof.digest,
        fileCount: goModuleCacheProof.fileCount,
        directoryCount: goModuleCacheProof.directoryCount,
        bytes: goModuleCacheProof.bytes,
        symlinkCount: goModuleCacheProof.symlinkCount,
      },
      hostSnapshot: goModuleCacheSnapshot,
    },
    environment: {
      GOROOT: CONTAINER_GO_ROOT,
      npm_config_store_dir: "/kandev/toolchain/pnpm-store/v3",
    },
  };
}
