/**
 * Shared git plumbing for the i18n ratchet checks.
 *
 * Both `check-new-code-i18n.mjs` and `check-guard-allowlist.mjs` need the same
 * fork point and the same fail-closed policy about it, so it lives here rather
 * than being duplicated and drifting.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

export const WEB_DIR = path.resolve(import.meta.dirname, "..", "..");
export const REPO_ROOT = path.resolve(WEB_DIR, "..", "..");

/** The branch every PR is judged against. */
export const BASE_BRANCH = "origin/main";

export function git(args, { quiet = false, cwd = REPO_ROOT } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"],
  });
}

/**
 * Git reports paths with `/` on every platform; `path.relative` returns `\` on
 * Windows. Comparing the two silently matches nothing, which would make the
 * ratchet discard every finding and report "clean" — the worst failure mode for
 * a guard, because it looks like success.
 */
export function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function mergeBase(ref, cwd) {
  return git(["merge-base", ref, "HEAD"], { quiet: true, cwd }).trim();
}

function isAncestor(maybeAncestor, descendant, cwd) {
  try {
    git(["merge-base", "--is-ancestor", maybeAncestor, descendant], { quiet: true, cwd });
    return true;
  } catch {
    return false;
  }
}

function mergeHeadRef(cwd) {
  try {
    return git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { quiet: true, cwd }).trim();
  } catch {
    return null;
  }
}

/**
 * Raise base to MERGE_HEAD when a merge commit is in progress (e.g. a
 * pre-commit hook running mid `git merge`).
 *
 * HEAD has not moved yet at that point — it is still the pre-merge parent —
 * so `merge-base(base, HEAD)` reflects the branch's state BEFORE this merge.
 * Every commit the merge is pulling in from the base branch then reads as
 * "new code in this change", the exact failure this file exists to prevent
 * (see the top comment), just triggered by hook timing instead of a stale
 * `--base`. Only trust MERGE_HEAD as already-known content when it is
 * reachable from the base branch: a normal "sync this branch with base"
 * merge, not pulling in an unrelated branch's unreviewed commits.
 */
function pendingMergeFloor(base, cwd) {
  const mergeHead = mergeHeadRef(cwd);
  if (!mergeHead) return base;
  if (!isAncestor(mergeHead, BASE_BRANCH, cwd)) return base;
  if (!isAncestor(base, mergeHead, cwd)) return base;

  console.log(
    `ℹ base advanced to the in-progress merge's MERGE_HEAD ${mergeHead.slice(0, 9)} — ` +
      `HEAD has not moved yet, and everything MERGE_HEAD brings in from\n` +
      `  ${BASE_BRANCH} is not this change's code.`,
  );
  return mergeHead;
}

/**
 * Raise a caller-supplied base to the point HEAD forked from the base branch.
 *
 * An explicit `--base` is routinely STALE. On a `pull_request` event CI checks
 * out the MERGE REF (`refs/pull/N/merge`), whose first parent is the base branch
 * tip at check time — but `github.event.pull_request.base.sha` is the base tip
 * from when the PR event fired. The stale sha is therefore an *ancestor* of
 * HEAD, so `merge-base` hands it straight back, and every commit the base branch
 * landed in between reads as "new code in this PR". That fails the ratchet on
 * files the change never touched, and it is not fixed by a three-dot diff:
 * `base...HEAD` collapses to `base..HEAD` precisely because base is an ancestor.
 * Rebasing a branch onto a newer base produces the same shape with no merge
 * commit at all.
 *
 * The ratchet's contract is that it never asks you to migrate code you did not
 * write, so the base must never sit older than the fork point.
 */
function forkPointFloor(base, cwd) {
  // HEAD is contained in the base branch — a `push` build of that branch. There
  // is no fork point (the merge base IS HEAD), and advancing to it would compare
  // HEAD against itself and wave every commit through. Trust the caller's base.
  if (isAncestor("HEAD", BASE_BRANCH, cwd)) return base;

  let forkPoint;
  try {
    forkPoint = mergeBase(BASE_BRANCH, cwd);
  } catch {
    // No base branch in this checkout, so there is nothing better to offer.
    return base;
  }

  if (forkPoint === base || !isAncestor(base, forkPoint, cwd)) return base;

  console.log(
    `ℹ base advanced to the ${BASE_BRANCH} fork point ${forkPoint.slice(0, 9)} — ` +
      `the --base given was older, and everything ${BASE_BRANCH} landed in between\n` +
      `  is not this change's code.`,
  );
  return forkPoint;
}

/**
 * The fork point to judge against, or `null` when the caller explicitly allows
 * running without one.
 *
 * Fail-closed: if the caller passed `--base`, or we are in CI, an unresolvable
 * base means a broken checkout (usually a shallow clone that never fetched the
 * base), and skipping would turn that into a silent pass. Only a bare local run
 * — a developer with no `origin/main`, e.g. offline or in a fresh init repo —
 * is allowed to skip, because failing there would block unrelated commits for
 * an environment reason.
 *
 * @returns {{ base: string } | { skip: string }}
 */
export function resolveBase(argv = process.argv, cwd = REPO_ROOT) {
  const flag = argv.indexOf("--base");
  const explicit = flag !== -1 && argv[flag + 1] ? argv[flag + 1] : null;
  const requested = explicit ?? BASE_BRANCH;

  let base;
  try {
    base = mergeBase(requested, cwd);
  } catch {
    if (explicit || process.env.CI) {
      console.error(
        `\n✖ cannot resolve a base to compare against (tried "${requested}").\n` +
          `  In CI this means the checkout is incomplete — a shallow clone that\n` +
          `  never fetched the base branch. Refusing to pass silently.\n` +
          `  Fetch the base ref, or pass --base <sha>.\n`,
      );
      process.exit(1);
    }
    return { skip: `no base ref (tried "${requested}"); pass --base <sha> to check explicitly` };
  }

  // Only an explicit base can be stale; the default IS the fork point already.
  const floored = explicit ? forkPointFloor(base, cwd) : base;
  return { base: pendingMergeFloor(floored, cwd) };
}
