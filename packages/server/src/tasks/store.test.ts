import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./store.js";
import { makeTask } from "../testing/fixtures.js";

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "crc-task-store-"));
}

describe("TaskStore", () => {
  it("starts empty on a fresh state directory and creates it", () => {
    const stateDir = join(makeStateDir(), "nested", "state");
    const store = new TaskStore(stateDir);
    assert.deepEqual(store.list(), []);
    assert.ok(existsSync(join(stateDir, "task-logs")));
  });

  it("persists tasks across instances", () => {
    const stateDir = makeStateDir();
    const store = new TaskStore(stateDir);
    const task = makeTask();
    store.save(task);

    const reloaded = new TaskStore(stateDir);
    assert.deepEqual(reloaded.get(task.id), task);
    assert.equal(reloaded.list().length, 1);
  });

  it("stamps updatedAt on save", () => {
    const store = new TaskStore(makeStateDir());
    const task = makeTask({ updatedAt: "2000-01-01T00:00:00.000Z" });
    store.save(task);
    assert.notEqual(task.updatedAt, "2000-01-01T00:00:00.000Z");
    assert.ok(Number.isFinite(Date.parse(task.updatedAt)));
  });

  it("leaves no staging files behind", () => {
    const stateDir = makeStateDir();
    const store = new TaskStore(stateDir);
    store.save(makeTask());
    const leftovers = readdirSync(stateDir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("removes a task together with its captured logs", () => {
    const stateDir = makeStateDir();
    const store = new TaskStore(stateDir);
    const task = makeTask();
    store.save(task);
    store.writeAttemptLog(task.id, 0, "some output");

    store.remove(task.id);

    assert.equal(store.get(task.id), null);
    assert.equal(store.readAttemptLog(task.id, 0), null);
    assert.deepEqual(new TaskStore(stateDir).list(), []);
  });

  it("round-trips attempt logs and returns null for missing ones", () => {
    const store = new TaskStore(makeStateDir());
    store.writeAttemptLog("task-1", 2, "line one\nline two\n");
    assert.equal(store.readAttemptLog("task-1", 2), "line one\nline two\n");
    assert.equal(store.readAttemptLog("task-1", 3), null);
    assert.equal(store.readAttemptLog("other-task", 0), null);
  });

  it("migrates tasks saved before multi-stage tasks existed", () => {
    const stateDir = makeStateDir();
    const { completedStages: _stages, stageStartedAt: _startedAt, mergedAt: _mergedAt, ...legacy } = makeTask({
      createdAt: "2026-01-02T03:04:05.000Z",
    });
    writeFileSync(join(stateDir, "tasks.json"), JSON.stringify([legacy]), "utf-8");

    const task = new TaskStore(stateDir).get(legacy.id);

    assert.deepEqual(task?.completedStages, []);
    assert.equal(task?.stageStartedAt, "2026-01-02T03:04:05.000Z");
    assert.equal(task?.mergedAt, null);
    assert.equal(task?.repoFullName, legacy.repoFullName);
  });

  it("migrates tasks saved before quick-prompt links existed", () => {
    const stateDir = makeStateDir();
    const { quickPromptId: _quickPromptId, ...legacy } = makeTask();
    writeFileSync(join(stateDir, "tasks.json"), JSON.stringify([legacy]), "utf-8");

    assert.equal(new TaskStore(stateDir).get(legacy.id)?.quickPromptId, null);
  });

  it("persists a task's quick-prompt link across instances", () => {
    const stateDir = makeStateDir();
    new TaskStore(stateDir).save(makeTask({ quickPromptId: "prompt-1" }));
    assert.equal(new TaskStore(stateDir).get("task-1")?.quickPromptId, "prompt-1");
  });

  it("fails loudly on a task with a malformed quick-prompt link", () => {
    const stateDir = makeStateDir();
    writeFileSync(join(stateDir, "tasks.json"), JSON.stringify([{ ...makeTask(), quickPromptId: 7 }]), "utf-8");
    assert.throws(() => new TaskStore(stateDir), /task task-1 has an invalid quickPromptId/);
  });

  it("fails loudly on a task with malformed stage fields", () => {
    const stateDir = makeStateDir();
    writeFileSync(join(stateDir, "tasks.json"), JSON.stringify([{ ...makeTask(), completedStages: "nope" }]), "utf-8");
    assert.throws(() => new TaskStore(stateDir), /task task-1 has invalid stage fields/);
  });

  it("fails loudly on a malformed tasks file", () => {
    const stateDir = makeStateDir();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "tasks.json"), "not json", "utf-8");
    assert.throws(() => new TaskStore(stateDir));
  });

  it("fails loudly when the tasks file is not an array", () => {
    const stateDir = makeStateDir();
    writeFileSync(join(stateDir, "tasks.json"), "{}", "utf-8");
    assert.throws(() => new TaskStore(stateDir), /expected a JSON array/);
  });
});
