import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TaskPhase } from "@crc/shared";
import { sortTasks } from "../packages/client/src/components/taskOrder.js";
import { makeTask } from "./helpers/task-fixture.js";

const ids = (tasks: { id: string }[]) => tasks.map((task) => task.id);

describe("sortTasks", () => {
  test("puts failed tasks first, then tasks waiting for approval, then everything else", () => {
    const phases: TaskPhase[] = [
      "spawning",
      "agent_running",
      "waiting_ci",
      "waiting_approval",
      "merging",
      "merged",
      "failed",
      "paused",
    ];
    const tasks = phases.map((phase) => makeTask(phase, phase, "2026-01-01T00:00:00.000Z"));

    const sorted = sortTasks(tasks);

    assert.deepEqual(ids(sorted.slice(0, 2)), ["failed", "waiting_approval"]);
    assert.deepEqual(
      new Set(ids(sorted.slice(2))),
      new Set(["spawning", "agent_running", "waiting_ci", "merging", "merged", "paused"]),
    );
  });

  test("orders tasks within each group newest first", () => {
    const tasks = [
      makeTask("old-running", "agent_running", "2026-01-01T00:00:00.000Z"),
      makeTask("old-failed", "failed", "2026-01-01T00:00:00.000Z"),
      makeTask("new-approval", "waiting_approval", "2026-01-03T00:00:00.000Z"),
      makeTask("new-merged", "merged", "2026-01-03T00:00:00.000Z"),
      makeTask("new-failed", "failed", "2026-01-03T00:00:00.000Z"),
      makeTask("old-approval", "waiting_approval", "2026-01-01T00:00:00.000Z"),
      makeTask("mid-paused", "paused", "2026-01-02T00:00:00.000Z"),
    ];

    assert.deepEqual(ids(sortTasks(tasks)), [
      "new-failed",
      "old-failed",
      "new-approval",
      "old-approval",
      "new-merged",
      "mid-paused",
      "old-running",
    ]);
  });

  test("ignores updatedAt so cards do not move when an update lands", () => {
    const older = makeTask("older", "agent_running", "2026-01-01T00:00:00.000Z");
    const newer = makeTask("newer", "agent_running", "2026-01-02T00:00:00.000Z");
    older.updatedAt = "2026-02-01T00:00:00.000Z";

    assert.deepEqual(ids(sortTasks([older, newer])), ["newer", "older"]);
  });

  test("does not mutate its input", () => {
    const tasks = [
      makeTask("running", "agent_running", "2026-01-01T00:00:00.000Z"),
      makeTask("failed", "failed", "2026-01-01T00:00:00.000Z"),
    ];

    sortTasks(tasks);

    assert.deepEqual(ids(tasks), ["running", "failed"]);
  });
});
