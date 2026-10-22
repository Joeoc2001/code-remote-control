import { Router } from "express";
import { loadConfigurations } from "../config.js";
import { broadcastRemoval, removeContainerIfPresent } from "../docker.js";
import { getForge } from "../forge/index.js";
import type { CreateTaskFromTextRequest, CreateTasksRequest, Task, TaskStep, UpdateTaskRequest } from "../types.js";
import { parseRepo } from "../validation.js";
import { makeNewTask, parseConfigByStep, resolveConfigByStep } from "./new-task.js";
import { resumeTask, type ResumeDeps } from "./resume.js";
import { broadcastTaskRemoved, broadcastTaskUpdated, taskStore } from "./runtime.js";

export const tasksRouter = Router();

const MAX_BULK_WORK_ITEMS = 25;

const resumeDeps: ResumeDeps = {
  removeContainer: async (id) => {
    await removeContainerIfPresent(id);
    broadcastRemoval(id);
  },
  now: () => new Date(),
};

function isLive(task: Task): boolean {
  return task.phase !== "merged" && task.phase !== "failed";
}

function saveAndBroadcast(task: Task): void {
  taskStore.save(task);
  broadcastTaskUpdated(task);
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

    const repo = parseRepo(repoSource, repoFullName);
    if ("error" in repo) {
      res.status(400).json({ error: repo.error });
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
    const configByStepResult = resolveConfigByStep(configName, configByStep, configNames);
    if ("error" in configByStepResult) {
      res.status(400).json({ error: configByStepResult.error });
      return;
    }
    const resolvedConfigByStep = configByStepResult.value;

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
            task.workItem?.id === workItemId,
        );
      if (existing) {
        errors.push({ workItemId, error: `Work item already has a live task (${existing.id})` });
        continue;
      }

      const task = makeNewTask(repoFullName, repoSource, resolvedConfigByStep, { workItem }, new Date());
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

tasksRouter.post("/api/tasks/from-text", async (req, res) => {
  try {
    const { repoFullName, repoSource, text, configName, configByStep } = req.body as CreateTaskFromTextRequest;

    if (!repoFullName || !configName || typeof text !== "string") {
      res.status(400).json({ error: "repoFullName, configName, and text are required" });
      return;
    }

    const repo = parseRepo(repoSource, repoFullName);
    if ("error" in repo) {
      res.status(400).json({ error: repo.error });
      return;
    }

    const sourceText = text.trim();
    if (sourceText === "") {
      res.status(400).json({ error: "text must not be empty" });
      return;
    }

    const configs = await loadConfigurations();
    const configNames = new Set(configs.configurations.map((c) => c.name));
    const configByStepResult = resolveConfigByStep(configName, configByStep, configNames);
    if ("error" in configByStepResult) {
      res.status(400).json({ error: configByStepResult.error });
      return;
    }
    const resolvedConfigByStep = configByStepResult.value;

    const task = makeNewTask(
      repoFullName,
      repoSource,
      resolvedConfigByStep,
      { sourceText, quickPromptId: null },
      new Date(),
    );
    saveAndBroadcast(task);
    res.status(201).json(task);
  } catch (err) {
    console.error("Error creating task from text:", err);
    res.status(500).json({ error: "Failed to create task from text" });
  }
});

tasksRouter.patch("/api/tasks/:id", async (req, res) => {
  try {
    const task = taskStore.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const { phase, configByStep, discardContainer } = req.body as UpdateTaskRequest;

    if (phase === undefined && configByStep === undefined) {
      res.status(400).json({ error: "Provide phase or configByStep" });
      return;
    }

    if (phase !== undefined && phase !== "paused" && phase !== "resume") {
      res.status(400).json({ error: "phase must be 'paused' or 'resume'" });
      return;
    }

    if (discardContainer !== undefined && typeof discardContainer !== "boolean") {
      res.status(400).json({ error: "discardContainer must be a boolean" });
      return;
    }

    if (discardContainer && phase !== "resume") {
      res.status(400).json({ error: "discardContainer requires phase 'resume'" });
      return;
    }

    if (discardContainer && !task.activeContainerId) {
      res.status(409).json({ error: "Task has no agent container to discard" });
      return;
    }

    if (phase === "paused" && (task.phase === "merged" || task.phase === "failed")) {
      res.status(409).json({ error: `Cannot pause a ${task.phase} task` });
      return;
    }

    if (phase === "resume" && task.phase !== "failed" && task.phase !== "paused") {
      res.status(409).json({ error: `Cannot resume a task in phase '${task.phase}'` });
      return;
    }

    let configByStepPatch: Partial<Record<TaskStep, string>> = {};
    if (configByStep !== undefined) {
      const configs = await loadConfigurations();
      const configNames = new Set(configs.configurations.map((c) => c.name));
      const result = parseConfigByStep(configByStep, configNames);
      if ("error" in result) {
        res.status(400).json({ error: result.error });
        return;
      }
      configByStepPatch = result.value;
    }

    task.configByStep = { ...task.configByStep, ...configByStepPatch };

    if (phase === "paused") {
      task.phase = "paused";
    }

    if (phase === "resume") {
      await resumeTask(resumeDeps, task, discardContainer === true);
    }

    saveAndBroadcast(task);
    res.json(task);
  } catch (err) {
    console.error("Error updating task:", err);
    res.status(500).json({ error: "Failed to update task" });
  }
});

tasksRouter.delete("/api/tasks", async (req, res) => {
  try {
    if (req.query.phase !== "merged") {
      res.status(400).json({ error: "phase=merged is required" });
      return;
    }

    const merged = taskStore.list().filter((task) => task.phase === "merged");
    const errors: Array<{ id: string; error: string }> = [];

    for (const task of merged) {
      try {
        if (task.activeContainerId) {
          await removeContainerIfPresent(task.activeContainerId);
          broadcastRemoval(task.activeContainerId);
        }
        taskStore.remove(task.id);
        broadcastTaskRemoved(task.id);
      } catch (err) {
        errors.push({ id: task.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (errors.length > 0) {
      console.error("Some merged tasks failed to delete:", errors);
      res.status(207).json({ removed: merged.length - errors.length, errors });
      return;
    }

    res.status(204).send();
  } catch (err) {
    console.error("Error deleting merged tasks:", err);
    res.status(500).json({ error: "Failed to delete merged tasks" });
  }
});

tasksRouter.delete("/api/tasks/:id", async (req, res) => {
  try {
    const task = taskStore.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    if (task.activeContainerId) {
      await removeContainerIfPresent(task.activeContainerId);
      broadcastRemoval(task.activeContainerId);
    }

    taskStore.remove(task.id);
    broadcastTaskRemoved(task.id);
    res.status(204).send();
  } catch (err) {
    console.error("Error deleting task:", err);
    res.status(500).json({ error: "Failed to delete task" });
  }
});
