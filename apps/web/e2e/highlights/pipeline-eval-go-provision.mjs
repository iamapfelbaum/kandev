import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { canonicalJson, captureDockerRepositoryProof } from "./pipeline-eval-docker-boundary.mjs";
import { captureTreeProof, removePrivateTree } from "./pipeline-eval-docker-cache.mjs";
import {
  GO_DOWNLOAD_ARGS,
  GO_MODULE_PROVISION_CONTRACT,
  GO_PROXY_POLICY,
} from "./pipeline-eval-go-provision-contract.mjs";
import { runBoundedSubprocess } from "./pipeline-eval-shared.mjs";

const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const DOWNLOAD_DEADLINE_MS = 10 * 60_000;

async function canonicalPath(filePath, label) {
  const resolved = path.resolve(filePath);
  const canonical = await fs.realpath(resolved).catch((error) => {
    throw new Error(`${label} is unavailable: ${error.message}`, {
      cause: error,
    });
  });
  const value = await fs.lstat(canonical);
  if (
    canonical !== resolved ||
    (!value.isFile() && !value.isDirectory()) ||
    value.isSymbolicLink()
  ) {
    throw new Error(`${label} must be a canonical file or directory`);
  }
  return { path: canonical, stat: value };
}

async function sourceFileProof(backendRoot, name) {
  const file = await canonicalPath(path.join(backendRoot, name), `Go module ${name}`);
  if (!file.stat.isFile()) {
    throw new Error(`Go module ${name} must be a file`);
  }
  const bytes = await fs.readFile(file.path);
  return {
    path: `apps/backend/${name}`,
    bytes: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function sameFileProof(left, right) {
  return left.path === right.path && left.bytes === right.bytes && left.digest === right.digest;
}

function samePreparedSource(actual, expected) {
  const fields = [
    "headSha",
    "tree",
    "status",
    "identity",
    ...(expected?.originMainSha ? ["originMainSha"] : []),
  ];
  return fields.every((key) => canonicalJson(actual?.[key]) === canonicalJson(expected?.[key]));
}

async function validatePrivateOwner(privateRoot) {
  const owner = path.resolve(privateRoot);
  const [canonical, stat] = await Promise.all([fs.realpath(owner), fs.lstat(owner)]);
  const invalid = [
    canonical !== owner,
    !stat.isDirectory(),
    stat.isSymbolicLink(),
    (stat.mode & 0o077) !== 0,
    typeof process.getuid === "function" && stat.uid !== process.getuid(),
  ];
  if (invalid.some(Boolean)) {
    throw new Error("private owner must be an owned mode-0700 canonical non-symlink directory");
  }
  return owner;
}

async function ensureCanonicalParents(owner, target) {
  const relative = path.relative(owner, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("private target must stay inside its private owner");
  }
  let current = owner;
  const segments = relative.split(path.sep);
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const existing = await fs
      .lstat(current)
      .catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
    if (!existing) await fs.mkdir(current, { mode: 0o700 });
    const checked = await canonicalPath(current, "private target parent");
    if (!checked.stat.isDirectory()) {
      throw new Error("private target parent must be a directory");
    }
  }
}

export async function prepareOwnedPrivateTarget(privateRoot, targetRoot) {
  const owner = await validatePrivateOwner(privateRoot);
  const target = path.resolve(targetRoot);
  await ensureCanonicalParents(owner, target);
  if (await fs.lstat(target).catch(() => null)) {
    throw new Error("private target already exists; target must be new");
  }
  await fs.mkdir(target, { mode: 0o700 });
  return { owner, target };
}

async function validateProvisionInputs(input) {
  const source = await canonicalPath(input.sourceRoot, "prepared Go module source");
  const backend = await canonicalPath(input.backendRoot, "Go module source root");
  const goRoot = await canonicalPath(input.goRoot, "Go toolchain root");
  const goExecutable = await canonicalPath(input.goExecutable, "Go toolchain executable");
  const invalid = [
    !source.stat.isDirectory(),
    !backend.stat.isDirectory(),
    path.relative(source.path, backend.path) !== path.join("apps", "backend"),
    !goRoot.stat.isDirectory(),
    !goExecutable.stat.isFile(),
    goExecutable.path !== path.join(goRoot.path, "bin", "go"),
    !SOURCE_SHA_PATTERN.test(input.sourceSha ?? ""),
    input.sourceProof?.headSha !== input.sourceSha,
    typeof input.goVersion !== "string",
    !/^go version go\S+ \S+\/\S+$/.test(input.goVersion ?? ""),
  ];
  if (invalid.some(Boolean)) {
    throw new Error("private Go module cache source or toolchain identity is invalid");
  }
  return {
    source: source.path,
    backend: backend.path,
    goRoot: goRoot.path,
    goExecutable: goExecutable.path,
  };
}

function downloadEnvironment(context) {
  const { target, runtimeRoot, goExecutable } = context;
  return {
    ...GO_PROXY_POLICY,
    GOMODCACHE: target,
    GOCACHE: path.join(runtimeRoot, "build-cache"),
    HOME: path.join(runtimeRoot, "home"),
    XDG_CONFIG_HOME: path.join(runtimeRoot, "config"),
    TMPDIR: path.join(runtimeRoot, "tmp"),
    PATH: `${path.dirname(goExecutable)}:/usr/bin:/bin`,
  };
}

async function executeProvision(context, runCommand) {
  const environment = downloadEnvironment(context);
  await Promise.all([
    fs.mkdir(environment.GOCACHE, { recursive: true }),
    fs.mkdir(environment.HOME, { recursive: true }),
    fs.mkdir(environment.XDG_CONFIG_HOME, { recursive: true }),
    fs.mkdir(environment.TMPDIR, { recursive: true }),
  ]);
  const specification = {
    command: context.goExecutable,
    args: [...GO_DOWNLOAD_ARGS],
    cwd: context.backend,
    env: environment,
    deadlineMs: DOWNLOAD_DEADLINE_MS,
  };
  await runCommand({
    ...specification,
    args: ["telemetry", "off"],
    phase: "docker-toolchain-go-telemetry-off",
  });
  await runCommand({
    ...specification,
    phase: "docker-toolchain-go-mod-download",
  });
  const provisioned = await captureTreeProof(context.target);
  if (provisioned.fileCount < 1 || provisioned.bytes < 1) {
    throw new Error("private Go module cache provisioning produced no content");
  }
  await runCommand({
    ...specification,
    env: { ...environment, GOPROXY: "off" },
    phase: "docker-toolchain-go-mod-offline-proof",
  });
  return provisioned;
}

async function cleanupProvision(context, primaryError) {
  const cleanupErrors = [];
  for (const targetRoot of [context.runtimeRoot, context.target]) {
    if (!targetRoot) continue;
    try {
      await removePrivateTree({
        targetRoot,
        privateRoot: context.owner,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "Go module cache provisioning failed and exact private cleanup failed",
    );
  }
  throw primaryError;
}

export async function provisionPrivateGoModuleCache(input = {}) {
  const verified = await validateProvisionInputs(input);
  const captureSourceProof = input.captureSourceProof ?? captureDockerRepositoryProof;
  const runCommand = input.runCommand ?? runBoundedSubprocess;
  const repositoryBefore = await captureSourceProof(verified.source, {
    includeOrigin: Boolean(input.sourceProof.originMainSha),
  });
  if (!samePreparedSource(repositoryBefore, input.sourceProof)) {
    throw new Error("private Go module cache prepared source proof changed before provisioning");
  }
  const source = {
    repository: structuredClone(repositoryBefore),
    goMod: await sourceFileProof(verified.backend, "go.mod"),
    goSum: await sourceFileProof(verified.backend, "go.sum"),
  };
  const context = {
    ...verified,
    ...(await prepareOwnedPrivateTarget(input.privateRoot, input.targetRoot)),
  };
  let provisioned;
  try {
    context.runtimeRoot = (
      await prepareOwnedPrivateTarget(input.privateRoot, `${context.target}.runtime`)
    ).target;
    provisioned = await executeProvision(context, runCommand);
    const [proof, repositoryAfter, goModAfter, goSumAfter] = await Promise.all([
      captureTreeProof(context.target),
      captureSourceProof(verified.source, {
        includeOrigin: Boolean(input.sourceProof.originMainSha),
      }),
      sourceFileProof(verified.backend, "go.mod"),
      sourceFileProof(verified.backend, "go.sum"),
    ]);
    const changed = [
      proof.digest !== provisioned.digest,
      !samePreparedSource(repositoryAfter, repositoryBefore),
      !sameFileProof(goModAfter, source.goMod),
      !sameFileProof(goSumAfter, source.goSum),
    ];
    if (changed.some(Boolean)) {
      throw new Error(
        "private Go module cache prepared source proof changed or cache changed during offline proof",
      );
    }
    await removePrivateTree({
      targetRoot: context.runtimeRoot,
      privateRoot: context.owner,
    });
    return {
      contract: GO_MODULE_PROVISION_CONTRACT,
      targetRoot: context.target,
      source,
      command: {
        executable: context.goExecutable,
        args: [...GO_DOWNLOAD_ARGS],
        cwd: "apps/backend",
      },
      offlineProof: {
        executable: context.goExecutable,
        args: [...GO_DOWNLOAD_ARGS],
        proxy: "off",
        status: "passed",
        cacheUnchanged: true,
      },
      telemetry: {
        executable: context.goExecutable,
        args: ["telemetry", "off"],
        status: "passed",
        runtimeSeparated: true,
      },
      toolchain: {
        version: input.goVersion,
        root: context.goRoot,
      },
      proxyPolicy: { ...GO_PROXY_POLICY },
      proof,
    };
  } catch (error) {
    return cleanupProvision(context, error);
  }
}
