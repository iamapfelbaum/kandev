import { canonicalJson } from "./pipeline-eval-shared.mjs";

export const GO_MODULE_PROVISION_CONTRACT = "kandev-highlight-go-module-provision-v1";
export const GO_DOWNLOAD_ARGS = Object.freeze(["mod", "download", "all"]);
export const GO_PROXY_POLICY = Object.freeze({
  GOPROXY: "https://proxy.golang.org",
  GOSUMDB: "sum.golang.org",
  GOPRIVATE: "",
  GONOPROXY: "",
  GONOSUMDB: "",
  GOWORK: "off",
  GOENV: "off",
  GOFLAGS: "-mod=readonly",
  GOTOOLCHAIN: "local",
});
export const GO_ACQUISITION_PROXY_POLICY = Object.freeze({
  GOPROXY: GO_PROXY_POLICY.GOPROXY,
  GOSUMDB: GO_PROXY_POLICY.GOSUMDB,
  GOPRIVATE: "",
  GONOPROXY: "",
  GONOSUMDB: "",
  GOENV: "off",
  GOWORK: "off",
});
export const CONTAINER_GO_ROOT = "/kandev/toolchain/go";

export function compactTreeProof(proof) {
  return {
    contract: proof.contract,
    digest: proof.digest,
    fileCount: proof.fileCount,
    directoryCount: proof.directoryCount,
    bytes: proof.bytes,
    symlinkCount: proof.symlinkCount,
  };
}

function sourceFileProof(value, expectedPath, label) {
  const invalid = [
    value?.path !== expectedPath,
    !Number.isInteger(value?.bytes),
    value?.bytes < 1,
    !/^sha256:[a-f0-9]{64}$/.test(value?.digest ?? ""),
  ];
  if (invalid.some(Boolean)) {
    throw new Error(`${label} must bind exact path, bytes, and digest`);
  }
  return {
    path: expectedPath,
    bytes: value.bytes,
    digest: value.digest,
  };
}

function treeProof(value, label) {
  const normalized = compactTreeProof(value ?? {});
  const invalid = [
    normalized.contract !== "kandev-highlight-readonly-tree-v1",
    !/^sha256:[a-f0-9]{64}$/.test(normalized.digest ?? ""),
    !Number.isInteger(normalized.fileCount),
    normalized.fileCount < 1,
    !Number.isInteger(normalized.directoryCount),
    normalized.directoryCount < 0,
    !Number.isInteger(normalized.bytes),
    normalized.bytes < 1,
    normalized.symlinkCount !== 0,
    canonicalJson(value) !== canonicalJson(normalized),
  ];
  if (invalid.some(Boolean)) {
    throw new Error(`${label} must be an exact non-symlink tree proof`);
  }
  return normalized;
}

function binaryProof(value) {
  if (
    !Number.isInteger(value?.bytes) ||
    value.bytes < 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(value?.digest ?? "") ||
    canonicalJson(value) !== canonicalJson({ bytes: value.bytes, digest: value.digest })
  ) {
    throw new Error("acquired Go binary must bind exact bytes and digest");
  }
  return { bytes: value.bytes, digest: value.digest };
}

function requiredVersion(value) {
  const go = value?.go;
  const toolchain = value?.toolchain;
  if (
    !/^\d+\.\d+\.\d+$/.test(go ?? "") ||
    !(toolchain === null || /^go\d+\.\d+\.\d+$/.test(toolchain ?? "")) ||
    canonicalJson(value) !== canonicalJson({ go, toolchain })
  ) {
    throw new Error("acquired Go requirement must bind exact go and optional toolchain directives");
  }
  return { go, toolchain };
}

function acquisitionProof(value, selected) {
  const expectedCommand = {
    executable: "bootstrap-go",
    args: ["env", "GOROOT"],
  };
  const expectedOffline = {
    proxy: "off",
    status: "passed",
    treeUnchanged: true,
  };
  const invalid = [
    canonicalJson(value?.command) !== canonicalJson(expectedCommand),
    value?.selected !== selected,
    canonicalJson(value?.proxyPolicy) !== canonicalJson(GO_ACQUISITION_PROXY_POLICY),
    canonicalJson(value?.offlineProof) !== canonicalJson(expectedOffline),
  ];
  if (invalid.some(Boolean)) {
    throw new Error(
      "Go acquisition must bind fixed argv, proxy policy, selection, and offline proof",
    );
  }
  return {
    command: expectedCommand,
    selected,
    proxyPolicy: { ...GO_ACQUISITION_PROXY_POLICY },
    offlineProof: expectedOffline,
    cache: treeProof(value.cache, "Go acquisition cache"),
  };
}

function acquiredToolchain(value) {
  const required = requiredVersion(value?.required);
  const selected = required.toolchain ?? `go${required.go}`;
  const os = value?.os;
  const architecture = value?.architecture;
  const version = value?.version;
  if (
    value?.contract !== "kandev-highlight-private-go-toolchain-v1" ||
    !/^[a-z0-9]+$/.test(os ?? "") ||
    !/^[a-z0-9]+$/.test(architecture ?? "") ||
    version !== `go version ${selected} ${os}/${architecture}`
  ) {
    throw new Error(
      "acquired Go toolchain must bind its exact directive, version, OS, and architecture",
    );
  }
  const normalized = {
    contract: value.contract,
    required,
    version,
    os,
    architecture,
    binary: binaryProof(value.binary),
    tree: treeProof(value.tree, "acquired Go tree"),
    acquisition: acquisitionProof(value.acquisition, selected),
  };
  if (canonicalJson(value) !== canonicalJson(normalized)) {
    throw new Error("acquired Go toolchain contains unrecognized or missing evidence");
  }
  return normalized;
}

function telemetryProof(value, executable) {
  const normalized = {
    executable,
    args: ["telemetry", "off"],
    status: "passed",
    runtimeSeparated: true,
  };
  if (canonicalJson(value) !== canonicalJson(normalized)) {
    throw new Error(
      "Go module provision must disable telemetry in separated private runtime state",
    );
  }
  return normalized;
}

function validateFixedProvision(value, input, source, acquired) {
  const executable = `${CONTAINER_GO_ROOT}/bin/go`;
  const expectedCommand = {
    executable,
    args: [...GO_DOWNLOAD_ARGS],
    cwd: "apps/backend",
  };
  const expectedOffline = {
    executable,
    args: [...GO_DOWNLOAD_ARGS],
    proxy: "off",
    status: "passed",
    cacheUnchanged: true,
  };
  const invalid = [
    value?.contract !== GO_MODULE_PROVISION_CONTRACT,
    canonicalJson(value?.source?.repository) !== canonicalJson(source),
    canonicalJson(value?.command) !== canonicalJson(expectedCommand),
    canonicalJson(value?.offlineProof) !== canonicalJson(expectedOffline),
    value?.toolchain?.version !== acquired.version,
    value?.toolchain?.root !== CONTAINER_GO_ROOT,
    canonicalJson(value?.proxyPolicy) !== canonicalJson(GO_PROXY_POLICY),
    canonicalJson(value?.cache) !== canonicalJson(input),
  ];
  if (invalid.some(Boolean)) {
    throw new Error(
      "Go module provision must bind source, command, toolchain, proxy policy, offline proof, and cache digest",
    );
  }
  return { executable, expectedCommand, expectedOffline };
}

export function validateGoModuleProvision({ value, input, source } = {}) {
  const acquired = acquiredToolchain(value?.toolchain?.acquired);
  const fixed = validateFixedProvision(value, input, source, acquired);
  const toolchain = {
    version: acquired.version,
    root: CONTAINER_GO_ROOT,
    acquired,
  };
  if (canonicalJson(value.toolchain) !== canonicalJson(toolchain)) {
    throw new Error("Go module provision toolchain evidence must be exact");
  }
  return {
    contract: GO_MODULE_PROVISION_CONTRACT,
    source: {
      repository: structuredClone(source),
      goMod: sourceFileProof(
        value.source.goMod,
        "apps/backend/go.mod",
        "Go module provision go.mod",
      ),
      goSum: sourceFileProof(
        value.source.goSum,
        "apps/backend/go.sum",
        "Go module provision go.sum",
      ),
    },
    command: fixed.expectedCommand,
    offlineProof: fixed.expectedOffline,
    telemetry: telemetryProof(value.telemetry, fixed.executable),
    toolchain,
    proxyPolicy: { ...GO_PROXY_POLICY },
    cache: structuredClone(input),
  };
}
