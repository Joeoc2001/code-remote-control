import type { ContainerCodeStatus, InstanceStatus } from "@crc/container-metadata-types";
import {
  buildFixCiPrompt,
  buildRebasePrompt,
  buildReviewCommentsPrompt,
  buildReviewRequestPrompt,
  buildTaskImplementPrompt,
} from "@crc/shared/prompts";
import type {
  ManagedContainer,
  RepoReviewRequest,
  RepoSource,
  ResolvedConfigFile,
  ResolvedEnvironmentConfig,
  Task,
  TaskAttempt,
  TaskContainer,
  TaskSpawn,
  TaskStep,
} from "../types.js";
import type { Forge } from "../forge/index.js";
import type { TaskStore } from "./store.js";
import { decide, type TaskDecision } from "./decide.js";

export const TASK_TICK_INTERVAL_MS = 30_000;
export const ATTEMPT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const MAX_CONSECUTIVE_ERRORS = 5;

export interface SchedulerDeps {
  store: TaskStore;
  getForge(source: RepoSource): Forge;
  loadConfigurations(): Promise<ResolvedConfigFile>;
  getContainer(id: string): Promise<ManagedContainer | null>;
  createContainer(
    appConfig: ResolvedConfigFile,
    config: ResolvedEnvironmentConfig,
    repoFullName: string,
    repoSource: RepoSource,
    options: { initialPrompt: string; task: TaskSpawn },
  ): Promise<ManagedContainer>;
  listTaskContainers(): Promise<TaskContainer[]>;
  removeContainer(id: string): Promise<void>;
  getContainerLogTail(id: string): Promise<string>;
  fetchInstanceStatus(containerName: string): Promise<InstanceStatus>;
  fetchCodeStatus(containerName: string): Promise<ContainerCodeStatus>;
  broadcastTaskUpdated(task: Task): void;
  now(): Date;
}

function diffHashFetcher(forge: Forge, task: Task): () => Promise<string | null> {
  return () => {
    if (!task.reviewRequest) {
      throw new Error(`Task ${task.id} has no linked PR/MR to fetch a diff for`);
    }
    return forge.getDiffHash(task.repoFullName, task.reviewRequest.id);
  };
}

function isLive(task: Task): boolean {
  return task.phase !== "merged" && task.phase !== "failed";
}

function isSchedulable(task: Task): boolean {
  return isLive(task) && task.phase !== "paused";
}

function saveTask(deps: SchedulerDeps, task: Task): void {
  deps.store.save(task);
  deps.broadcastTaskUpdated(task);
}

function clearTaskError(task: Task): boolean {
  if (task.error === null && task.consecutiveErrors === 0) return false;
  task.error = null;
  task.consecutiveErrors = 0;
  return true;
}

async function recordTaskError(deps: SchedulerDeps, task: Task, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Task ${task.id} error:`, err);
  task.consecutiveErrors += 1;
  task.error = message;

  if (task.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    task.phase = "failed";
    task.error = `Failed after ${MAX_CONSECUTIVE_ERRORS} consecutive errors, most recently: ${message}`;
    if (task.activeContainerId) {
      try {
        deps.store.writeAttemptLog(
          task.id,
          task.attempts.length - 1,
          await deps.getContainerLogTail(task.activeContainerId),
        );
      } catch (logErr) {
        console.error(`Task ${task.id}: could not capture log tail before failing:`, logErr);
      }
      try {
        await deps.removeContainer(task.activeContainerId);
      } catch (removeErr) {
        console.error(`Failed to remove container for failed task ${task.id}:`, removeErr);
      }
      const attempt = task.attempts[task.attempts.length - 1];
      attempt.finishedAt = deps.now().toISOString();
      attempt.error = attempt.error ?? task.error;
      task.activeContainerId = null;
      task.activeStep = null;
    }
  }

  saveTask(deps, task);
}

function finishAttempt(deps: SchedulerDeps, task: Task, attempt: TaskAttempt, error: string | null): void {
  attempt.finishedAt = deps.now().toISOString();
  attempt.error = error;
  if (error === null && attempt.step === "review") {
    task.lastReviewedSha = attempt.headShaBefore;
    task.lastReviewedDiffHash = attempt.diffHashBefore;
  }
  task.activeContainerId = null;
  task.activeStep = null;
}

function captureReviewRequestLink(task: Task, codeStatus: ContainerCodeStatus): void {
  if (task.reviewRequest || !codeStatus.reviewRequest) return;
  task.reviewRequest = {
    id: codeStatus.reviewRequest.id,
    url: codeStatus.reviewRequest.url,
    sourceBranch: codeStatus.reviewRequest.sourceBranch,
  };
}

async function evaluateActiveAgent(deps: SchedulerDeps, task: Task): Promise<"settle" | "evaluate"> {
  const attemptIndex = task.attempts.length - 1;
  const attempt = task.attempts[attemptIndex];
  const containerId = task.activeContainerId;
  if (!containerId || !attempt || attempt.containerId !== containerId) {
    throw new Error(`Task ${task.id} has an active container but no matching attempt record`);
  }

  const container = await deps.getContainer(containerId);
  if (!container) {
    finishAttempt(deps, task, attempt, "Agent container disappeared unexpectedly");
    saveTask(deps, task);
    return "evaluate";
  }

  if (container.status === "restarting") {
    return "settle";
  }

  if (container.status !== "running") {
    try {
      deps.store.writeAttemptLog(task.id, attemptIndex, await deps.getContainerLogTail(containerId));
    } catch (err) {
      console.error(`Task ${task.id}: could not capture log tail of stopped container:`, err);
    }
    await deps.removeContainer(containerId);
    finishAttempt(deps, task, attempt, `Agent container stopped unexpectedly (status: ${container.status})`);
    saveTask(deps, task);
    return "evaluate";
  }

  const elapsedMs = deps.now().getTime() - Date.parse(attempt.startedAt);
  if (elapsedMs > ATTEMPT_TIMEOUT_MS) {
    try {
      captureReviewRequestLink(task, await deps.fetchCodeStatus(container.name));
    } catch (err) {
      console.error(`Task ${task.id}: could not capture code status before timing out attempt:`, err);
    }
    try {
      deps.store.writeAttemptLog(task.id, attemptIndex, await deps.getContainerLogTail(containerId));
    } catch (err) {
      console.error(`Task ${task.id}: could not capture log tail before timing out attempt:`, err);
    }
    await deps.removeContainer(containerId);
    finishAttempt(
      deps,
      task,
      attempt,
      `Attempt timed out after ${Math.round(ATTEMPT_TIMEOUT_MS / 60_000)} minutes`,
    );
    saveTask(deps, task);
    return "settle";
  }

  let status: InstanceStatus;
  try {
    status = await deps.fetchInstanceStatus(container.name);
  } catch (err) {
    console.error(`Task ${task.id}: container metadata server unreachable, waiting:`, err);
    return "settle";
  }

  if (status.state !== "finished") {
    if (attempt.finishedObservation) {
      attempt.finishedObservation = null;
      saveTask(deps, task);
    }
    return "settle";
  }

  const codeStatus = await deps.fetchCodeStatus(container.name);
  const previousObservation = attempt.finishedObservation ?? null;
  if (previousObservation === null || previousObservation.headSha !== codeStatus.commitSha) {
    attempt.finishedObservation = { headSha: codeStatus.commitSha, observedAt: deps.now().toISOString() };
    saveTask(deps, task);
    return "settle";
  }

  captureReviewRequestLink(task, codeStatus);
  deps.store.writeAttemptLog(task.id, attemptIndex, await deps.getContainerLogTail(containerId));
  await deps.removeContainer(containerId);
  finishAttempt(deps, task, attempt, null);
  clearTaskError(task);
  saveTask(deps, task);
  return "settle";
}

function buildStepPrompt(step: TaskStep, task: Task, reviewRequest: RepoReviewRequest | null): string {
  if (step === "implement") {
    return buildTaskImplementPrompt(task.workItem, task.repoSource);
  }
  if (!reviewRequest) {
    throw new Error(`Step '${step}' requires the forge state of the task's PR/MR`);
  }
  switch (step) {
    case "review":
      return buildReviewRequestPrompt(reviewRequest);
    case "address_comments":
      return buildReviewCommentsPrompt(reviewRequest);
    case "rebase":
      return buildRebasePrompt(reviewRequest);
    case "fix_ci":
      return buildFixCiPrompt(reviewRequest);
  }
}

async function spawnAgent(
  deps: SchedulerDeps,
  task: Task,
  decision: Extract<TaskDecision, { kind: "spawn" }>,
  reviewRequest: RepoReviewRequest | null,
): Promise<void> {
  const configName = task.configByStep[decision.step];
  const configs = await deps.loadConfigurations();
  const config = configs.configurations.find((c) => c.name === configName);
  if (!config) {
    throw new Error(`Configuration '${configName}' for step '${decision.step}' not found`);
  }

  const prompt = buildStepPrompt(decision.step, task, reviewRequest);

  if (task.phase !== "spawning") {
    task.phase = "spawning";
    saveTask(deps, task);
  }

  const spawn: TaskSpawn = {
    taskId: task.id,
    step: decision.step,
    headShaBefore: decision.headShaBefore,
    diffHashBefore: decision.diffHashBefore,
  };
  const container = await deps.createContainer(configs, config, task.repoFullName, task.repoSource, {
    initialPrompt: prompt,
    task: spawn,
  });

  if (!deps.store.get(task.id)) {
    await deps.removeContainer(container.id);
    return;
  }

  recordSpawnedAgent(deps, task, container, spawn, deps.now().toISOString());
}

function recordSpawnedAgent(
  deps: SchedulerDeps,
  task: Task,
  container: ManagedContainer,
  spawn: TaskSpawn,
  startedAt: string,
): void {
  task.attempts.push({
    step: spawn.step,
    containerId: container.id,
    headShaBefore: spawn.headShaBefore,
    diffHashBefore: spawn.diffHashBefore,
    startedAt,
    finishedAt: null,
    finishedObservation: null,
    error: null,
  });
  task.attemptsByStep[spawn.step] += 1;
  task.activeContainerId = container.id;
  task.activeStep = spawn.step;
  if (task.phase !== "paused") {
    task.phase = "agent_running";
  }
  clearTaskError(task);
  saveTask(deps, task);
}

async function reconcileTaskContainers(deps: SchedulerDeps): Promise<void> {
  for (const { container, spawn } of await deps.listTaskContainers()) {
    const task = deps.store.get(spawn.taskId);
    const attempt = task?.attempts.find((a) => a.containerId === container.id);

    if (task && attempt && task.activeContainerId === container.id) continue;

    if (task && !attempt && !task.activeContainerId && isLive(task)) {
      console.warn(
        `Task ${task.id}: adopting agent container ${container.name} for step '${spawn.step}' whose spawn was not recorded`,
      );
      recordSpawnedAgent(deps, task, container, spawn, container.createdAt);
      continue;
    }

    const reason = !task
      ? `task ${spawn.taskId} no longer exists`
      : attempt
        ? `its attempt already finished`
        : `task ${task.id} is ${task.activeContainerId ? "running another agent" : task.phase}`;
    console.warn(`Removing orphaned agent container ${container.name}: ${reason}`);
    try {
      await deps.removeContainer(container.id);
    } catch (err) {
      console.error(`Failed to remove orphaned agent container ${container.name}:`, err);
    }
  }
}

async function executeDecision(
  deps: SchedulerDeps,
  forge: Forge,
  task: Task,
  decision: TaskDecision,
  reviewRequest: RepoReviewRequest | null,
): Promise<void> {
  switch (decision.kind) {
    case "noop": {
      let changed = clearTaskError(task);
      if (decision.phase !== null && task.phase !== decision.phase) {
        task.phase = decision.phase;
        changed = true;
      }
      if (changed) saveTask(deps, task);
      return;
    }
    case "mark_reviewed": {
      task.lastReviewedSha = decision.headSha;
      task.lastReviewedDiffHash = decision.diffHash;
      clearTaskError(task);
      saveTask(deps, task);
      return;
    }
    case "mark_merged": {
      task.phase = "merged";
      clearTaskError(task);
      saveTask(deps, task);
      return;
    }
    case "fail": {
      task.phase = "failed";
      task.error = decision.reason;
      saveTask(deps, task);
      return;
    }
    case "forge_rebase": {
      await forge.rebase(task.repoFullName, task.reviewRequest!.id);
      task.phase = "waiting_ci";
      clearTaskError(task);
      saveTask(deps, task);
      return;
    }
    case "merge": {
      if (task.phase !== "merging") {
        task.phase = "merging";
        saveTask(deps, task);
      }
      await forge.merge(task.repoFullName, task.reviewRequest!.id);
      task.phase = "merged";
      clearTaskError(task);
      saveTask(deps, task);
      return;
    }
    case "spawn": {
      await spawnAgent(deps, task, decision, reviewRequest);
      return;
    }
  }
}

export async function runTaskSchedulerTick(deps: SchedulerDeps): Promise<void> {
  await reconcileTaskContainers(deps);

  const liveTasks = deps.store.list().filter(isSchedulable);

  const toEvaluate: Task[] = [];
  for (const task of liveTasks) {
    if (!task.activeContainerId) {
      toEvaluate.push(task);
      continue;
    }

    let outcome: "settle" | "evaluate";
    try {
      outcome = await evaluateActiveAgent(deps, task);
    } catch (err) {
      await recordTaskError(deps, task, err);
      outcome = "settle";
    }
    if (outcome === "evaluate" && isSchedulable(task)) {
      toEvaluate.push(task);
    }
  }

  for (const task of toEvaluate.filter((t) => !t.reviewRequest)) {
    try {
      const forge = deps.getForge(task.repoSource);
      const decision = await decide(task, null, diffHashFetcher(forge, task));
      await executeDecision(deps, forge, task, decision, null);
    } catch (err) {
      await recordTaskError(deps, task, err);
    }
  }

  const groups = new Map<string, Task[]>();
  for (const task of toEvaluate.filter((t) => t.reviewRequest)) {
    const key = `${task.repoSource}:${task.repoFullName}`;
    const group = groups.get(key);
    if (group) {
      group.push(task);
    } else {
      groups.set(key, [task]);
    }
  }

  for (const group of groups.values()) {
    const { repoSource, repoFullName } = group[0];
    const forge = deps.getForge(repoSource);

    let snapshot: RepoReviewRequest[];
    try {
      snapshot = await forge.listReviewRequests(repoFullName);
    } catch (err) {
      for (const task of group) {
        await recordTaskError(deps, task, err);
      }
      continue;
    }

    for (const task of group) {
      try {
        let reviewRequest: RepoReviewRequest | null = null;
        if (task.reviewRequest) {
          const linkedId = task.reviewRequest.id;
          reviewRequest =
            snapshot.find((item) => item.id === linkedId) ??
            (await forge.getReviewRequest(repoFullName, linkedId));
        }
        if (!isSchedulable(task)) continue;
        const decision = await decide(task, reviewRequest, diffHashFetcher(forge, task));
        await executeDecision(deps, forge, task, decision, reviewRequest);
      } catch (err) {
        await recordTaskError(deps, task, err);
      }
    }
  }
}
