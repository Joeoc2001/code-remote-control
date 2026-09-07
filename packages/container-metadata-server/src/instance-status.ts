import { readFile } from "node:fs/promises";
import type { InstanceState, InstanceStatus } from "../../container-metadata-types/src/index.js";

const INSTANCE_STATES: readonly InstanceState[] = ["working", "waiting", "awaiting-background", "finished"];

export function instanceStatusPath(): string {
  return process.env.CRC_INSTANCE_STATUS_PATH || "/run/crc-instance-status.json";
}

function isInstanceState(value: unknown): value is InstanceState {
  return typeof value === "string" && (INSTANCE_STATES as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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
  if (parsed.pendingTaskIds !== undefined && !isStringArray(parsed.pendingTaskIds)) {
    throw new Error(`Instance status file ${path} has a malformed pendingTaskIds list`);
  }

  return {
    state: parsed.state,
    ...(parsed.pendingTaskIds === undefined ? {} : { pendingTaskIds: parsed.pendingTaskIds }),
    updatedAt: parsed.updatedAt,
  };
}
