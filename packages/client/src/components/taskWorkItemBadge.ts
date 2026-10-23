import type { Task } from "../types";

export interface TaskWorkItemBadge {
  url: string;
  label: string;
  state: "open" | "closed";
}

const KIND_LABELS = { issue: "Issue", work_item: "Work item" } as const;

export function taskWorkItemBadge(task: Task): TaskWorkItemBadge | null {
  if (task.workItem) {
    return {
      url: task.workItem.url,
      label: `${KIND_LABELS[task.workItem.kind]} ${task.workItem.reference}`,
      state: task.phase === "merged" ? "closed" : "open",
    };
  }
  if (task.createdIssueUrl) return { url: task.createdIssueUrl, label: "Issue", state: "open" };
  return null;
}
