const MODES = Object.freeze(["native", "disabled"]);
const STATUSES = Object.freeze(["available", "unavailable", "unknown"]);
const MAX_REASON_LENGTH = 512;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key))
      throw new Error(`${label} ${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key))
      throw new Error(`${label} ${key} is not allowed`);
  }
  return value;
}

export function defaultChromiumSandboxPolicy() {
  return {
    mode: "native",
    proof: {
      status: "unknown",
      reason: "native Chromium sandbox is required by default",
    },
  };
}

export function validateChromiumSandboxPolicy(value) {
  const policy = exactKeys(value, ["mode", "proof"], "chromiumSandbox");
  if (!MODES.includes(policy.mode)) {
    throw new Error("chromiumSandbox mode must be native or disabled");
  }
  const proof = exactKeys(
    policy.proof,
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
    /[\0\r\n]/.test(proof.reason)
  ) {
    throw new Error(
      `chromiumSandbox proof reason must be 1-${MAX_REASON_LENGTH} printable characters on one line`,
    );
  }
  if (policy.mode === "disabled" && proof.status !== "unavailable") {
    throw new Error(
      "disabled chromiumSandbox requires proof status unavailable",
    );
  }
  if (policy.mode === "native" && proof.status === "unavailable") {
    throw new Error("native chromiumSandbox cannot carry unavailable proof");
  }
  return {
    mode: policy.mode,
    proof: { status: proof.status, reason: proof.reason },
  };
}
