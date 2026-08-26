export type CanvasBlockType = "markdown" | "checklist" | "kanban" | "metrics" | "timeline";

export type CanvasBlock = {
  id: string;
  canvas_id: string;
  type: CanvasBlockType;
  position: number;
  state: unknown;
  block_revision: number;
  created_at: string;
  updated_at: string;
};

export type CanvasTaskLink = {
  canvas_id: string;
  task_id: string;
  linked_by: string;
  created_at: string;
};

export type Canvas = {
  id: string;
  owner_user_id: string;
  workspace_id: string;
  title: string;
  schema_version: number;
  revision: number;
  compacted_through_revision: number;
  source_export_id?: string;
  imported_at?: string;
  archived_at?: string;
  created_at: string;
  updated_at: string;
  blocks: CanvasBlock[];
  task_links: CanvasTaskLink[];
};

export type CanvasEvent = {
  canvas_id: string;
  revision: number;
  command_id: string;
  actor_kind: string;
  actor_id: string;
  action: string;
  target_id?: string;
  payload: unknown;
  created_at: string;
};

export type ApplyCanvasCommandRequest = {
  command_id: string;
  base_revision: number;
  action: string;
  target_id?: string;
  input?: Record<string, unknown>;
  lease_holder_id?: string;
};

export type ApplyCanvasCommandResult = {
  canvas: Canvas;
  event?: CanvasEvent;
  revision: number;
  duplicate?: boolean;
};
