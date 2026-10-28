import type { Forge } from "../forge/index.js";
import type { Task, TaskApproval } from "../types.js";

export function approvalCoversHead(approval: TaskApproval | null, headSha: string | null): approval is TaskApproval {
  if (approval === null || headSha === null) return false;
  return [approval.headSha, approval.carriesTo, approval.rebasingFrom].includes(headSha);
}

export async function withdrawApproval(forge: Forge, task: Task, now: Date): Promise<void> {
  if (task.approval !== null) {
    await forge.unapprove(task.repoFullName, task.reviewRequest!.id);
  }
  task.approval = null;
  task.approvalCancelledAt = now.toISOString();
}
