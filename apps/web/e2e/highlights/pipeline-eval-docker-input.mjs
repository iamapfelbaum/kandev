import fs from "node:fs/promises";
import path from "node:path";

import { captureDockerRepositoryProof } from "./pipeline-eval-docker-boundary.mjs";
import { snapshotCommittedRepository } from "./pipeline-eval-repository.mjs";
import { canonicalDirectory, isInside } from "./pipeline-eval-shared.mjs";

function sameRepositoryContent(actual, expected, label) {
  const fields = [
    "headSha",
    "tree",
    "status",
    ...(expected.originMainSha ? ["originMainSha"] : []),
  ];
  for (const key of fields) {
    if (actual?.[key] !== expected[key]) {
      throw new Error(`Docker input ${label} ${key} does not match its upstream repository`);
    }
  }
}

async function requireSelfContainedGitDirectory(repository, label) {
  const gitDirectory = path.join(repository, ".git");
  const value = await fs.lstat(gitDirectory).catch(() => null);
  if (!value?.isDirectory() || value.isSymbolicLink()) {
    throw new Error(`Docker input ${label} must have self-contained sanitized Git metadata`);
  }
}

export async function prepareDockerInputRepositories({ sourceRoot, landingRoot, inputRoot } = {}) {
  const source = await canonicalDirectory(path.resolve(sourceRoot), "Docker input source");
  const landing = await canonicalDirectory(path.resolve(landingRoot), "Docker input landing");
  const root = path.resolve(inputRoot);
  if (isInside(source, root) || isInside(landing, root)) {
    throw new Error("Docker input snapshots must stay outside source and landing repositories");
  }
  await fs.mkdir(root, { recursive: false, mode: 0o700 });
  const [upstreamSourceProof, upstreamLandingProof] = await Promise.all([
    captureDockerRepositoryProof(source, { includeOrigin: true }),
    captureDockerRepositoryProof(landing),
  ]);
  const [sourceSnapshot, landingSnapshot] = await Promise.all([
    snapshotCommittedRepository({
      sourceRoot: source,
      cloneRoot: path.join(root, "source"),
      originRoot: path.join(root, "source-origin.git"),
    }),
    snapshotCommittedRepository({
      sourceRoot: landing,
      cloneRoot: path.join(root, "landing"),
      originRoot: path.join(root, "landing-origin.git"),
    }),
  ]);
  const [sourceProof, landingProof] = await Promise.all([
    captureDockerRepositoryProof(sourceSnapshot.cloneRoot, { includeOrigin: true }),
    captureDockerRepositoryProof(landingSnapshot.cloneRoot),
  ]);
  sameRepositoryContent(sourceProof, upstreamSourceProof, "source");
  sameRepositoryContent(landingProof, upstreamLandingProof, "landing");
  await Promise.all([
    requireSelfContainedGitDirectory(sourceSnapshot.cloneRoot, "source"),
    requireSelfContainedGitDirectory(landingSnapshot.cloneRoot, "landing"),
  ]);
  return {
    inputRoot: root,
    sourceRoot: sourceSnapshot.cloneRoot,
    landingRoot: landingSnapshot.cloneRoot,
    sourceProof,
    landingProof,
    upstreamSourceRoot: source,
    upstreamLandingRoot: landing,
    upstreamSourceProof,
    upstreamLandingProof,
  };
}
