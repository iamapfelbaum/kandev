/**
 * Port allocation shared by `playwright.config.ts` and the worker-scoped
 * backend fixture.
 *
 * Two independent axes have to stay collision-free:
 *
 *   - `E2E_PORT_OFFSET` (0-29) separates concurrent *processes*.
 *     `e2e/scripts/run-e2e.sh` launches local host shards with adjacent
 *     offsets, and an unset offset falls back to `pid % 30`.
 *   - `parallelIndex` separates Playwright workers *inside* one process.
 *
 * Reserving `E2E_MAX_WORKERS` slots per offset is what keeps the two apart.
 * Without the stride, `18080 + offset + parallelIndex` puts offset N worker 1 on
 * the exact port offset N+1 worker 0 uses — harmless while `workers: 1` made
 * the second term always zero, but a real collision as soon as a shard runs
 * more than one worker.
 *
 * Callers must pass Playwright's `parallelIndex`, never `workerIndex`. Only
 * `parallelIndex` is bounded by `0..workers-1` and reused by the replacement
 * process when a worker is restarted after a failure; `workerIndex` is a
 * monotonic counter over every worker process the run ever creates. Feeding
 * `workerIndex` in here means the ports drift upward on every retry — with a
 * failing shard it climbs into other offsets' ranges and eventually past
 * 65535, which is exactly what `assertSlot` below now refuses to do silently.
 */

/**
 * Worker slots reserved per port offset. Raising this widens the stride for
 * every offset, so it must stay within the agentctl budget asserted below.
 */
export const E2E_MAX_WORKERS = 4;

/** `E2E_PORT_OFFSET` is validated to this inclusive range. */
export const MAX_PORT_OFFSET = 29;

const BACKEND_PORT_FLOOR = 18080;

// agentctl ranges start above the dev instance default (41001-41100) and are
// offset far from the backend ports. The async cleanup of agent instances runs
// after each test deletes its tasks, so during a long shard the in-flight
// cleanup queue can hold several dozen ports at once; 200 per worker keeps
// headroom for that.
const AGENTCTL_PORT_FLOOR = 30001;
const AGENTCTL_PORTS_PER_OFFSET = 1000;
const AGENTCTL_PORTS_PER_WORKER = 200;

// A worker's agentctl range must not spill into the next offset's block.
if (E2E_MAX_WORKERS * AGENTCTL_PORTS_PER_WORKER > AGENTCTL_PORTS_PER_OFFSET) {
  throw new Error(
    `E2E_MAX_WORKERS=${E2E_MAX_WORKERS} needs ${E2E_MAX_WORKERS * AGENTCTL_PORTS_PER_WORKER} ` +
      `agentctl ports per offset, but only ${AGENTCTL_PORTS_PER_OFFSET} are reserved`,
  );
}

export function parsePortOffset(raw: string | undefined, pid: number): number {
  const offset = raw === undefined ? pid % (MAX_PORT_OFFSET + 1) : Number(raw);
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_PORT_OFFSET) {
    throw new Error(`E2E_PORT_OFFSET must be an integer 0-${MAX_PORT_OFFSET}, got: ${raw}`);
  }
  return offset;
}

function assertSlot(portOffset: number, parallelIndex: number): void {
  if (!Number.isInteger(portOffset) || portOffset < 0 || portOffset > MAX_PORT_OFFSET) {
    throw new Error(`portOffset must be an integer 0-${MAX_PORT_OFFSET}, got: ${portOffset}`);
  }
  if (!Number.isInteger(parallelIndex) || parallelIndex < 0 || parallelIndex >= E2E_MAX_WORKERS) {
    throw new Error(
      `parallelIndex must be an integer 0-${E2E_MAX_WORKERS - 1}, got: ${parallelIndex}. ` +
        `Raise E2E_MAX_WORKERS in e2e/worker-ports.ts to run more workers per shard.`,
    );
  }
}

/** The backend (and, since they share a port, frontend) port for one worker. */
export function backendPortFor(portOffset: number, parallelIndex: number): number {
  assertSlot(portOffset, parallelIndex);
  return BACKEND_PORT_FLOOR + portOffset * E2E_MAX_WORKERS + parallelIndex;
}

/** The inclusive agentctl instance port range for one worker. */
export function agentctlPortRangeFor(
  portOffset: number,
  parallelIndex: number,
): { base: number; max: number } {
  assertSlot(portOffset, parallelIndex);
  const base =
    AGENTCTL_PORT_FLOOR +
    portOffset * AGENTCTL_PORTS_PER_OFFSET +
    parallelIndex * AGENTCTL_PORTS_PER_WORKER;
  return { base, max: base + AGENTCTL_PORTS_PER_WORKER - 1 };
}

/**
 * Workers per shard process. Defaults to 1 so local runs and the
 * container-backed project (which drives a real Docker daemon per worker) keep
 * their existing single-worker behaviour; CI's chromium/mobile-chrome shards
 * opt in via `E2E_WORKERS`.
 */
export function resolveWorkerCount(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const workers = Number(raw);
  if (!Number.isInteger(workers) || workers < 1 || workers > E2E_MAX_WORKERS) {
    throw new Error(`E2E_WORKERS must be an integer 1-${E2E_MAX_WORKERS}, got: ${raw}`);
  }
  return workers;
}
