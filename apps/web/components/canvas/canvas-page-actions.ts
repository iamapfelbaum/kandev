import { useState } from "react";
import { useTranslation } from "react-i18next";
import { archiveCanvas, exportCanvas, removeCanvas } from "@/lib/api/domains/canvas-api";
import { generateUUID } from "@/lib/utils";
import { triggerBlobDownload } from "@/lib/utils/file-download";
import type {
  ApplyCanvasCommandRequest,
  ApplyCanvasCommandResult,
  Canvas,
} from "@/lib/types/canvas";

type CanvasPageActionsProps = {
  canvas: Canvas | null;
  apply: (command: ApplyCanvasCommandRequest) => Promise<ApplyCanvasCommandResult | null>;
  refresh: () => Promise<Canvas | null | undefined>;
};

export function useCanvasPageActions({ canvas, apply, refresh }: CanvasPageActionsProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const addMarkdownBlock = async () => {
    if (!canvas || busy) return;
    setBusy(true);
    try {
      await apply({
        command_id: generateUUID(),
        base_revision: canvas.revision,
        action: "block.create",
        input: { type: "markdown", state: { markdown: "" } },
      });
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!canvas || busy) return;
    setBusy(true);
    try {
      const blob = await exportCanvas(canvas.id);
      triggerBlobDownload(blob, "canvas.kandev-canvas");
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!canvas || busy) return;
    setBusy(true);
    try {
      await archiveCanvas(canvas.id, !canvas.archived_at);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!canvas || busy || !window.confirm(t("canvases:confirmRemoveCanvas"))) return;
    setBusy(true);
    try {
      await removeCanvas(canvas.id);
      window.location.assign("/");
    } finally {
      setBusy(false);
    }
  };

  return { busy, addMarkdownBlock, download, archive, remove };
}
