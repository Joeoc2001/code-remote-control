import { useCallback, useEffect, useState } from "react";
import type { ManagedContainer } from "../types";

export type PolledContainerFetcher<T> = (containerId: string) => Promise<T | null>;

export default function usePolledContainerData<T>(
  containers: ManagedContainer[],
  fetcher: PolledContainerFetcher<T>,
  intervalMs: number,
): [Record<string, T>, (containersToRefresh: ManagedContainer[]) => Promise<void>] {
  const [dataByContainerId, setDataByContainerId] = useState<Record<string, T>>({});

  const refresh = useCallback(
    async (containersToRefresh: ManagedContainer[]) => {
      const entries = await Promise.all(
        containersToRefresh
          .filter((container) => container.status === "running")
          .map(async (container) => {
            try {
              return { id: container.id, data: await fetcher(container.id) };
            } catch {
              return { id: container.id, data: null };
            }
          }),
      );

      setDataByContainerId((previous) => {
        const next = { ...previous };

        for (const container of containersToRefresh) {
          if (container.status !== "running") {
            delete next[container.id];
          }
        }

        for (const { id, data } of entries) {
          if (data) {
            next[id] = data;
          } else {
            delete next[id];
          }
        }

        return next;
      });
    },
    [fetcher],
  );

  useEffect(() => {
    const runningIds = new Set(
      containers.filter((container) => container.status === "running").map((container) => container.id),
    );

    setDataByContainerId((previous) => {
      const staleIds = Object.keys(previous).filter((id) => !runningIds.has(id));
      if (staleIds.length === 0) return previous;

      const next = { ...previous };
      for (const id of staleIds) {
        delete next[id];
      }
      return next;
    });
  }, [containers]);

  useEffect(() => {
    if (containers.length === 0) return;

    const interval = setInterval(() => {
      if (document.hidden) return;
      void refresh(containers);
    }, intervalMs);

    const onVisibilityChange = () => {
      if (!document.hidden) void refresh(containers);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [containers, refresh, intervalMs]);

  return [dataByContainerId, refresh];
}
