import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { captureTreeProof, removePrivateTree } from "./pipeline-eval-docker-cache.mjs";
import { prepareOwnedPrivateTarget } from "./pipeline-eval-go-provision.mjs";
import { GO_PROXY_POLICY, compactTreeProof } from "./pipeline-eval-go-provision-contract.mjs";
import { isInside, runBoundedSubprocess } from "./pipeline-eval-shared.mjs";

const ACQUISITION_DEADLINE_MS = 10 * 60_000;
const GO_VERSION_PATTERN = /^go version go(\d+\.\d+\.\d+) ([a-z0-9]+)\/([a-z0-9]+)$/;
const DIRECTIVE_PATTERN = /^\d+\.\d+\.\d+$/;

async function canonicalRegularPath(filePath, label, type) {
  const resolved = path.resolve(filePath);
  const canonical = await fs.realpath(resolved).catch((error) => {
    throw new Error(`${label} is unavailable: ${error.message}`, {
      cause: error,
    });
  });
  const stat = await fs.lstat(canonical);
  if (
    canonical !== resolved ||
    stat.isSymbolicLink() ||
    (type === "file" ? !stat.isFile() : !stat.isDirectory())
  ) {
    throw new Error(`${label} must be a canonical ${type}`);
  }
  return canonical;
}

function oneDirective(lines, name, pattern, required) {
  const values = lines
    .map((line) => line.trim().split(/\s+/u))
    .filter(([directive]) => directive === name);
  if (values.length !== (required ? 1 : Math.min(values.length, 1))) {
    throw new Error(`go.mod must contain ${required ? "one" : "at most one"} ${name} directive`);
  }
  if (values.length === 0) return null;
  const [, value, ...extra] = values[0];
  if (extra.length > 0 || !pattern.test(value ?? "")) {
    throw new Error(`go.mod ${name} directive must use an exact patch version`);
  }
  return value;
}

async function checkedInRequirement(backendRoot) {
  const goMod = path.join(backendRoot, "go.mod");
  const text = await fs.readFile(goMod, "utf8");
  const lines = text.split(/\r?\n/u);
  const go = oneDirective(lines, "go", DIRECTIVE_PATTERN, true);
  const toolchain = oneDirective(lines, "toolchain", /^go\d+\.\d+\.\d+$/u, false);
  return {
    go,
    toolchain,
    selected: toolchain ?? `go${go}`,
  };
}

function acquisitionEnvironment(context, proxy) {
  const runtimeRoot = path.join(context.bootstrapRoot, "runtime");
  return {
    ...GO_PROXY_POLICY,
    GOPROXY: proxy,
    GOTOOLCHAIN: context.required.selected,
    GOMODCACHE: path.join(context.bootstrapRoot, "mod"),
    GOCACHE: path.join(runtimeRoot, "build"),
    HOME: path.join(runtimeRoot, "home"),
    XDG_CONFIG_HOME: path.join(runtimeRoot, "config"),
    TMPDIR: path.join(runtimeRoot, "tmp"),
    PATH: `${path.dirname(context.bootstrapExecutable)}:/usr/bin:/bin`,
  };
}

async function prepareRuntimeDirectories(environment) {
  await Promise.all(
    [
      environment.GOMODCACHE,
      environment.GOCACHE,
      environment.HOME,
      environment.XDG_CONFIG_HOME,
      environment.TMPDIR,
    ].map((directory) => fs.mkdir(directory, { recursive: true, mode: 0o700 })),
  );
}

async function runBootstrap(context, proxy, phase) {
  const environment = acquisitionEnvironment(context, proxy);
  await prepareRuntimeDirectories(environment);
  const result = await context.runCommand({
    command: context.bootstrapExecutable,
    args: ["env", "GOROOT"],
    cwd: context.backendRoot,
    env: environment,
    phase,
    deadlineMs: ACQUISITION_DEADLINE_MS,
  });
  const goRoot = result.stdout.trim();
  if (!path.isAbsolute(goRoot) || !isInside(environment.GOMODCACHE, goRoot)) {
    throw new Error("acquired Go root must be inside the private bootstrap module cache");
  }
  return {
    goRoot: await canonicalRegularPath(goRoot, "acquired Go root", "directory"),
    environment,
  };
}

async function binaryProof(executable) {
  const bytes = await fs.readFile(executable);
  return {
    bytes: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

async function verifyAcquiredToolchain(context, goRoot) {
  const executable = await canonicalRegularPath(
    path.join(goRoot, "bin", "go"),
    "acquired Go executable",
    "file",
  );
  const result = await context.runCommand({
    command: executable,
    args: ["version"],
    cwd: context.backendRoot,
    env: {
      GOENV: "off",
      GOTOOLCHAIN: "local",
      GOWORK: "off",
      HOME: path.join(context.bootstrapRoot, "runtime", "home"),
      XDG_CONFIG_HOME: path.join(context.bootstrapRoot, "runtime", "config"),
      TMPDIR: path.join(context.bootstrapRoot, "runtime", "tmp"),
      PATH: `${path.dirname(executable)}:/usr/bin:/bin`,
    },
    phase: "docker-toolchain-acquired-go-version",
    deadlineMs: 30_000,
  });
  const version = result.stdout.trim();
  const match = GO_VERSION_PATTERN.exec(version);
  if (!match || `go${match[1]}` !== context.required.selected) {
    throw new Error(
      `checked-in Go requirement ${context.required.selected} does not match acquired version ${version || "missing"}`,
    );
  }
  return {
    root: goRoot,
    executable,
    version,
    os: match[2],
    architecture: match[3],
    binary: await binaryProof(executable),
  };
}

async function cleanupFailure(context, primaryError) {
  try {
    await removePrivateTree({
      targetRoot: context.bootstrapRoot,
      privateRoot: context.privateRoot,
    });
  } catch (cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Go toolchain acquisition failed and exact private cleanup failed",
    );
  }
  throw primaryError;
}

export async function acquirePrivateGoToolchain(input = {}) {
  const backendRoot = await canonicalRegularPath(input.backendRoot, "Go backend root", "directory");
  const bootstrapExecutable = await canonicalRegularPath(
    input.bootstrapExecutable,
    "bootstrap Go executable",
    "file",
  );
  const required = await checkedInRequirement(backendRoot);
  const prepared = await prepareOwnedPrivateTarget(input.privateRoot, input.bootstrapRoot);
  const context = {
    backendRoot,
    bootstrapExecutable,
    bootstrapRoot: prepared.target,
    privateRoot: prepared.owner,
    required,
    runCommand: input.runCommand ?? runBoundedSubprocess,
  };
  try {
    const online = await runBootstrap(
      context,
      GO_PROXY_POLICY.GOPROXY,
      "docker-toolchain-acquire-go",
    );
    const treeBefore = await captureTreeProof(online.goRoot);
    const offline = await runBootstrap(context, "off", "docker-toolchain-acquire-go-offline-proof");
    const treeAfter = await captureTreeProof(offline.goRoot);
    if (offline.goRoot !== online.goRoot || treeAfter.digest !== treeBefore.digest) {
      throw new Error("private Go toolchain changed during offline proof");
    }
    const verified = await verifyAcquiredToolchain(context, online.goRoot);
    const bootstrapProof = await captureTreeProof(context.bootstrapRoot);
    return {
      contract: "kandev-highlight-private-go-toolchain-v1",
      required: {
        go: required.go,
        toolchain: required.toolchain,
      },
      root: verified.root,
      executable: verified.executable,
      version: verified.version,
      os: verified.os,
      architecture: verified.architecture,
      binary: verified.binary,
      tree: compactTreeProof(treeAfter),
      acquisition: {
        command: {
          executable: "bootstrap-go",
          args: ["env", "GOROOT"],
        },
        selected: required.selected,
        proxyPolicy: {
          GOPROXY: GO_PROXY_POLICY.GOPROXY,
          GOSUMDB: GO_PROXY_POLICY.GOSUMDB,
          GOPRIVATE: "",
          GONOPROXY: "",
          GONOSUMDB: "",
          GOENV: "off",
          GOWORK: "off",
        },
        offlineProof: {
          proxy: "off",
          status: "passed",
          treeUnchanged: true,
        },
        cache: compactTreeProof(bootstrapProof),
      },
      offlineProof: {
        proxy: "off",
        status: "passed",
        treeUnchanged: true,
      },
      cleanupRoot: context.bootstrapRoot,
    };
  } catch (error) {
    return cleanupFailure(context, error);
  }
}
