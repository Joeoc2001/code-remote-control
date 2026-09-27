import type { Task, TaskStep } from "../types.js";

export interface ResumeDeps {
  removeContainer(id: string): Promise<void>;
  now(): Date;
}

export const DISCARDED_CONTAINER_ERROR = "Agent container discarded on resume";

export async function resumeTask(deps: ResumeDeps, task: Task, discardContainer: boolean): Promise<void> {
  if (task.phase !== "failed" && task.phase !== "paused") {
    throw new Error(`Cannot resume task ${task.id} in phase '${task.phase}'`);
  }

  if (task.activeContainerId) {
    const attempt = task.attempts[task.attempts.length - 1];
    if (!attempt || attempt.containerId !== task.activeContainerId) {
      throw new Error(`Task ${task.id} has an active container but no matching attempt record`);
    }
    if (discardContainer) {
      await deps.removeContainer(task.activeContainerId);
      attempt.finishedAt = deps.now().toISOString();
      attempt.error = attempt.error ?? DISCARDED_CONTAINER_ERROR;
      task.activeContainerId = null;
      task.activeStep = null;
    } else {
      attempt.error = null;
    }
  } else if (discardContainer) {
    throw new Error(`Task ${task.id} has no agent container to discard`);
  }

  if (task.phase === "failed") {
    task.attemptsByStep = Object.fromEntries(
      Object.keys(task.attemptsByStep).map((step) => [step, 0]),
    ) as Record<TaskStep, number>;
    task.error = null;
    task.consecutiveErrors = 0;
  }
  task.phase = task.activeContainerId ? "agent_running" : "spawning";
}
