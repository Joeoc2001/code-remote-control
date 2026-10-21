import crypto from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TASK_STEPS } from "../types.js";
import type { QuickPrompt, RepoSource, TaskStep } from "../types.js";
import { parseRepo } from "../validation.js";

export type QuickPromptPatch = Partial<
  Pick<QuickPrompt, "perpetual" | "configByStep" | "reviewRequestIds" | "lastLaunchedAt" | "error">
>;

function repoKey(repoSource: RepoSource, repoFullName: string): string {
  return `${repoSource}:${repoFullName}`;
}

function parseRepoKey(key: string): { repoSource: RepoSource; repoFullName: string } | null {
  const separator = key.indexOf(":");
  if (separator === -1) return null;
  const repo = parseRepo(key.slice(0, separator), key.slice(separator + 1));
  return "error" in repo ? null : repo;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isConfigByStep(value: unknown): value is Record<TaskStep, string> | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === TASK_STEPS.length &&
    TASK_STEPS.every((step) => typeof record[step] === "string")
  );
}

function migrateQuickPrompt(
  value: unknown,
  repo: { repoSource: RepoSource; repoFullName: string },
): QuickPrompt | null {
  if (typeof value !== "object" || value === null) return null;
  const stored = value as Record<string, unknown>;
  const prompt: Record<string, unknown> = {
    ...stored,
    repoSource: stored.repoSource ?? repo.repoSource,
    repoFullName: stored.repoFullName ?? repo.repoFullName,
    perpetual: stored.perpetual ?? false,
    configByStep: stored.configByStep ?? null,
    reviewRequestIds: stored.reviewRequestIds ?? [],
    lastLaunchedAt: stored.lastLaunchedAt ?? null,
    error: stored.error ?? null,
  };
  const valid =
    typeof prompt.id === "string" &&
    typeof prompt.text === "string" &&
    typeof prompt.createdAt === "string" &&
    prompt.repoSource === repo.repoSource &&
    prompt.repoFullName === repo.repoFullName &&
    typeof prompt.perpetual === "boolean" &&
    isConfigByStep(prompt.configByStep) &&
    Array.isArray(prompt.reviewRequestIds) &&
    prompt.reviewRequestIds.every((id: unknown) => typeof id === "string") &&
    isNullableString(prompt.lastLaunchedAt) &&
    isNullableString(prompt.error);
  return valid ? (prompt as unknown as QuickPrompt) : null;
}

export class QuickPromptStore {
  private readonly promptsByRepo = new Map<string, QuickPrompt[]>();
  private readonly promptsPath: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.promptsPath = join(stateDir, "quick-prompts.json");

    let raw: string | null = null;
    try {
      raw = readFileSync(this.promptsPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Quick-prompt store file ${this.promptsPath} is malformed: expected a JSON object`);
      }
      for (const [key, stored] of Object.entries(parsed)) {
        const repo = parseRepoKey(key);
        if (repo === null) {
          throw new Error(`Quick-prompt store file ${this.promptsPath} is malformed: '${key}' is not a repository key`);
        }
        const prompts = Array.isArray(stored) ? stored.map((value) => migrateQuickPrompt(value, repo)) : null;
        if (prompts === null || prompts.some((prompt) => prompt === null)) {
          throw new Error(
            `Quick-prompt store file ${this.promptsPath} is malformed: '${key}' must be an array of quick-prompts`,
          );
        }
        this.promptsByRepo.set(key, prompts as QuickPrompt[]);
      }
    }
  }

  list(repoSource: RepoSource, repoFullName: string): QuickPrompt[] {
    return [...(this.promptsByRepo.get(repoKey(repoSource, repoFullName)) ?? [])];
  }

  listAll(): QuickPrompt[] {
    return [...this.promptsByRepo.values()].flat();
  }

  get(id: string): QuickPrompt | null {
    return this.listAll().find((prompt) => prompt.id === id) ?? null;
  }

  add(repoSource: RepoSource, repoFullName: string, text: string): QuickPrompt {
    const prompt: QuickPrompt = {
      id: crypto.randomUUID(),
      repoSource,
      repoFullName,
      text,
      createdAt: new Date().toISOString(),
      perpetual: false,
      configByStep: null,
      reviewRequestIds: [],
      lastLaunchedAt: null,
      error: null,
    };
    const key = repoKey(repoSource, repoFullName);
    this.promptsByRepo.set(key, [...(this.promptsByRepo.get(key) ?? []), prompt]);
    this.persist();
    return prompt;
  }

  update(id: string, patch: QuickPromptPatch): QuickPrompt | null {
    const existing = this.get(id);
    if (!existing) return null;

    const updated: QuickPrompt = { ...existing, ...patch };
    const key = repoKey(existing.repoSource, existing.repoFullName);
    this.promptsByRepo.set(
      key,
      this.list(existing.repoSource, existing.repoFullName).map((prompt) => (prompt.id === id ? updated : prompt)),
    );
    this.persist();
    return updated;
  }

  remove(id: string): QuickPrompt | null {
    const existing = this.get(id);
    if (!existing) return null;

    const key = repoKey(existing.repoSource, existing.repoFullName);
    const remaining = this.list(existing.repoSource, existing.repoFullName).filter((prompt) => prompt.id !== id);
    if (remaining.length === 0) {
      this.promptsByRepo.delete(key);
    } else {
      this.promptsByRepo.set(key, remaining);
    }
    this.persist();
    return existing;
  }

  private persist(): void {
    const stagingPath = `${this.promptsPath}.${process.pid}.tmp`;
    const contents = Object.fromEntries(this.promptsByRepo);
    writeFileSync(stagingPath, `${JSON.stringify(contents, null, 2)}\n`, "utf-8");
    renameSync(stagingPath, this.promptsPath);
  }
}
