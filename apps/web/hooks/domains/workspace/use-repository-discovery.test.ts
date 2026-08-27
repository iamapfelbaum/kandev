import { describe, expect, it, vi } from "vitest";
import {
  RepositoryDiscoveryCoordinator,
  type RepositoryDiscoveryClient,
} from "./use-repository-discovery";
import type { RepositoryDiscoveryResponse } from "@/lib/types/http";

class FakeVisibilityDocument {
  visibilityState: DocumentVisibilityState = "visible";
  private readonly listeners = new Set<() => void>();

  addEventListener = (_type: string, listener: EventListenerOrEventListenerObject) => {
    this.listeners.add(listener as () => void);
  };

  removeEventListener = (_type: string, listener: EventListenerOrEventListenerObject) => {
    this.listeners.delete(listener as () => void);
  };

  setVisibility(value: DocumentVisibilityState) {
    this.visibilityState = value;
    for (const listener of this.listeners) listener();
  }
}

const oldScan = "2026-08-27T20:00:00.000Z";
const workspaceId = "workspace-1";

function response(scanTime = oldScan): RepositoryDiscoveryResponse {
  return {
    roots: ["/work"],
    repositories: [{ path: "/work/repo", name: "repo" }],
    total: 1,
    root_states: [],
    scan_time: scanTime,
    refreshing: false,
    cached: true,
    home_confirmation_required: false,
    failed_roots: [],
  };
}

function client(overrides: Partial<RepositoryDiscoveryClient> = {}): RepositoryDiscoveryClient {
  return {
    getSnapshot: vi.fn(async () => response()),
    refresh: vi.fn(async () => response("2026-08-27T21:00:00.000Z")),
    ...overrides,
  };
}

describe("RepositoryDiscoveryCoordinator", () => {
  it("shares one stale refresh between active leases", async () => {
    const api = client();
    const document = new FakeVisibilityDocument();
    const coordinator = new RepositoryDiscoveryCoordinator(api, {
      document,
      now: () => Date.parse("2026-08-27T22:00:00.000Z"),
    });

    const releaseOne = coordinator.acquire(workspaceId);
    const releaseTwo = coordinator.acquire(workspaceId);
    await vi.waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1));

    expect(api.getSnapshot).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot(workspaceId).response?.scan_time).toBe(
      "2026-08-27T21:00:00.000Z",
    );
    releaseOne();
    releaseTwo();
    coordinator.dispose();
  });

  it("waits for a visible active lease before refreshing", async () => {
    const api = client();
    const document = new FakeVisibilityDocument();
    document.visibilityState = "hidden";
    const coordinator = new RepositoryDiscoveryCoordinator(api, {
      document,
      now: () => Date.parse("2026-08-27T22:00:00.000Z"),
    });

    const release = coordinator.acquire(workspaceId);
    await vi.waitFor(() => expect(api.getSnapshot).toHaveBeenCalledTimes(1));
    expect(api.refresh).not.toHaveBeenCalled();

    document.setVisibility("visible");
    await vi.waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1));
    release();
    document.setVisibility("hidden");
    document.setVisibility("visible");
    expect(api.refresh).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it("keeps the last response when a refresh fails", async () => {
    const api = client({
      refresh: vi.fn(async () => {
        throw new Error("permission denied");
      }),
    });
    const coordinator = new RepositoryDiscoveryCoordinator(api, {
      now: () => Date.parse("2026-08-27T22:00:00.000Z"),
    });
    const release = coordinator.acquire(workspaceId);
    await vi.waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1));

    const state = coordinator.getSnapshot(workspaceId);
    expect(state.response?.repositories).toHaveLength(1);
    expect(state.error?.message).toBe("permission denied");
    expect(state.isRefreshing).toBe(false);
    release();
    coordinator.dispose();
  });
});
