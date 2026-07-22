import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  evaluatePrGate,
  validateHighlights,
} from "./highlights.mjs";

const execFileAsync = promisify(execFile);

/**
 * Evaluate the GitHub pull-request event and, when opted in, run the full
 * Highlight contract. The workflow is read-only: a synchronize event with an
 * approval label fails until the maintainer relabels the current head.
 */
export async function runPrGate({
  event,
  repoRoot = process.cwd(),
  changedFiles,
  validate = validateHighlights,
} = {}) {
  if (!event) {
    event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  }
  changedFiles ??= await changedFilesForEvent(event);
  const pullRequest = event.pull_request ?? {};
  const labels = (pullRequest.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  ).filter(Boolean);
  const headSha = pullRequest.head?.sha ?? process.env.GITHUB_SHA;
  const approvalHeadSha = process.env.HIGHLIGHT_APPROVAL_HEAD_SHA ||
    (event.action === "labeled" && event.label?.name === "highlight:approved" ? headSha : undefined);
  let validation;
  const validationReasons = [];
  if (labels.includes("highlight:required")) {
    try {
      validation = await validate({ repoRoot });
    } catch (error) {
      validationReasons.push(error.message);
    }
  }
  const verdict = evaluatePrGate({
    labels,
    changedFiles,
    headSha,
    prBody: pullRequest.body ?? "",
    // An approval label surviving synchronize is stale by definition. This is
    // an explicit invalidation path without granting the workflow write access.
    approvedHeadSha: event.action === "synchronize" && labels.includes("highlight:approved")
      ? "stale-pr-head"
      : approvalHeadSha,
    highlightIds: validation?.ids,
  });

  if (verdict.exempt) {
    console.log("Highlights gate exempt: PR has no Highlight label or asset change.");
    return verdict;
  }
  const reasons = [...verdict.reasons, ...validationReasons];
  if (reasons.length > 0) {
    throw new Error(`Highlights gate failed:\n- ${reasons.join("\n- ")}`);
  }

  console.log(`Highlights gate passed: ${validation.count} descriptors validated.`);
  return { ...verdict, validation };
}

async function changedFilesForEvent(event) {
  if (process.env.HIGHLIGHT_CHANGED_FILES) {
    return process.env.HIGHLIGHT_CHANGED_FILES.split("\n").filter(Boolean);
  }
  const base = event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha ?? process.env.GITHUB_SHA;
  if (!base || !head) return [];
  const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${base}...${head}`]);
  return stdout.split("\n").map((file) => file.trim()).filter(Boolean);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runPrGate().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
