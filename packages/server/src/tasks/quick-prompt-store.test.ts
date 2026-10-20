import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuickPromptStore } from "./quick-prompt-store.js";

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

    assert.equal(store.remove("github", "owner/repo", first.id), true);
    assert.deepEqual(store.list("github", "owner/repo"), [second]);
  });

  it("returns false when removing an unknown id", () => {
    const store = new QuickPromptStore(makeStateDir());
    const prompt = store.add("github", "owner/repo", "Bump dependencies");
    assert.equal(store.remove("github", "owner/repo", "missing"), false);
    assert.equal(store.remove("github", "owner/other", prompt.id), false);
    assert.deepEqual(store.list("github", "owner/repo"), [prompt]);
  });

  it("persists across instances, including removals", () => {
    const stateDir = makeStateDir();
    const store = new QuickPromptStore(stateDir);
    const kept = store.add("github", "owner/repo", "Keep me");
    const removed = store.add("github", "owner/repo", "Remove me");
    const gitlab = store.add("gitlab", "group/sub/repo", "On GitLab");
    store.remove("github", "owner/repo", removed.id);

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
    assert.equal(store.remove("gitlab", "owner/repo", github.id), false);
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
});
