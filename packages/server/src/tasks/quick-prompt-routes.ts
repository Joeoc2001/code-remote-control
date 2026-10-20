import { Router } from "express";
import type { CreateQuickPromptRequest, RepoSource } from "../types.js";
import { getRepoNameError, isValidRepoSource } from "../validation.js";
import type { QuickPromptStore } from "./quick-prompt-store.js";

function parseRepo(
  repoSource: unknown,
  repoFullName: unknown,
): { error: string } | { repoSource: RepoSource; repoFullName: string } {
  if (typeof repoFullName !== "string" || repoFullName === "") {
    return { error: "repoFullName is required" };
  }
  if (!isValidRepoSource(repoSource)) {
    return { error: "repoSource must be 'github' or 'gitlab'" };
  }
  const repoNameError = getRepoNameError(repoFullName, repoSource);
  if (repoNameError) return { error: repoNameError };
  return { repoSource, repoFullName };
}

export function createQuickPromptsRouter(store: QuickPromptStore): Router {
  const router = Router();

  router.get("/api/quick-prompts", (req, res) => {
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

    res.status(201).json(store.add(repo.repoSource, repo.repoFullName, trimmed));
  });

  router.delete("/api/quick-prompts/:id", (req, res) => {
    const repo = parseRepo(req.query.repoSource, req.query.repoFullName);
    if ("error" in repo) {
      res.status(400).json({ error: repo.error });
      return;
    }

    if (!store.remove(repo.repoSource, repo.repoFullName, req.params.id)) {
      res.status(404).json({ error: "Quick-prompt not found" });
      return;
    }
    res.status(204).send();
  });

  return router;
}
