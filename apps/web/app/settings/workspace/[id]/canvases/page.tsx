"use client";

import { CanvasSettingsPage } from "@/components/canvas/canvas-settings-page";

export default function CanvasesPage({ workspaceId }: { workspaceId: string }) {
  return <CanvasSettingsPage workspaceId={workspaceId} />;
}
