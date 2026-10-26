import type { Forge } from "../forge/index.js";
import type { Task } from "../types.js";

export async function withdrawApproval(forge: Forge, task: Task, now: Date): Promise<void> {
  await forge.unapprove(task.repoFullName, task.reviewRequest!.id);
  task.approval = null;
  task.approvalCancelledAt = now.toISOString();
}
