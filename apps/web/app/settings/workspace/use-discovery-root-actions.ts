"use client";

import type { TFunction } from "i18next";
import {
  addDesktopDiscoveryRootAction,
  reconnectDesktopDiscoveryRootAction,
  removeDesktopDiscoveryRootAction,
} from "@/app/actions/workspaces";
import { useToast } from "@/components/toast-provider";

type DiscoveryRefresh = {
  refresh: () => Promise<unknown>;
};

type Toast = ReturnType<typeof useToast>["toast"];

function reportDiscoveryError(toast: Toast, t: TFunction, error: unknown) {
  toast({
    title: t("workspaces:failedToDiscoverRepositories"),
    description: error instanceof Error ? error.message : t("common:requestFailed"),
    variant: "error",
  });
}

async function runDiscoveryAction(
  action: () => Promise<unknown>,
  discovery: DiscoveryRefresh,
  toast: Toast,
  t: TFunction,
): Promise<void> {
  try {
    await action();
    await discovery.refresh();
  } catch (error) {
    reportDiscoveryError(toast, t, error);
  }
}

export function useDiscoveryRootActions(discovery: DiscoveryRefresh, toast: Toast, t: TFunction) {
  const refreshDiscovery = () => runDiscoveryAction(() => Promise.resolve(), discovery, toast, t);
  const handleChooseDiscoveryRoot = (path: string) =>
    runDiscoveryAction(() => addDesktopDiscoveryRootAction(path), discovery, toast, t);
  const handleReconnectDiscoveryRoot = (oldPath: string, newPath: string) =>
    runDiscoveryAction(
      () => reconnectDesktopDiscoveryRootAction(oldPath, newPath),
      discovery,
      toast,
      t,
    );
  const handleRemoveDiscoveryRoot = (path: string) =>
    runDiscoveryAction(() => removeDesktopDiscoveryRootAction(path), discovery, toast, t);

  return {
    refreshDiscovery,
    handleChooseDiscoveryRoot,
    handleReconnectDiscoveryRoot,
    handleRemoveDiscoveryRoot,
  };
}
