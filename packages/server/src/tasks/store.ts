import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, TaskApproval, TaskAttempt } from "../types.js";

function isMissingFileError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

type StoredAttempt = Omit<TaskAttempt, "pokeCount" | "lastPokedAt" | "resumedAt" | "isMaterial"> &
  Partial<Pick<TaskAttempt, "pokeCount" | "lastPokedAt" | "resumedAt" | "isMaterial">>;

type StoredTask = Omit<Task, "completedStages" | "stageStartedAt" | "mergedAt" | "quickPromptId" | "approval" | "approvalCancelledAt" | "attempts"> &
  Partial<Pick<Task, "completedStages" | "stageStartedAt" | "mergedAt" | "quickPromptId" | "approval" | "approvalCancelledAt">> & {
    attempts: StoredAttempt[];
  };

function migrateAttempt(stored: StoredAttempt): TaskAttempt {
  return {
    ...stored,
    pokeCount: stored.pokeCount ?? 0,
    lastPokedAt: stored.lastPokedAt ?? null,
    resumedAt: stored.resumedAt ?? null,
    isMaterial: stored.isMaterial ?? null,
  };
}

function hasValidPokeFields(attempt: TaskAttempt): boolean {
  return (
    Number.isInteger(attempt.pokeCount) &&
    attempt.pokeCount >= 0 &&
    (attempt.lastPokedAt === null || typeof attempt.lastPokedAt === "string") &&
    (attempt.resumedAt === null || typeof attempt.resumedAt === "string")
  );
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isValidApproval(approval: TaskApproval | null): boolean {
  if (approval === null) return true;
  return (
    typeof approval === "object" &&
    typeof approval.approvedAt === "string" &&
    isNullableString(approval.headSha) &&
    isNullableString(approval.diffHash)
  );
}

function migrateTask(stored: StoredTask, tasksPath: string): Task {
  const task: Task = {
    ...stored,
    attempts: stored.attempts.map(migrateAttempt),
    completedStages: stored.completedStages ?? [],
    stageStartedAt: stored.stageStartedAt ?? stored.createdAt,
    mergedAt: stored.mergedAt ?? null,
    quickPromptId: stored.quickPromptId ?? null,
    approval: stored.approval ?? null,
    approvalCancelledAt: stored.approvalCancelledAt ?? null,
  };
  if (
    !Array.isArray(task.completedStages) ||
    typeof task.stageStartedAt !== "string" ||
    (task.mergedAt !== null && typeof task.mergedAt !== "string")
  ) {
    throw new Error(`Task store file ${tasksPath} is malformed: task ${task.id} has invalid stage fields`);
  }
  if (!task.attempts.every(hasValidPokeFields)) {
    throw new Error(`Task store file ${tasksPath} is malformed: task ${task.id} has an attempt with invalid poke fields`);
  }
  if (!task.attempts.every((attempt) => attempt.isMaterial === null || typeof attempt.isMaterial === "boolean")) {
    throw new Error(`Task store file ${tasksPath} is malformed: task ${task.id} has an attempt with an invalid isMaterial`);
  }
  if (!isNullableString(task.approvalCancelledAt)) {
    throw new Error(`Task store file ${tasksPath} is malformed: task ${task.id} has an invalid approvalCancelledAt`);
  }
  if (!isValidApproval(task.approval)) {
    throw new Error(`Task store file ${tasksPath} is malformed: task ${task.id} has an invalid approval`);
  }
  if (task.quickPromptId !== null && typeof task.quickPromptId !== "string") {
    throw new Error(`Task store file ${tasksPath} is malformed: task ${task.id} has an invalid quickPromptId`);
  }
  return task;
}

export class TaskStore {
  private readonly tasksById = new Map<string, Task>();
  private readonly tasksPath: string;
  private readonly logsDir: string;

  constructor(stateDir: string) {
    this.tasksPath = join(stateDir, "tasks.json");
    this.logsDir = join(stateDir, "task-logs");
    mkdirSync(this.logsDir, { recursive: true });

    let raw: string | null = null;
    try {
      raw = readFileSync(this.tasksPath, "utf-8");
    } catch (err) {
      if (!isMissingFileError(err)) throw err;
    }

    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`Task store file ${this.tasksPath} is malformed: expected a JSON array`);
      }
      for (const stored of parsed as StoredTask[]) {
        this.tasksById.set(stored.id, migrateTask(stored, this.tasksPath));
      }
    }
  }

  list(): Task[] {
    return [...this.tasksById.values()];
  }

  get(id: string): Task | null {
    return this.tasksById.get(id) ?? null;
  }

  save(task: Task): void {
    task.updatedAt = new Date().toISOString();
    this.tasksById.set(task.id, task);
    this.persist();
  }

  remove(id: string): void {
    if (!this.tasksById.delete(id)) return;
    this.persist();
    rmSync(join(this.logsDir, id), { recursive: true, force: true });
  }

  writeAttemptLog(taskId: string, attemptIndex: number, content: string): void {
    const dir = join(this.logsDir, taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${attemptIndex}.log`), content, "utf-8");
  }

  readAttemptLog(taskId: string, attemptIndex: number): string | null {
    try {
      return readFileSync(join(this.logsDir, taskId, `${attemptIndex}.log`), "utf-8");
    } catch (err) {
      if (isMissingFileError(err)) return null;
      throw err;
    }
  }

  private persist(): void {
    const stagingPath = `${this.tasksPath}.${process.pid}.tmp`;
    writeFileSync(stagingPath, `${JSON.stringify(this.list(), null, 2)}\n`, "utf-8");
    renameSync(stagingPath, this.tasksPath);
  }
}
