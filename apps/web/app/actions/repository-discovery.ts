"use server";

import { fetchJson } from "@/lib/api/client";
import { getBackendConfig } from "@/lib/config";
import type { DesktopDiscoveryRoot, RepositoryDiscoveryResponse } from "@/lib/types/http";

const { apiBaseUrl } = getBackendConfig();

export async function getRepositoryDiscoveryAction(
  workspaceId: string,
  root?: string,
): Promise<RepositoryDiscoveryResponse> {
  const params = root ? `?root=${encodeURIComponent(root)}` : "";
  return fetchJson<RepositoryDiscoveryResponse>(
    `${apiBaseUrl}/api/v1/workspaces/${workspaceId}/repositories/discovery${params}`,
  );
}

export async function refreshRepositoryDiscoveryAction(
  workspaceId: string,
  root?: string,
): Promise<RepositoryDiscoveryResponse> {
  const params = root ? `?root=${encodeURIComponent(root)}` : "";
  return fetchJson<RepositoryDiscoveryResponse>(
    `${apiBaseUrl}/api/v1/workspaces/${workspaceId}/repositories/discovery/refresh${params}`,
    { init: { method: "POST" } },
  );
}

export async function listDesktopDiscoveryRootsAction(): Promise<{
  roots: DesktopDiscoveryRoot[];
}> {
  return fetchJson<{ roots: DesktopDiscoveryRoot[] }>(
    `${apiBaseUrl}/api/v1/repositories/discovery/roots`,
  );
}

export async function addDesktopDiscoveryRootAction(path: string): Promise<DesktopDiscoveryRoot> {
  return fetchJson<DesktopDiscoveryRoot>(`${apiBaseUrl}/api/v1/repositories/discovery/roots`, {
    init: { method: "POST", body: JSON.stringify({ path }) },
  });
}

export async function reconnectDesktopDiscoveryRootAction(
  oldPath: string,
  newPath: string,
): Promise<DesktopDiscoveryRoot> {
  return fetchJson<DesktopDiscoveryRoot>(
    `${apiBaseUrl}/api/v1/repositories/discovery/roots/reconnect`,
    { init: { method: "POST", body: JSON.stringify({ path: oldPath, new_path: newPath }) } },
  );
}

export async function removeDesktopDiscoveryRootAction(path: string): Promise<void> {
  await fetchJson<void>(
    `${apiBaseUrl}/api/v1/repositories/discovery/roots?path=${encodeURIComponent(path)}`,
    { init: { method: "DELETE" } },
  );
}
