import type { Task, TaskPhase } from "../types";

const PHASE_PRIORITY: Partial<Record<TaskPhase, number>> = {
  failed: 0,
  waiting_approval: 1,
};
const DEFAULT_PRIORITY = 2;

function priority(task: Task): number {
  return PHASE_PRIORITY[task.phase] ?? DEFAULT_PRIORITY;
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => priority(a) - priority(b) || b.createdAt.localeCompare(a.createdAt));
}
