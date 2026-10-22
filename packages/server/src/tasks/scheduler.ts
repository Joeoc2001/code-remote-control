import type { ContainerCodeStatus, InstanceStatus } from "@crc/container-metadata-types";
import {
  buildCreateIssuePrompt,
  buildFixCiPrompt,
  buildRebasePrompt,
  buildReviewCommentsPrompt,
  buildReviewRequestPrompt,
  buildTaskImplementPrompt,
} from "@crc/shared/prompts";
import type {
  ManagedContainer,
  QuickPrompt,
  RepoReviewRequest,
  RepoSource,
  RepoWorkItem,
  ResolvedConfigFile,
  ResolvedEnvironmentConfig,
  Task,
  TaskAttempt,
  TaskContainer,
  TaskSpawn,
  TaskStep,
} from "../types.js";
import { currentStageFirstAttemptIndex, TASK_STEPS } from "../types.js";
import type { Forge } from "../forge/index.js";
import type { TaskStore } from "./store.js";
import { findMissingConfig, findUnfinishedInstance, makeNewTask } from "./new-task.js";
import type { QuickPromptPatch, QuickPromptStore } from "./quick-prompt-store.js";
import { completedReviews, decide, NIT_THREAD_REVIEW_LIMIT, type TaskDecision } from "./decide.js";

export const TASK_TICK_INTERVAL_MS = 30_000;
export const ATTEMPT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const MAX_CONSECUTIVE_ERRORS = 5;
export const CLOSURE_GRACE_MS = 2 * 60 * 1000;
export const MAX_STAGES = 5;
export const HELD_CONTAINER_SUFFIX = "; its container was kept so the agent can be inspected or prompted from the terminal";

export interface SchedulerDeps {
  store: TaskStore;
  quickPrompts: QuickPromptStore;
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
  broadcastQuickPromptUpdated(prompt: QuickPrompt): void;
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
    const reason = `Failed after ${MAX_CONSECUTIVE_ERRORS} consecutive errors, most recently: ${message}`;
    if (task.activeContainerId) {
      await holdAttempt(deps, task, task.attempts.length - 1, `${reason}${HELD_CONTAINER_SUFFIX}`);
      return;
    }
    task.phase = "failed";
    task.error = reason;
  }

  saveTask(deps, task);
}

async function captureAttemptLog(deps: SchedulerDeps, task: Task, attemptIndex: number, containerId: string): Promise<void> {
  try {
    deps.store.writeAttemptLog(task.id, attemptIndex, await deps.getContainerLogTail(containerId));
  } catch (err) {
    console.error(`Task ${task.id}: could not capture log tail of attempt ${attemptIndex}:`, err);
  }
}

async function holdAttempt(deps: SchedulerDeps, task: Task, attemptIndex: number, reason: string): Promise<void> {
  const attempt = task.attempts[attemptIndex];
  if (!attempt.containerId || attempt.containerId !== task.activeContainerId) {
    throw new Error(`Task ${task.id}: cannot hold attempt ${attemptIndex}, it is not the task's active container`);
  }
  await captureAttemptLog(deps, task, attemptIndex, attempt.containerId);
  attempt.error = reason;
  task.phase = "failed";
  task.error = reason;
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

function updateQuickPrompt(deps: SchedulerDeps, id: string, patch: QuickPromptPatch): void {
  const updated = deps.quickPrompts.update(id, patch);
  if (updated) deps.broadcastQuickPromptUpdated(updated);
}

function recordQuickPromptReviewRequest(deps: SchedulerDeps, task: Task, reviewRequestId: string): void {
  if (task.quickPromptId === null) return;
  const prompt = deps.quickPrompts.get(task.quickPromptId);
  if (!prompt || prompt.reviewRequestIds.includes(reviewRequestId)) return;
  updateQuickPrompt(deps, prompt.id, { reviewRequestIds: [...prompt.reviewRequestIds, reviewRequestId] });
}

function captureReviewRequestLink(deps: SchedulerDeps, task: Task, codeStatus: ContainerCodeStatus): void {
  if (task.reviewRequest || !codeStatus.reviewRequest) return;
  task.reviewRequest = {
    id: codeStatus.reviewRequest.id,
    url: codeStatus.reviewRequest.url,
    sourceBranch: codeStatus.reviewRequest.sourceBranch,
  };
  recordQuickPromptReviewRequest(deps, task, task.reviewRequest.id);
}

function captureCreatedIssueUrl(task: Task, codeStatus: ContainerCodeStatus): void {
  if (task.createdIssueUrl || !codeStatus.createdIssueUrl) return;
  task.createdIssueUrl = codeStatus.createdIssueUrl;
}

function captureContainerLinks(
  deps: SchedulerDeps,
  task: Task,
  attempt: TaskAttempt,
  codeStatus: ContainerCodeStatus,
): void {
  if (attempt.step === "create_issue") {
    captureCreatedIssueUrl(task, codeStatus);
    return;
  }
  captureReviewRequestLink(deps, task, codeStatus);
}

function missingDeliverableReason(task: Task, step: TaskStep): string | null {
  if (step === "create_issue" && task.createdIssueUrl === null) {
    return "Issue-creation agent finished without reporting a created issue URL";
  }
  if (step === "implement" && task.reviewRequest === null) {
    return "Implement agent finished without opening a PR/MR";
  }
  return null;
}

function normaliseWorkItemUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
}

function failTask(deps: SchedulerDeps, task: Task, reason: string): void {
  task.phase = "failed";
  task.error = reason;
  saveTask(deps, task);
}

async function findOpenWorkItem(forge: Forge, repoFullName: string, wanted: string): Promise<RepoWorkItem | null> {
  const items = await forge.listWorkItems(repoFullName);
  return items.find((candidate) => normaliseWorkItemUrl(candidate.url) === wanted) ?? null;
}

async function adoptCreatedIssue(deps: SchedulerDeps, forge: Forge, task: Task, createdIssueUrl: string): Promise<void> {
  const wanted = normaliseWorkItemUrl(createdIssueUrl);
  if (wanted === null) {
    failTask(deps, task, `Issue-creation agent reported '${createdIssueUrl}', which is not a URL`);
    return;
  }
  const item = await findOpenWorkItem(forge, task.repoFullName, wanted);
  if (!item) {
    failTask(deps, task, `Created issue ${createdIssueUrl} is not among the repository's open work items`);
    return;
  }
  task.workItem = item;
  clearTaskError(task);
  saveTask(deps, task);
}

function markReviewRequestMerged(deps: SchedulerDeps, task: Task): void {
  task.phase = "checking_closure";
  task.mergedAt = deps.now().toISOString();
  clearTaskError(task);
  saveTask(deps, task);
}

function startNextStage(deps: SchedulerDeps, task: Task, workItem: RepoWorkItem): void {
  if (!task.reviewRequest || task.mergedAt === null) {
    throw new Error(`Task ${task.id} cannot start a new stage before its PR/MR has merged`);
  }
  const firstAttemptIndex = currentStageFirstAttemptIndex(task);
  task.completedStages.push({
    reviewRequest: task.reviewRequest,
    startedAt: task.stageStartedAt,
    mergedAt: task.mergedAt,
    firstAttemptIndex,
    attemptCount: task.attempts.length - firstAttemptIndex,
  });
  task.workItem = workItem;
  task.reviewRequest = null;
  task.lastReviewedSha = null;
  task.lastReviewedDiffHash = null;
  task.mergedAt = null;
  task.attemptsByStep = Object.fromEntries(TASK_STEPS.map((step) => [step, 0])) as Record<TaskStep, number>;
  task.consecutiveErrors = 0;
  task.error = null;
  task.stageStartedAt = deps.now().toISOString();
  task.phase = "spawning";
  saveTask(deps, task);
}

async function checkWorkItemClosure(deps: SchedulerDeps, forge: Forge, task: Task): Promise<void> {
  if (!task.workItem || task.mergedAt === null) {
    throw new Error(`Task ${task.id} is checking issue closure without a work item or merge time`);
  }
  const wanted = normaliseWorkItemUrl(task.workItem.url);
  if (wanted === null) {
    throw new Error(`Task ${task.id}'s work item URL '${task.workItem.url}' is not a URL`);
  }
  const openItem = await findOpenWorkItem(forge, task.repoFullName, wanted);
  if (!openItem) {
    task.phase = "merged";
    clearTaskError(task);
    saveTask(deps, task);
    return;
  }
  if (deps.now().getTime() - Date.parse(task.mergedAt) < CLOSURE_GRACE_MS) {
    if (clearTaskError(task)) saveTask(deps, task);
    return;
  }
  if (task.completedStages.length + 1 >= MAX_STAGES) {
    failTask(
      deps,
      task,
      `${task.workItem.reference} is still open after ${MAX_STAGES} merged stages — close it by hand before resuming the task (resuming while it is still open fails again straight away), or finish the remaining work manually`,
    );
    return;
  }
  startNextStage(deps, task, openItem);
}

function attemptActiveSince(attempt: TaskAttempt, status: InstanceStatus | null): number {
  const startedAt = Date.parse(attempt.startedAt);
  if (status === null || status.updatedAt === null) {
    return startedAt;
  }
  return Math.max(startedAt, Date.parse(status.updatedAt));
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
    await captureAttemptLog(deps, task, attemptIndex, containerId);
    await deps.removeContainer(containerId);
    finishAttempt(deps, task, attempt, `Agent container stopped unexpectedly (status: ${container.status})`);
    saveTask(deps, task);
    return "evaluate";
  }

  let status: InstanceStatus | null;
  try {
    status = await deps.fetchInstanceStatus(container.name);
  } catch (err) {
    console.error(`Task ${task.id}: container metadata server unreachable, waiting:`, err);
    status = null;
  }

  const elapsedMs = deps.now().getTime() - attemptActiveSince(attempt, status);
  if (status?.state !== "waiting" && status?.state !== "finished" && elapsedMs > ATTEMPT_TIMEOUT_MS) {
    try {
      captureContainerLinks(deps, task, attempt, await deps.fetchCodeStatus(container.name));
    } catch (err) {
      console.error(`Task ${task.id}: could not capture code status before timing out attempt:`, err);
    }
    await holdAttempt(
      deps,
      task,
      attemptIndex,
      `Attempt timed out after ${Math.round(ATTEMPT_TIMEOUT_MS / 60_000)} minutes${HELD_CONTAINER_SUFFIX}`,
    );
    return "settle";
  }

  if (status === null) {
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

  captureContainerLinks(deps, task, attempt, codeStatus);
  const missingDeliverable = missingDeliverableReason(task, attempt.step);
  if (missingDeliverable !== null) {
    await holdAttempt(deps, task, attemptIndex, `${missingDeliverable}${HELD_CONTAINER_SUFFIX}`);
    return "settle";
  }
  deps.store.writeAttemptLog(task.id, attemptIndex, await deps.getContainerLogTail(containerId));
  await deps.removeContainer(containerId);
  finishAttempt(deps, task, attempt, null);
  clearTaskError(task);
  saveTask(deps, task);
  return "settle";
}

function buildStepPrompt(step: TaskStep, task: Task, reviewRequest: RepoReviewRequest | null): string {
  if (step === "create_issue") {
    if (task.sourceText === null) {
      throw new Error(`Task ${task.id} has no source text to create an issue from`);
    }
    return buildCreateIssuePrompt(task.sourceText, task.repoSource);
  }
  if (step === "implement") {
    if (!task.workItem) {
      throw new Error(`Task ${task.id} has no work item to implement`);
    }
    return buildTaskImplementPrompt(
      task.workItem,
      task.repoSource,
      task.completedStages.map((stage) => stage.reviewRequest.url),
    );
  }
  if (!reviewRequest) {
    throw new Error(`Step '${step}' requires the forge state of the task's PR/MR`);
  }
  switch (step) {
    case "review":
      return buildReviewRequestPrompt(
        reviewRequest,
        completedReviews(task) < NIT_THREAD_REVIEW_LIMIT ? "threads" : "comment",
      );
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

function orphanReason(container: ManagedContainer, task: Task, attempt: TaskAttempt | undefined): string | null {
  if (attempt) return "its attempt already finished";
  if (task.activeContainerId) return `task ${task.id} is running another agent`;
  if (!isLive(task)) return `task ${task.id} is ${task.phase}`;
  if (container.status === "created") return "it never started";
  return null;
}

async function removeOrphanedContainer(deps: SchedulerDeps, container: ManagedContainer, reason: string): Promise<void> {
  console.warn(`Removing orphaned agent container ${container.name}: ${reason}`);
  try {
    await deps.removeContainer(container.id);
  } catch (err) {
    console.error(`Failed to remove orphaned agent container ${container.name}:`, err);
  }
}

async function reconcileTaskContainers(deps: SchedulerDeps): Promise<void> {
  for (const { container, spawn } of await deps.listTaskContainers()) {
    if (!spawn) {
      await removeOrphanedContainer(deps, container, "its task label is unreadable");
      continue;
    }

    const task = deps.store.get(spawn.taskId);
    if (!task) {
      await removeOrphanedContainer(deps, container, `task ${spawn.taskId} no longer exists`);
      continue;
    }

    const attempt = task.attempts.find((a) => a.containerId === container.id);
    if (attempt && task.activeContainerId === container.id) continue;

    const reason = orphanReason(container, task, attempt);
    if (reason !== null) {
      await removeOrphanedContainer(deps, container, reason);
      continue;
    }

    console.warn(
      `Task ${task.id}: adopting agent container ${container.name} for step '${spawn.step}' whose spawn was not recorded`,
    );
    recordSpawnedAgent(deps, task, container, spawn, container.createdAt);
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
      markReviewRequestMerged(deps, task);
      return;
    }
    case "fail": {
      failTask(deps, task, decision.reason);
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
      markReviewRequestMerged(deps, task);
      return;
    }
    case "spawn": {
      await spawnAgent(deps, task, decision, reviewRequest);
      return;
    }
  }
}

function repoKey(repo: { repoSource: RepoSource; repoFullName: string }): string {
  return `${repo.repoSource}:${repo.repoFullName}`;
}

async function relaunchPerpetualPrompt(
  deps: SchedulerDeps,
  prompt: QuickPrompt,
  openReviewRequests: (prompt: QuickPrompt) => Promise<RepoReviewRequest[]>,
  configNames: () => Promise<Set<string>>,
): Promise<void> {
  if (findUnfinishedInstance(deps.store, prompt.id)) return;

  if (prompt.reviewRequestIds.length > 0) {
    const openIds = new Set((await openReviewRequests(prompt)).map((item) => item.id));
    const stillOpen = prompt.reviewRequestIds.filter((id) => openIds.has(id));
    if (stillOpen.length > 0) {
      if (stillOpen.length !== prompt.reviewRequestIds.length) {
        updateQuickPrompt(deps, prompt.id, { reviewRequestIds: stillOpen });
      }
      return;
    }
  }

  const names = await configNames();
  const current = deps.quickPrompts.get(prompt.id);
  if (!current?.perpetual || findUnfinishedInstance(deps.store, prompt.id)) return;
  if (current.configByStep === null) {
    throw new Error("Perpetual quick-prompt has no stored configuration");
  }
  const missingConfig = findMissingConfig(current.configByStep, names);
  if (missingConfig !== null) {
    throw new Error(`${missingConfig}; choose another configuration for this quick-prompt`);
  }

  const now = deps.now();
  const task = makeNewTask(
    current.repoFullName,
    current.repoSource,
    current.configByStep,
    { sourceText: current.text, quickPromptId: current.id },
    now,
  );
  saveTask(deps, task);
  updateQuickPrompt(deps, prompt.id, { reviewRequestIds: [], lastLaunchedAt: now.toISOString(), error: null });
}

async function relaunchPerpetualPrompts(
  deps: SchedulerDeps,
  snapshots: Map<string, RepoReviewRequest[]>,
): Promise<void> {
  const openReviewRequests = async (prompt: QuickPrompt) => {
    const key = repoKey(prompt);
    const cached = snapshots.get(key);
    if (cached) return cached;
    const snapshot = await deps.getForge(prompt.repoSource).listReviewRequests(prompt.repoFullName);
    snapshots.set(key, snapshot);
    return snapshot;
  };
  let names: Set<string> | null = null;
  const configNames = async () => {
    names ??= new Set((await deps.loadConfigurations()).configurations.map((c) => c.name));
    return names;
  };

  for (const prompt of deps.quickPrompts.listAll().filter((candidate) => candidate.perpetual)) {
    try {
      await relaunchPerpetualPrompt(deps, prompt, openReviewRequests, configNames);
      if (deps.quickPrompts.get(prompt.id)?.error) updateQuickPrompt(deps, prompt.id, { error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Quick-prompt ${prompt.id}: could not relaunch:`, err);
      if (prompt.error !== message) updateQuickPrompt(deps, prompt.id, { error: message });
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

  const checkingClosure = toEvaluate.filter((t) => t.phase === "checking_closure");
  const toDecide = toEvaluate.filter((t) => t.phase !== "checking_closure");

  for (const task of checkingClosure) {
    try {
      await checkWorkItemClosure(deps, deps.getForge(task.repoSource), task);
    } catch (err) {
      await recordTaskError(deps, task, err);
    }
  }

  for (const task of toDecide.filter((t) => !t.reviewRequest)) {
    try {
      const forge = deps.getForge(task.repoSource);
      if (!task.workItem && task.createdIssueUrl) {
        await adoptCreatedIssue(deps, forge, task, task.createdIssueUrl);
        if (!isSchedulable(task)) continue;
      }
      const decision = await decide(task, null, diffHashFetcher(forge, task));
      await executeDecision(deps, forge, task, decision, null);
    } catch (err) {
      await recordTaskError(deps, task, err);
    }
  }

  const groups = new Map<string, Task[]>();
  for (const task of toDecide.filter((t) => t.reviewRequest)) {
    const key = repoKey(task);
    const group = groups.get(key);
    if (group) {
      group.push(task);
    } else {
      groups.set(key, [task]);
    }
  }

  const snapshots = new Map<string, RepoReviewRequest[]>();
  for (const [key, group] of groups) {
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
    snapshots.set(key, snapshot);

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

  await relaunchPerpetualPrompts(deps, snapshots);
}
