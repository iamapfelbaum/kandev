"use client";

import { useAppStore } from "@/components/state-provider";

/**
 * Whether the current caller may perform install-wide administration.
 *
 * An absent role is the auth-disabled single-user mode: the backend resolves
 * every request there to a synthetic identity carrying the admin role (see
 * internal/auth/httpmw.SyntheticIdentity), so the UI must count it as admin or
 * it would hide controls that work perfectly well.
 *
 * This mirrors the backend's `authn.RequireAdmin` gate. It is a rendering
 * decision only — the server is the authority, and every guarded route still
 * rejects a member that reaches it directly.
 */
export function useIsAdmin(): boolean {
  const role = useAppStore((s) => s.auth.user?.role);
  return role === undefined || role === "admin";
}
