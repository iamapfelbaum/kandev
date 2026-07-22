import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { capturePathIdentity } from "./pipeline-eval-docker-boundary.mjs";
import { runBoundedSubprocess } from "./pipeline-eval-shared.mjs";

const CONTAINER_GO_ROOT = "/kandev/toolchain/go";

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
  inheritedEnv = process.env,
  runCommand = runBoundedSubprocess,
} = {}) {
  const appsRoot = path.join(sourceRoot, "apps");
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
  const mounts = await Promise.all([
    toolMount(corepackHome, "/kandev/toolchain/corepack"),
    toolMount(pnpmStore, "/kandev/toolchain/pnpm-store/v3"),
    toolMount(goRoot, CONTAINER_GO_ROOT),
    toolMount(goModCache, "/kandev/toolchain/go-mod"),
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
    environment: {
      GOROOT: CONTAINER_GO_ROOT,
      npm_config_store_dir: "/kandev/toolchain/pnpm-store/v3",
    },
  };
}
