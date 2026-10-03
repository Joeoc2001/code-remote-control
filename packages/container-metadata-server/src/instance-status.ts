import { readFile } from "node:fs/promises";
import type { InstanceState, InstanceStatus, PendingTask, PendingTaskKind } from "../../container-metadata-types/src/index.js";

const INSTANCE_STATES: readonly InstanceState[] = ["working", "waiting", "awaiting-background", "finished"];

export function instanceStatusPath(): string {
  return process.env.CRC_INSTANCE_STATUS_PATH || "/run/crc-instance-status.json";
}

function isInstanceState(value: unknown): value is InstanceState {
  return typeof value === "string" && (INSTANCE_STATES as readonly string[]).includes(value);
}

const PENDING_TASK_KINDS: readonly PendingTaskKind[] = ["shell", "agent", "remote"];

function isPendingTask(value: unknown): value is PendingTask {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    typeof task.label === "string" &&
    typeof task.kind === "string" &&
    (PENDING_TASK_KINDS as readonly string[]).includes(task.kind)
  );
}

function isPendingTaskList(value: unknown): value is PendingTask[] {
  return Array.isArray(value) && value.every(isPendingTask);
}

export async function readInstanceStatus(): Promise<InstanceStatus> {
  const path = instanceStatusPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "working", updatedAt: null };
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!isInstanceState(parsed.state) || typeof parsed.updatedAt !== "string") {
    throw new Error(`Instance status file ${path} is malformed`);
  }
  if (parsed.pendingTasks !== undefined && !isPendingTaskList(parsed.pendingTasks)) {
    throw new Error(`Instance status file ${path} has a malformed pendingTasks list`);
  }

  return {
    state: parsed.state,
    ...(parsed.pendingTasks === undefined ? {} : { pendingTasks: parsed.pendingTasks }),
    updatedAt: parsed.updatedAt,
  };
}
