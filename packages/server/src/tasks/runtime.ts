import type { ContainerCodeStatus, InstanceStatus } from "@crc/container-metadata-types";
import { CRC_STATE_DIR, loadConfigurations } from "../config.js";
import {
  broadcastRemoval,
  broadcastSSE,
  createContainer,
  findManagedContainer,
  getContainerLogTail,
  removeContainer,
  CONTAINER_METADATA_INTERNAL_PORT,
} from "../docker.js";
import { getForge } from "../forge/index.js";
import type { Task } from "../types.js";
import { TaskStore } from "./store.js";
import type { SchedulerDeps } from "./scheduler.js";

export const taskStore = new TaskStore(CRC_STATE_DIR);

export function broadcastTaskUpdated(task: Task): void {
  broadcastSSE("task-updated", task);
}

export function broadcastTaskRemoved(id: string): void {
  broadcastSSE("task-removed", { id });
}

async function fetchContainerMetadata<T>(containerName: string, path: string): Promise<T> {
  const response = await fetch(`http://${containerName}:${CONTAINER_METADATA_INTERNAL_PORT}${path}`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    throw new Error(`Container metadata server returned ${response.status} for ${path}`);
  }
  return (await response.json()) as T;
}

export const schedulerDeps: SchedulerDeps = {
  store: taskStore,
  getForge,
  loadConfigurations,
  getContainer: findManagedContainer,
  createContainer,
  removeContainer: async (id) => {
    await removeContainer(id);
    broadcastRemoval(id);
  },
  getContainerLogTail,
  fetchInstanceStatus: (containerName) =>
    fetchContainerMetadata<InstanceStatus>(containerName, "/api/instance-status"),
  fetchCodeStatus: (containerName) =>
    fetchContainerMetadata<ContainerCodeStatus>(containerName, "/api/code-status"),
  broadcastTaskUpdated,
  now: () => new Date(),
};
