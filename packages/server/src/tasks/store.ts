import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../types.js";

function isMissingFileError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
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
      for (const task of parsed as Task[]) {
        this.tasksById.set(task.id, task);
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
