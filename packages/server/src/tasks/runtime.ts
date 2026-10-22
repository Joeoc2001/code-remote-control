import type { ContainerCodeStatus, InstanceStatus } from "@crc/container-metadata-types";
import { CRC_STATE_DIR, loadConfigurations } from "../config.js";
import {
  broadcastRemoval,
  broadcastSSE,
  createContainer,
  findManagedContainer,
  getContainerLogTail,
  listTaskContainers,
  pokeAgent,
  removeContainer,
  CONTAINER_METADATA_INTERNAL_PORT,
} from "../docker.js";
import { getForge } from "../forge/index.js";
import type { QuickPrompt, Task } from "../types.js";
import { QuickPromptStore } from "./quick-prompt-store.js";
import { TaskStore } from "./store.js";
import type { SchedulerDeps } from "./scheduler.js";

export const taskStore = new TaskStore(CRC_STATE_DIR);
export const quickPromptStore = new QuickPromptStore(CRC_STATE_DIR);

export function broadcastTaskUpdated(task: Task): void {
  broadcastSSE("task-updated", task);
}

export function broadcastTaskRemoved(id: string): void {
  broadcastSSE("task-removed", { id });
}

export function broadcastQuickPromptUpdated(prompt: QuickPrompt): void {
  broadcastSSE("quick-prompt-updated", prompt);
}

export function broadcastQuickPromptRemoved(id: string): void {
  broadcastSSE("quick-prompt-removed", { id });
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
  quickPrompts: quickPromptStore,
  getForge,
  loadConfigurations,
  getContainer: findManagedContainer,
  createContainer,
  listTaskContainers,
  removeContainer: async (id) => {
    await removeContainer(id);
    broadcastRemoval(id);
  },
  getContainerLogTail,
  fetchInstanceStatus: (containerName) =>
    fetchContainerMetadata<InstanceStatus>(containerName, "/api/instance-status"),
  fetchCodeStatus: (containerName) =>
    fetchContainerMetadata<ContainerCodeStatus>(containerName, "/api/code-status"),
  pokeAgent,
  broadcastTaskUpdated,
  broadcastQuickPromptUpdated,
  now: () => new Date(),
};
