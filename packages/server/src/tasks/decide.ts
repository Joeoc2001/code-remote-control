import type { RepoReviewRequest, Task, TaskAttempt, TaskPhase, TaskStep } from "../types.js";

export const PER_STEP_SPAWN_CAP = 3;
export const TOTAL_SPAWN_CAP = 12;
export const REVIEW_CYCLE_CAP = 3;

const PER_STEP_CAPPED_STEPS: readonly TaskStep[] = ["fix_ci", "rebase"];
const REVIEW_CYCLE_STEPS: readonly TaskStep[] = ["review", "address_comments"];

export type TaskDecision =
  | { kind: "noop"; phase: TaskPhase | null }
  | { kind: "spawn"; step: TaskStep; headShaBefore: string | null; diffHashBefore: string | null }
  | { kind: "mark_reviewed"; headSha: string; diffHash: string }
  | { kind: "forge_rebase" }
  | { kind: "merge" }
  | { kind: "mark_merged" }
  | { kind: "fail"; reason: string };

function totalAttempts(task: Task): number {
  return Object.values(task.attemptsByStep).reduce((sum, count) => sum + count, 0);
}

function attemptsSinceResume(task: Task): TaskAttempt[] {
  return task.attempts.slice(task.attempts.length - totalAttempts(task));
}

function trailingReviewCycles(task: Task): number {
  const attempts = attemptsSinceResume(task);
  let cycles = 0;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (!REVIEW_CYCLE_STEPS.includes(attempt.step)) break;
    if (attempt.step === "address_comments" && attempt.error === null) cycles += 1;
  }
  return cycles;
}

function reviewCycleExhausted(task: Task, step: TaskStep): boolean {
  if (step !== "address_comments") return false;
  if (task.phase === "waiting_approval") return false;
  return trailingReviewCycles(task) >= REVIEW_CYCLE_CAP;
}

function spawn(
  task: Task,
  step: TaskStep,
  headShaBefore: string | null = null,
  diffHashBefore: string | null = null,
): TaskDecision {
  if (totalAttempts(task) >= TOTAL_SPAWN_CAP) {
    return {
      kind: "fail",
      reason: `Task hit the total spawn cap of ${TOTAL_SPAWN_CAP} agent attempts (next step would have been '${step}')`,
    };
  }
  if (PER_STEP_CAPPED_STEPS.includes(step) && task.attemptsByStep[step] >= PER_STEP_SPAWN_CAP) {
    return {
      kind: "fail",
      reason: `Step '${step}' hit its spawn cap of ${PER_STEP_SPAWN_CAP} attempts without the task advancing`,
    };
  }
  if (reviewCycleExhausted(task, step)) {
    return {
      kind: "fail",
      reason: `Review and comment-addressing cycled ${REVIEW_CYCLE_CAP} times without the PR/MR becoming ready for approval — resolve the remaining threads by hand, then resume the task`,
    };
  }
  return { kind: "spawn", step, headShaBefore, diffHashBefore };
}

export async function decide(
  task: Task,
  reviewRequest: RepoReviewRequest | null,
  getDiffHash: () => Promise<string | null>,
): Promise<TaskDecision> {
  if (task.phase === "paused" || task.phase === "merged" || task.phase === "failed") {
    return { kind: "noop", phase: null };
  }

  if (task.activeContainerId) {
    throw new Error(`decide() called for task ${task.id} while an agent container is active`);
  }

  if (!task.reviewRequest) {
    if (reviewRequest) {
      throw new Error(`decide() received forge state for task ${task.id}, which has no linked PR/MR`);
    }
    if (task.attemptsByStep.implement === 0) {
      return spawn(task, "implement");
    }
    const lastImplementAttempt = [...task.attempts].reverse().find((attempt) => attempt.step === "implement");
    return {
      kind: "fail",
      reason: lastImplementAttempt?.error
        ? `Implement agent did not open a PR/MR (attempt failed: ${lastImplementAttempt.error})`
        : "Implement agent finished without opening a PR/MR",
    };
  }

  if (!reviewRequest) {
    throw new Error(`decide() called for task ${task.id} without the forge state of its linked PR/MR`);
  }

  if (reviewRequest.state === "merged") {
    return { kind: "mark_merged" };
  }

  if (reviewRequest.state === "closed") {
    return { kind: "fail", reason: `${reviewRequest.reference} was closed without being merged` };
  }

  if (reviewRequest.ciState === "pending" || reviewRequest.ciState === "running") {
    return { kind: "noop", phase: "waiting_ci" };
  }

  if (reviewRequest.ciState === "failed") {
    return spawn(task, "fix_ci");
  }

  if (!reviewRequest.mergeStateKnown) {
    return { kind: "noop", phase: null };
  }

  if (reviewRequest.needsRebase && !reviewRequest.hasConflicts) {
    return task.repoSource === "gitlab" ? { kind: "forge_rebase" } : spawn(task, "rebase");
  }

  if (reviewRequest.hasConflicts) {
    return spawn(task, "rebase");
  }

  if (reviewRequest.headSha !== task.lastReviewedSha) {
    const diffHash = await getDiffHash();
    if (diffHash !== null && diffHash === task.lastReviewedDiffHash) {
      return { kind: "mark_reviewed", headSha: reviewRequest.headSha, diffHash };
    }
    return spawn(task, "review", reviewRequest.headSha, diffHash);
  }

  if (reviewRequest.hasUnresolvedComments) {
    return spawn(task, "address_comments");
  }

  if (!reviewRequest.approvedByHuman) {
    return { kind: "noop", phase: "waiting_approval" };
  }

  return { kind: "merge" };
}
