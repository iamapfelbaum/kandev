const POLICY_CONTRACT = "kandev-highlight-chromium-sandbox-policy-v1";
const AUTHORIZATION_CONTRACT =
  "kandev-highlight-disabled-sandbox-authorization-v1";
const ORIGIN_GUARD_CONTRACT = "kandev-highlight-origin-isolation-v1";
const MODES = Object.freeze(["native", "disabled"]);
const STATUSES = Object.freeze(["available", "unavailable", "unknown"]);
const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX_REASON_LENGTH = 512;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${label} ${key} is required`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) {
      throw new Error(`${label} ${key} is not allowed`);
    }
  }
  return value;
}

function validateAllowedOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute loopback HTTP origin`);
  }
  if (
    typeof value !== "string" ||
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTS.includes(parsed.hostname) ||
    parsed.port === "" ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(`${label} must be an absolute loopback HTTP origin`);
  }
  return value;
}

function validateProof(value) {
  const proof = exactKeys(
    value,
    ["status", "reason"],
    "chromiumSandbox proof",
  );
  if (!STATUSES.includes(proof.status)) {
    throw new Error(
      "chromiumSandbox proof status must be available, unavailable, or unknown",
    );
  }
  if (
    typeof proof.reason !== "string" ||
    proof.reason.length === 0 ||
    proof.reason.length > MAX_REASON_LENGTH ||
    /[\0-\x1f\x7f]/.test(proof.reason)
  ) {
    throw new Error(
      `chromiumSandbox proof reason must be 1-${MAX_REASON_LENGTH} printable characters on one line`,
    );
  }
  return { status: proof.status, reason: proof.reason };
}

function validateAuthorization(value) {
  const authorization = exactKeys(
    value,
    [
      "contract",
      "sourceMode",
      "sourceSha",
      "allowedOrigin",
      "guardContract",
    ],
    "chromiumSandbox authorization",
  );
  if (authorization.contract !== AUTHORIZATION_CONTRACT) {
    throw new Error("chromiumSandbox authorization contract is unsupported");
  }
  if (authorization.sourceMode !== "current_main") {
    throw new Error(
      "disabled chromiumSandbox authorization requires current_main source",
    );
  }
  if (!SHA_PATTERN.test(authorization.sourceSha ?? "")) {
    throw new Error(
      "chromiumSandbox authorization sourceSha must be an exact commit SHA",
    );
  }
  validateAllowedOrigin(
    authorization.allowedOrigin,
    "chromiumSandbox authorization allowedOrigin",
  );
  if (authorization.guardContract !== ORIGIN_GUARD_CONTRACT) {
    throw new Error("chromiumSandbox authorization guardContract is unsupported");
  }
  return structuredClone(authorization);
}

export function defaultChromiumSandboxPolicy() {
  return {
    contract: POLICY_CONTRACT,
    version: 1,
    mode: "native",
    proof: {
      status: "unknown",
      reason: "native Chromium sandbox is required by default",
    },
    authorization: null,
  };
}

export function createDisabledChromiumSandboxAuthorization({
  sourceProof,
  trustedSourceSha,
  allowedOrigin,
}) {
  if (sourceProof?.source === "pr_head") {
    throw new Error(
      "disabled Chromium sandbox forbids pr_head without independently attested whole-worker OS isolation",
    );
  }
  if (
    sourceProof?.source !== "current_main" ||
    !SHA_PATTERN.test(sourceProof?.selectedSha ?? "") ||
    !SHA_PATTERN.test(trustedSourceSha ?? "") ||
    sourceProof.selectedSha !== trustedSourceSha
  ) {
    throw new Error(
      "disabled Chromium sandbox requires an exact trusted current_main source SHA",
    );
  }
  return validateAuthorization({
    contract: AUTHORIZATION_CONTRACT,
    sourceMode: sourceProof.source,
    sourceSha: sourceProof.selectedSha,
    allowedOrigin,
    guardContract: ORIGIN_GUARD_CONTRACT,
  });
}

export function validateChromiumSandboxPolicy(value) {
  const policy = exactKeys(
    value,
    ["contract", "version", "mode", "proof", "authorization"],
    "chromiumSandbox",
  );
  if (policy.contract !== POLICY_CONTRACT || policy.version !== 1) {
    throw new Error("chromiumSandbox policy contract is unsupported");
  }
  if (!MODES.includes(policy.mode)) {
    throw new Error("chromiumSandbox mode must be native or disabled");
  }
  const proof = validateProof(policy.proof);
  if (policy.mode === "disabled" && proof.status !== "unavailable") {
    throw new Error(
      "disabled chromiumSandbox requires proof status unavailable",
    );
  }
  if (policy.mode === "native" && proof.status === "unavailable") {
    throw new Error("native chromiumSandbox cannot carry unavailable proof");
  }
  if (policy.mode === "native" && policy.authorization !== null) {
    throw new Error("native chromiumSandbox authorization must be null");
  }
  return {
    contract: POLICY_CONTRACT,
    version: 1,
    mode: policy.mode,
    proof,
    authorization:
      policy.mode === "disabled"
        ? validateAuthorization(policy.authorization)
        : null,
  };
}

export function validateChromiumSandboxCaptureBoundary(
  value,
  { sourceProof, allowedOrigin },
) {
  const policy = validateChromiumSandboxPolicy(value);
  if (policy.mode === "disabled") {
    if (
      policy.authorization.sourceMode !== sourceProof?.source ||
      policy.authorization.sourceSha !== sourceProof?.selectedSha ||
      policy.authorization.allowedOrigin !== allowedOrigin
    ) {
      throw new Error(
        "disabled chromiumSandbox authorization does not match the exact capture source and origin",
      );
    }
  }
  return policy;
}
