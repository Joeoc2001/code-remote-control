import crypto from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QuickPrompt, RepoSource } from "../types.js";

function repoKey(repoSource: RepoSource, repoFullName: string): string {
  return `${repoSource}:${repoFullName}`;
}

function isQuickPrompt(value: unknown): value is QuickPrompt {
  if (typeof value !== "object" || value === null) return false;
  const { id, text, createdAt } = value as Record<string, unknown>;
  return typeof id === "string" && typeof text === "string" && typeof createdAt === "string";
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
      for (const [key, prompts] of Object.entries(parsed)) {
        if (!Array.isArray(prompts) || !prompts.every(isQuickPrompt)) {
          throw new Error(
            `Quick-prompt store file ${this.promptsPath} is malformed: '${key}' must be an array of quick-prompts`,
          );
        }
        this.promptsByRepo.set(key, prompts);
      }
    }
  }

  list(repoSource: RepoSource, repoFullName: string): QuickPrompt[] {
    return [...(this.promptsByRepo.get(repoKey(repoSource, repoFullName)) ?? [])];
  }

  add(repoSource: RepoSource, repoFullName: string, text: string): QuickPrompt {
    const prompt: QuickPrompt = { id: crypto.randomUUID(), text, createdAt: new Date().toISOString() };
    const key = repoKey(repoSource, repoFullName);
    this.promptsByRepo.set(key, [...(this.promptsByRepo.get(key) ?? []), prompt]);
    this.persist();
    return prompt;
  }

  remove(repoSource: RepoSource, repoFullName: string, id: string): boolean {
    const key = repoKey(repoSource, repoFullName);
    const prompts = this.promptsByRepo.get(key) ?? [];
    const remaining = prompts.filter((prompt) => prompt.id !== id);
    if (remaining.length === prompts.length) return false;

    if (remaining.length === 0) {
      this.promptsByRepo.delete(key);
    } else {
      this.promptsByRepo.set(key, remaining);
    }
    this.persist();
    return true;
  }

  private persist(): void {
    const stagingPath = `${this.promptsPath}.${process.pid}.tmp`;
    const contents = Object.fromEntries(this.promptsByRepo);
    writeFileSync(stagingPath, `${JSON.stringify(contents, null, 2)}\n`, "utf-8");
    renameSync(stagingPath, this.promptsPath);
  }
}
