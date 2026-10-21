import { Router } from "express";
import type {
  CreateQuickPromptRequest,
  LaunchQuickPromptRequest,
  QuickPrompt,
  ResolvedConfigFile,
  Task,
  UpdateQuickPromptRequest,
} from "../types.js";
import { parseRepo } from "../validation.js";
import { findMissingConfig, findUnfinishedInstance, makeNewTask, parseConfigByStep, resolveConfigByStep } from "./new-task.js";
import type { QuickPromptStore } from "./quick-prompt-store.js";
import type { TaskStore } from "./store.js";

export interface QuickPromptRouteDeps {
  quickPrompts: QuickPromptStore;
  tasks: TaskStore;
  loadConfigurations(): Promise<ResolvedConfigFile>;
  broadcastQuickPromptUpdated(prompt: QuickPrompt): void;
  broadcastQuickPromptRemoved(id: string): void;
  broadcastTaskUpdated(task: Task): void;
  now(): Date;
}

async function loadConfigNames(deps: QuickPromptRouteDeps): Promise<Set<string>> {
  return new Set((await deps.loadConfigurations()).configurations.map((c) => c.name));
}

export function createQuickPromptsRouter(deps: QuickPromptRouteDeps): Router {
  const router = Router();
  const store = deps.quickPrompts;

  router.get("/api/quick-prompts", (req, res) => {
    if (req.query.repoSource === undefined && req.query.repoFullName === undefined) {
      res.json(store.listAll());
      return;
    }
    const repo = parseRepo(req.query.repoSource, req.query.repoFullName);
    if ("error" in repo) {
      res.status(400).json({ error: repo.error });
      return;
    }
    res.json(store.list(repo.repoSource, repo.repoFullName));
  });

  router.post("/api/quick-prompts", (req, res) => {
    const { repoSource, repoFullName, text } = req.body as CreateQuickPromptRequest;
    const repo = parseRepo(repoSource, repoFullName);
    if ("error" in repo) {
      res.status(400).json({ error: repo.error });
      return;
    }

    if (typeof text !== "string" || text.trim() === "") {
      res.status(400).json({ error: "text must be a non-empty string" });
      return;
    }

    const trimmed = text.trim();
    if (store.list(repo.repoSource, repo.repoFullName).some((prompt) => prompt.text === trimmed)) {
      res.status(409).json({ error: "This quick-prompt already exists for the repository" });
      return;
    }

    const prompt = store.add(repo.repoSource, repo.repoFullName, trimmed);
    deps.broadcastQuickPromptUpdated(prompt);
    res.status(201).json(prompt);
  });

  router.patch("/api/quick-prompts/:id", async (req, res) => {
    try {
      const prompt = store.get(req.params.id);
      if (!prompt) {
        res.status(404).json({ error: "Quick-prompt not found" });
        return;
      }

      const { perpetual, configName, configByStep } = req.body as UpdateQuickPromptRequest;
      if (perpetual === undefined && configName === undefined && configByStep === undefined) {
        res.status(400).json({ error: "Provide perpetual, configName or configByStep" });
        return;
      }
      if (perpetual !== undefined && typeof perpetual !== "boolean") {
        res.status(400).json({ error: "perpetual must be a boolean" });
        return;
      }

      const configNames = await loadConfigNames(deps);
      let nextConfigByStep = prompt.configByStep;
      if (configName !== undefined) {
        const resolved = resolveConfigByStep(configName, configByStep, configNames);
        if ("error" in resolved) {
          res.status(400).json({ error: resolved.error });
          return;
        }
        nextConfigByStep = resolved.value;
      } else if (configByStep !== undefined) {
        if (prompt.configByStep === null) {
          res.status(400).json({ error: "configName is required when the quick-prompt has no stored configuration" });
          return;
        }
        const overrides = parseConfigByStep(configByStep, configNames);
        if ("error" in overrides) {
          res.status(400).json({ error: overrides.error });
          return;
        }
        nextConfigByStep = { ...prompt.configByStep, ...overrides.value };
      }

      const nextPerpetual = perpetual ?? prompt.perpetual;
      if (nextPerpetual) {
        if (nextConfigByStep === null) {
          res.status(400).json({ error: "configName is required to make a quick-prompt perpetual" });
          return;
        }
        const missingConfig = findMissingConfig(nextConfigByStep, configNames);
        if (missingConfig !== null) {
          res.status(400).json({ error: missingConfig });
          return;
        }
      }

      const updated = store.update(prompt.id, { perpetual: nextPerpetual, configByStep: nextConfigByStep, error: null });
      if (!updated) throw new Error(`Quick-prompt ${prompt.id} disappeared while it was being updated`);
      deps.broadcastQuickPromptUpdated(updated);
      res.json(updated);
    } catch (err) {
      console.error("Error updating quick-prompt:", err);
      res.status(500).json({ error: "Failed to update quick-prompt" });
    }
  });

  router.post("/api/quick-prompts/:id/tasks", async (req, res) => {
    try {
      const prompt = store.get(req.params.id);
      if (!prompt) {
        res.status(404).json({ error: "Quick-prompt not found" });
        return;
      }

      const { configName, configByStep } = req.body as LaunchQuickPromptRequest;
      const resolved = resolveConfigByStep(configName, configByStep, await loadConfigNames(deps));
      if ("error" in resolved) {
        res.status(400).json({ error: resolved.error });
        return;
      }

      const unfinished = prompt.perpetual ? findUnfinishedInstance(deps.tasks, prompt.id) : null;
      if (unfinished) {
        res.status(409).json({
          error: `This perpetual quick-prompt already has an unfinished task (${unfinished.id}, ${unfinished.phase}); resume or delete it first`,
        });
        return;
      }

      const now = deps.now();
      const task = makeNewTask(
        prompt.repoFullName,
        prompt.repoSource,
        resolved.value,
        { sourceText: prompt.text, quickPromptId: prompt.id },
        now,
      );
      deps.tasks.save(task);
      deps.broadcastTaskUpdated(task);

      const updated = store.update(prompt.id, {
        configByStep: resolved.value,
        lastLaunchedAt: now.toISOString(),
        error: null,
      });
      if (!updated) throw new Error(`Quick-prompt ${prompt.id} disappeared while it was being launched`);
      deps.broadcastQuickPromptUpdated(updated);
      res.status(201).json(task);
    } catch (err) {
      console.error("Error launching quick-prompt:", err);
      res.status(500).json({ error: "Failed to launch quick-prompt" });
    }
  });

  router.delete("/api/quick-prompts/:id", (req, res) => {
    if (!store.remove(req.params.id)) {
      res.status(404).json({ error: "Quick-prompt not found" });
      return;
    }
    deps.broadcastQuickPromptRemoved(req.params.id);
    res.status(204).send();
  });

  return router;
}
