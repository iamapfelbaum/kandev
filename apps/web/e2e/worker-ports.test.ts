import { describe, expect, it } from "vitest";
import {
  agentctlPortRangeFor,
  backendPortFor,
  E2E_MAX_WORKERS,
  MAX_PORT_OFFSET,
  parsePortOffset,
  resolveWorkerCount,
} from "./worker-ports";

const OFFSETS = Array.from({ length: MAX_PORT_OFFSET + 1 }, (_, index) => index);
const WORKERS = Array.from({ length: E2E_MAX_WORKERS }, (_, index) => index);
const SLOTS = OFFSETS.flatMap((offset) => WORKERS.map((worker) => ({ offset, worker })));

describe("parsePortOffset", () => {
  it("derives an in-range offset from the pid when unset", () => {
    expect(parsePortOffset(undefined, 12_345)).toBe(12_345 % (MAX_PORT_OFFSET + 1));
    expect(parsePortOffset(undefined, 0)).toBe(0);
  });

  it("accepts explicit offsets across the whole range", () => {
    expect(parsePortOffset("0", 1)).toBe(0);
    expect(parsePortOffset(String(MAX_PORT_OFFSET), 1)).toBe(MAX_PORT_OFFSET);
  });

  it.each(["-1", String(MAX_PORT_OFFSET + 1), "1.5", "abc"])("rejects %s", (raw) => {
    expect(() => parsePortOffset(raw, 1)).toThrow(/E2E_PORT_OFFSET/);
  });

  // Pre-existing behaviour, kept deliberately: an exported-but-empty
  // E2E_PORT_OFFSET is `Number("") === 0`, not a pid-derived offset.
  it("treats an empty offset as 0 rather than unset", () => {
    expect(parsePortOffset("", 12_345)).toBe(0);
  });
});

describe("backendPortFor", () => {
  // The regression this guards: with a stride of 1, offset N worker 1 landed on
  // the same port as offset N+1 worker 0, so run-e2e.sh's adjacent-offset local
  // shards collided the moment a shard ran more than one worker.
  it("assigns a unique port to every offset/worker slot", () => {
    const ports = SLOTS.map(({ offset, worker }) => backendPortFor(offset, worker));
    expect(new Set(ports).size).toBe(SLOTS.length);
  });

  it("keeps adjacent offsets from overlapping", () => {
    expect(backendPortFor(0, E2E_MAX_WORKERS - 1)).toBeLessThan(backendPortFor(1, 0));
  });

  it("stays inside the valid port space", () => {
    expect(backendPortFor(0, 0)).toBe(18080);
    expect(backendPortFor(MAX_PORT_OFFSET, E2E_MAX_WORKERS - 1)).toBeLessThan(65_536);
  });

  it("rejects a worker index beyond the reserved slots", () => {
    expect(() => backendPortFor(0, E2E_MAX_WORKERS)).toThrow(/workerIndex/);
    expect(() => backendPortFor(0, -1)).toThrow(/workerIndex/);
  });

  it("rejects an out-of-range offset", () => {
    expect(() => backendPortFor(MAX_PORT_OFFSET + 1, 0)).toThrow(/portOffset/);
  });
});

describe("agentctlPortRangeFor", () => {
  it("gives every slot a disjoint range", () => {
    const ranges = SLOTS.map(({ offset, worker }) => agentctlPortRangeFor(offset, worker)).sort(
      (a, b) => a.base - b.base,
    );
    for (let index = 1; index < ranges.length; index += 1) {
      expect(ranges[index]!.base).toBeGreaterThan(ranges[index - 1]!.max);
    }
  });

  it("never overlaps the backend port range", () => {
    const lowestAgentctl = agentctlPortRangeFor(0, 0).base;
    const highestBackend = backendPortFor(MAX_PORT_OFFSET, E2E_MAX_WORKERS - 1);
    expect(lowestAgentctl).toBeGreaterThan(highestBackend);
  });

  it("stays inside the valid port space", () => {
    expect(agentctlPortRangeFor(0, 0)).toEqual({ base: 30_001, max: 30_200 });
    expect(agentctlPortRangeFor(MAX_PORT_OFFSET, E2E_MAX_WORKERS - 1).max).toBeLessThan(65_536);
  });
});

describe("resolveWorkerCount", () => {
  it("defaults to a single worker", () => {
    expect(resolveWorkerCount(undefined)).toBe(1);
    expect(resolveWorkerCount("  ")).toBe(1);
  });

  it("accepts counts up to the reserved slot count", () => {
    expect(resolveWorkerCount("2")).toBe(2);
    expect(resolveWorkerCount(String(E2E_MAX_WORKERS))).toBe(E2E_MAX_WORKERS);
  });

  it.each(["0", "-1", "2.5", "many", String(E2E_MAX_WORKERS + 1)])("rejects %s", (raw) => {
    expect(() => resolveWorkerCount(raw)).toThrow(/E2E_WORKERS/);
  });
});
