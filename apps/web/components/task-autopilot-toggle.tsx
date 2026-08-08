"use client";

import { IconRobot } from "@tabler/icons-react";
import { Switch } from "@kandev/ui/switch";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export function TaskAutopilotToggle({
  checked,
  onCheckedChange,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex min-h-11 items-center justify-between gap-3 rounded-md border px-3 py-2",
        checked ? "border-yellow-500/50 bg-yellow-500/10" : "border-border",
      )}
      data-testid="autopilot-toggle-row"
    >
      <div className="flex min-w-0 items-center gap-2">
        <IconRobot className="h-4 w-4 shrink-0 text-yellow-500" aria-hidden="true" />
        <div className="min-w-0">
          <label htmlFor="task-autopilot-toggle" className="text-sm font-medium">
            {t("task:autopilot")}
          </label>
          <p className="text-xs text-muted-foreground">{t("task:autopilotDescription")}</p>
        </div>
      </div>
      <Switch
        id="task-autopilot-toggle"
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={t("task:autopilot")}
        className="shrink-0"
      />
    </div>
  );
}
