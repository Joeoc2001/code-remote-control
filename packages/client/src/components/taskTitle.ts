import type { Task } from "../types";

export function taskTitle(task: Task): string {
  if (task.workItem) return `${task.workItem.reference} ${task.workItem.title}`;
  const firstLine = (task.sourceText ?? "").split("\n")[0].trim();
  return firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
}
