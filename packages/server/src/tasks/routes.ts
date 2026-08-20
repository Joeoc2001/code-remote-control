import { Router } from "express";
import crypto from "node:crypto";
import { loadConfigurations } from "../config.js";
import { broadcastRemoval, removeContainer } from "../docker.js";
import { getForge } from "../forge/index.js";
import { TASK_STEPS } from "../types.js";
import type { CreateTasksRequest, Task, TaskStep, UpdateTaskRequest } from "../types.js";
import { getRepoNameError, isValidRepoSource } from "../validation.js";
import { broadcastTaskRemoved, broadcastTaskUpdated, taskStore } from "./runtime.js";

export const tasksRouter = Router();

const MAX_BULK_WORK_ITEMS = 25;

function isLive(task: Task): boolean {
  return task.phase !== "merged" && task.phase !== "failed";
}

function saveAndBroadcast(task: Task): void {
  taskStore.save(task);
  broadcastTaskUpdated(task);
}

function getConfigByStepError(
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

tasksRouter.get("/api/tasks", (_req, res) => {
  res.json(taskStore.list());
});

tasksRouter.get("/api/tasks/:id", (req, res) => {
  const task = taskStore.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json(task);
});

tasksRouter.get("/api/tasks/:id/attempts/:index/log", (req, res) => {
  const task = taskStore.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= task.attempts.length) {
    res.status(404).json({ error: "Attempt not found" });
    return;
  }

  const log = taskStore.readAttemptLog(task.id, index);
  if (log === null) {
    res.status(404).json({ error: "No captured log for this attempt" });
    return;
  }

  res.json({ log });
});

tasksRouter.post("/api/tasks", async (req, res) => {
  try {
    const { repoFullName, repoSource, workItemIds, configName, configByStep } = req.body as CreateTasksRequest;

    if (!repoFullName || !configName || !Array.isArray(workItemIds)) {
      res.status(400).json({ error: "repoFullName, configName, and workItemIds are required" });
      return;
    }

    if (!isValidRepoSource(repoSource)) {
      res.status(400).json({ error: "repoSource must be 'github' or 'gitlab'" });
      return;
    }

    const repoNameError = getRepoNameError(repoFullName, repoSource);
    if (repoNameError) {
      res.status(400).json({ error: repoNameError });
      return;
    }

    if (workItemIds.length === 0 || workItemIds.some((id) => typeof id !== "string" || id.length === 0)) {
      res.status(400).json({ error: "workItemIds must contain at least one non-empty string" });
      return;
    }

    if (workItemIds.length > MAX_BULK_WORK_ITEMS) {
      res.status(400).json({ error: `Cannot create more than ${MAX_BULK_WORK_ITEMS} tasks at once` });
      return;
    }

    const configs = await loadConfigurations();
    const configNames = new Set(configs.configurations.map((c) => c.name));
    if (!configNames.has(configName)) {
      res.status(400).json({ error: `Configuration '${configName}' not found` });
      return;
    }

    const configByStepResult = getConfigByStepError(configByStep, configNames);
    if ("error" in configByStepResult) {
      res.status(400).json({ error: configByStepResult.error });
      return;
    }

    const resolvedConfigByStep = Object.fromEntries(
      TASK_STEPS.map((step) => [step, configByStepResult.value[step] ?? configName]),
    ) as Record<TaskStep, string>;

    const workItems = await getForge(repoSource).listWorkItems(repoFullName);
    const workItemsById = new Map(workItems.map((item) => [item.id, item]));

    const tasks: Task[] = [];
    const errors: Array<{ workItemId: string; error: string }> = [];

    for (const workItemId of workItemIds) {
      const workItem = workItemsById.get(workItemId);
      if (!workItem) {
        errors.push({ workItemId, error: "Work item not found among the repository's open items" });
        continue;
      }

      const existing = taskStore
        .list()
        .find(
          (task) =>
            isLive(task) &&
            task.repoSource === repoSource &&
            task.repoFullName === repoFullName &&
            task.workItem.id === workItemId,
        );
      if (existing) {
        errors.push({ workItemId, error: `Work item already has a live task (${existing.id})` });
        continue;
      }

      const now = new Date().toISOString();
      const task: Task = {
        id: crypto.randomUUID(),
        repoFullName,
        repoSource,
        workItem,
        configByStep: resolvedConfigByStep,
        phase: "spawning",
        reviewRequest: null,
        lastReviewedSha: null,
        activeContainerId: null,
        activeStep: null,
        attemptsByStep: Object.fromEntries(TASK_STEPS.map((step) => [step, 0])) as Record<TaskStep, number>,
        attempts: [],
        consecutiveErrors: 0,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      saveAndBroadcast(task);
      tasks.push(task);
    }

    const status = tasks.length === 0 ? 409 : errors.length > 0 ? 207 : 201;
    res.status(status).json({ tasks, errors });
  } catch (err) {
    console.error("Error creating tasks:", err);
    res.status(500).json({ error: "Failed to create tasks" });
  }
});

tasksRouter.patch("/api/tasks/:id", async (req, res) => {
  try {
    const task = taskStore.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const { phase, configByStep } = req.body as UpdateTaskRequest;

    if (phase === undefined && configByStep === undefined) {
      res.status(400).json({ error: "Provide phase or configByStep" });
      return;
    }

    if (phase !== undefined && phase !== "paused" && phase !== "resume") {
      res.status(400).json({ error: "phase must be 'paused' or 'resume'" });
      return;
    }

    if (configByStep !== undefined) {
      const configs = await loadConfigurations();
      const configNames = new Set(configs.configurations.map((c) => c.name));
      const result = getConfigByStepError(configByStep, configNames);
      if ("error" in result) {
        res.status(400).json({ error: result.error });
        return;
      }
      task.configByStep = { ...task.configByStep, ...result.value };
    }

    if (phase === "paused") {
      if (task.phase === "merged" || task.phase === "failed") {
        res.status(409).json({ error: `Cannot pause a ${task.phase} task` });
        return;
      }
      task.phase = "paused";
    }

    if (phase === "resume") {
      if (task.phase === "merged") {
        res.status(409).json({ error: "Cannot resume a merged task" });
        return;
      }
      if (task.phase === "failed") {
        task.attemptsByStep = Object.fromEntries(
          Object.keys(task.attemptsByStep).map((step) => [step, 0]),
        ) as Record<TaskStep, number>;
        task.error = null;
        task.consecutiveErrors = 0;
      } else if (task.phase !== "paused") {
        res.status(409).json({ error: `Cannot resume a task in phase '${task.phase}'` });
        return;
      }
      task.phase = task.activeContainerId ? "agent_running" : "spawning";
    }

    saveAndBroadcast(task);
    res.json(task);
  } catch (err) {
    console.error("Error updating task:", err);
    res.status(500).json({ error: "Failed to update task" });
  }
});

function isMissingContainerError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes("no such container") || message.includes("404");
}

tasksRouter.delete("/api/tasks/:id", async (req, res) => {
  try {
    const task = taskStore.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    if (task.activeContainerId) {
      try {
        await removeContainer(task.activeContainerId);
        broadcastRemoval(task.activeContainerId);
      } catch (err) {
        if (!isMissingContainerError(err)) throw err;
      }
    }

    taskStore.remove(task.id);
    broadcastTaskRemoved(task.id);
    res.status(204).send();
  } catch (err) {
    console.error("Error deleting task:", err);
    res.status(500).json({ error: "Failed to delete task" });
  }
});
