import crypto from "node:crypto";
import { TASK_STEPS } from "../types.js";
import type { RepoWorkItem, Task, TaskStep } from "../types.js";
import type { TaskStore } from "./store.js";

export function findUnfinishedInstance(tasks: TaskStore, quickPromptId: string): Task | null {
  return tasks.list().find((task) => task.quickPromptId === quickPromptId && task.phase !== "merged") ?? null;
}

export function parseConfigByStep(
  configByStep: unknown,
  configNames: Set<string>,
): { error: string } | { value: Partial<Record<TaskStep, string>> } {
  if (configByStep === undefined) return { value: {} };
  if (typeof configByStep !== "object" || configByStep === null || Array.isArray(configByStep)) {
    return { error: "configByStep must be an object mapping steps to configuration names" };
  }

  const value: Partial<Record<TaskStep, string>> = {};
  for (const [step, configName] of Object.entries(configByStep)) {
    if (!TASK_STEPS.includes(step as TaskStep)) {
      return { error: `Unknown task step '${step}' in configByStep` };
    }
    if (typeof configName !== "string" || !configNames.has(configName)) {
      return { error: `Configuration '${String(configName)}' for step '${step}' not found` };
    }
    value[step as TaskStep] = configName;
  }
  return { value };
}

export function resolveConfigByStep(
  configName: unknown,
  configByStep: unknown,
  configNames: Set<string>,
): { error: string } | { value: Record<TaskStep, string> } {
  if (typeof configName !== "string" || !configNames.has(configName)) {
    return { error: `Configuration '${String(configName)}' not found` };
  }
  const overrides = parseConfigByStep(configByStep, configNames);
  if ("error" in overrides) return overrides;
  return {
    value: Object.fromEntries(TASK_STEPS.map((step) => [step, overrides.value[step] ?? configName])) as Record<
      TaskStep,
      string
    >,
  };
}

export function findMissingConfig(configByStep: Record<TaskStep, string>, configNames: Set<string>): string | null {
  const step = TASK_STEPS.find((candidate) => !configNames.has(configByStep[candidate]));
  return step === undefined ? null : `Configuration '${configByStep[step]}' for step '${step}' not found`;
}

export function makeNewTask(
  repoFullName: string,
  repoSource: Task["repoSource"],
  configByStep: Record<TaskStep, string>,
  origin: { workItem: RepoWorkItem } | { sourceText: string; quickPromptId: string | null },
  now: Date,
): Task {
  const timestamp = now.toISOString();
  return {
    id: crypto.randomUUID(),
    repoFullName,
    repoSource,
    workItem: "workItem" in origin ? origin.workItem : null,
    sourceText: "sourceText" in origin ? origin.sourceText : null,
    quickPromptId: "quickPromptId" in origin ? origin.quickPromptId : null,
    createdIssueUrl: null,
    configByStep,
    phase: "spawning",
    reviewRequest: null,
    lastReviewedSha: null,
    lastReviewedDiffHash: null,
    approval: null,
    approvalCancelledAt: null,
    activeContainerId: null,
    activeStep: null,
    attemptsByStep: Object.fromEntries(TASK_STEPS.map((step) => [step, 0])) as Record<TaskStep, number>,
    attempts: [],
    completedStages: [],
    stageStartedAt: timestamp,
    mergedAt: null,
    consecutiveErrors: 0,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
