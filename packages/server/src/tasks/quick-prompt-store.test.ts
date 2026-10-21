import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuickPromptStore } from "./quick-prompt-store.js";
import type { TaskStep } from "../types.js";

const CONFIG_BY_STEP: Record<TaskStep, string> = {
  create_issue: "default",
  implement: "big",
  fix_ci: "default",
  rebase: "default",
  review: "default",
  address_comments: "default",
};

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "crc-quick-prompt-store-"));
}

describe("QuickPromptStore", () => {
  it("starts empty on a fresh state directory", () => {
    const store = new QuickPromptStore(join(makeStateDir(), "nested", "state"));
    assert.deepEqual(store.list("github", "owner/repo"), []);
  });

  it("adds, lists and removes quick-prompts in insertion order", () => {
    const store = new QuickPromptStore(makeStateDir());
    const first = store.add("github", "owner/repo", "Bump dependencies");
    const second = store.add("github", "owner/repo", "Fix flaky tests");

    assert.equal(first.text, "Bump dependencies");
    assert.ok(Number.isFinite(Date.parse(first.createdAt)));
    assert.notEqual(first.id, second.id);
    assert.deepEqual(store.list("github", "owner/repo"), [first, second]);

    assert.deepEqual(store.remove(first.id), first);
    assert.deepEqual(store.list("github", "owner/repo"), [second]);
  });

  it("returns null when removing or updating an unknown id", () => {
    const store = new QuickPromptStore(makeStateDir());
    const prompt = store.add("github", "owner/repo", "Bump dependencies");
    assert.equal(store.remove("missing"), null);
    assert.equal(store.update("missing", { perpetual: true }), null);
    assert.equal(store.get("missing"), null);
    assert.deepEqual(store.list("github", "owner/repo"), [prompt]);
  });

  it("persists across instances, including removals", () => {
    const stateDir = makeStateDir();
    const store = new QuickPromptStore(stateDir);
    const kept = store.add("github", "owner/repo", "Keep me");
    const removed = store.add("github", "owner/repo", "Remove me");
    const gitlab = store.add("gitlab", "group/sub/repo", "On GitLab");
    store.remove(removed.id);

    const reloaded = new QuickPromptStore(stateDir);
    assert.deepEqual(reloaded.list("github", "owner/repo"), [kept]);
    assert.deepEqual(reloaded.list("gitlab", "group/sub/repo"), [gitlab]);
  });

  it("isolates repositories by source and name", () => {
    const store = new QuickPromptStore(makeStateDir());
    const github = store.add("github", "owner/repo", "GitHub prompt");
    const gitlab = store.add("gitlab", "owner/repo", "GitLab prompt");
    const other = store.add("github", "owner/other", "Other prompt");

    assert.deepEqual(store.list("github", "owner/repo"), [github]);
    assert.deepEqual(store.list("gitlab", "owner/repo"), [gitlab]);
    assert.deepEqual(store.list("github", "owner/other"), [other]);
    assert.deepEqual(store.listAll(), [github, gitlab, other]);
  });

  it("records the repository and perpetual defaults on new quick-prompts", () => {
    const store = new QuickPromptStore(makeStateDir());
    const prompt = store.add("gitlab", "group/sub/repo", "Bump dependencies");
    assert.deepEqual(
      { ...prompt, id: "id", createdAt: "at" },
      {
        id: "id",
        repoSource: "gitlab",
        repoFullName: "group/sub/repo",
        text: "Bump dependencies",
        createdAt: "at",
        perpetual: false,
        configByStep: null,
        reviewRequestIds: [],
        lastLaunchedAt: null,
        error: null,
      },
    );
    assert.deepEqual(store.get(prompt.id), prompt);
  });

  it("updates a quick-prompt in place and persists the perpetual state across a restart", () => {
    const stateDir = makeStateDir();
    const store = new QuickPromptStore(stateDir);
    const first = store.add("github", "owner/repo", "First");
    const second = store.add("github", "owner/repo", "Second");

    const updated = store.update(first.id, {
      perpetual: true,
      configByStep: CONFIG_BY_STEP,
      reviewRequestIds: ["12"],
      lastLaunchedAt: "2026-08-20T12:00:00.000Z",
      error: "boom",
    });

    assert.deepEqual(updated, {
      ...first,
      perpetual: true,
      configByStep: CONFIG_BY_STEP,
      reviewRequestIds: ["12"],
      lastLaunchedAt: "2026-08-20T12:00:00.000Z",
      error: "boom",
    });
    assert.deepEqual(store.list("github", "owner/repo"), [updated, second]);

    const reloaded = new QuickPromptStore(stateDir);
    assert.deepEqual(reloaded.list("github", "owner/repo"), [updated, second]);
    assert.deepEqual(reloaded.get(first.id), updated);
  });

  it("migrates quick-prompts saved before perpetual prompts existed and keeps them after a restart", () => {
    const stateDir = makeStateDir();
    writeFileSync(
      join(stateDir, "quick-prompts.json"),
      JSON.stringify({
        "github:owner/repo": [{ id: "legacy-1", text: "Bump deps", createdAt: "2026-01-01T00:00:00.000Z" }],
        "gitlab:group/sub/repo": [{ id: "legacy-2", text: "On GitLab", createdAt: "2026-01-02T00:00:00.000Z" }],
      }),
      "utf-8",
    );

    const store = new QuickPromptStore(stateDir);
    const expected = {
      id: "legacy-1",
      repoSource: "github",
      repoFullName: "owner/repo",
      text: "Bump deps",
      createdAt: "2026-01-01T00:00:00.000Z",
      perpetual: false,
      configByStep: null,
      reviewRequestIds: [],
      lastLaunchedAt: null,
      error: null,
    };
    assert.deepEqual(store.list("github", "owner/repo"), [expected]);
    assert.equal(store.get("legacy-2")?.repoFullName, "group/sub/repo");
    assert.equal(store.get("legacy-2")?.repoSource, "gitlab");

    store.update("legacy-1", { perpetual: true, configByStep: CONFIG_BY_STEP });
    const reloaded = new QuickPromptStore(stateDir);
    assert.deepEqual(reloaded.get("legacy-1"), { ...expected, perpetual: true, configByStep: CONFIG_BY_STEP });
    assert.equal(reloaded.get("legacy-2")?.perpetual, false);
  });

  it("does not let callers mutate the stored list", () => {
    const store = new QuickPromptStore(makeStateDir());
    store.add("github", "owner/repo", "Bump dependencies");
    store.list("github", "owner/repo").pop();
    assert.equal(store.list("github", "owner/repo").length, 1);
  });

  it("leaves no staging files behind", () => {
    const stateDir = makeStateDir();
    new QuickPromptStore(stateDir).add("github", "owner/repo", "Bump dependencies");
    assert.deepEqual(readdirSync(stateDir), ["quick-prompts.json"]);
  });

  it("fails loudly on a malformed file", () => {
    const stateDir = makeStateDir();
    writeFileSync(join(stateDir, "quick-prompts.json"), "not json", "utf-8");
    assert.throws(() => new QuickPromptStore(stateDir));
  });

  it("fails loudly when the file is not an object", () => {
    const stateDir = makeStateDir();
    writeFileSync(join(stateDir, "quick-prompts.json"), "[]", "utf-8");
    assert.throws(() => new QuickPromptStore(stateDir), /expected a JSON object/);
  });

  it("fails loudly when a repository entry is not an array of quick-prompts", () => {
    const stateDir = makeStateDir();
    writeFileSync(join(stateDir, "quick-prompts.json"), JSON.stringify({ "github:owner/repo": [{ id: 1 }] }), "utf-8");
    assert.throws(() => new QuickPromptStore(stateDir), /'github:owner\/repo' must be an array of quick-prompts/);
  });

  it("fails loudly when a migrated quick-prompt has malformed new fields", () => {
    const base = { id: "p", text: "Prompt", createdAt: "2026-01-01T00:00:00.000Z" };
    for (const extra of [
      { perpetual: "yes" },
      { configByStep: { implement: "default" } },
      { reviewRequestIds: [12] },
      { lastLaunchedAt: 5 },
      { error: false },
      { repoFullName: "owner/elsewhere" },
      { repoSource: "gitlab" },
    ]) {
      const stateDir = makeStateDir();
      writeFileSync(
        join(stateDir, "quick-prompts.json"),
        JSON.stringify({ "github:owner/repo": [{ ...base, ...extra }] }),
        "utf-8",
      );
      assert.throws(
        () => new QuickPromptStore(stateDir),
        /'github:owner\/repo' must be an array of quick-prompts/,
        JSON.stringify(extra),
      );
    }
  });

  it("fails loudly when a key is not a repository", () => {
    const stateDir = makeStateDir();
    writeFileSync(join(stateDir, "quick-prompts.json"), JSON.stringify({ "owner/repo": [] }), "utf-8");
    assert.throws(() => new QuickPromptStore(stateDir), /'owner\/repo' is not a repository key/);
  });
});
