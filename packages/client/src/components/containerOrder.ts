import type { InstanceState, InstanceStatus, ManagedContainer } from "../types";

const STATE_PRIORITY: Record<InstanceState, number> = {
  waiting: 0,
  finished: 1,
  working: 2,
  "awaiting-background": 2,
};
const NO_STATUS_PRIORITY = 3;

export function sortContainers(
  containers: ManagedContainer[],
  getInstanceStatus: (container: ManagedContainer) => InstanceStatus | null,
): ManagedContainer[] {
  const priority = (container: ManagedContainer): number => {
    const status = getInstanceStatus(container);
    return status ? STATE_PRIORITY[status.state] : NO_STATUS_PRIORITY;
  };
  return [...containers].sort((a, b) => priority(a) - priority(b) || b.createdAt.localeCompare(a.createdAt));
}
