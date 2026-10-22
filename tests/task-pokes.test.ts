import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Task, TaskAttempt } from "@crc/shared";
import { startClientApp, type ClientAppHarness } from "./helpers/client-app-harness.js";
import { makeTask } from "./helpers/task-fixture.js";

function attempt(overrides: Partial<TaskAttempt>): TaskAttempt {
  return {
    step: "implement",
    containerId: null,
    headShaBefore: null,
    diffHashBefore: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:10:00.000Z",
    finishedObservation: null,
    error: null,
    pokeCount: 0,
    lastPokedAt: null,
    resumedAt: null,
    ...overrides,
  };
}

const lastPokedAt = new Date(Date.now() - 10 * 60_000 - 5_000).toISOString();

const pokedTask: Task = {
  ...makeTask("p", "agent_running", "2026-01-01T00:00:00.000Z"),
  activeContainerId: "c0ffee",
  activeStep: "fix_ci",
  attempts: [
    attempt({ step: "implement" }),
    attempt({
      step: "fix_ci",
      containerId: "c0ffee",
      startedAt: "2026-01-01T01:00:00.000Z",
      finishedAt: null,
      pokeCount: 3,
      lastPokedAt,
    }),
  ],
};

describe("stall pokes in the task view", () => {
  let harness: ClientAppHarness;

  before(async () => {
    harness = await startClientApp({
      "/api/tasks": [pokedTask],
      "/api/tasks/p": pokedTask,
    });
  });

  after(async () => {
    await harness.stop();
  });

  test("shows how often and how recently a stalled attempt was poked, and nothing for an attempt never poked", async () => {
    const page = await harness.browser.newPage();
    try {
      await page.goto(`${harness.origin}/tasks/p`, { waitUntil: "networkidle" });
      const rows = page.locator("li", { hasText: /^#\d/ });
      await rows.first().waitFor({ timeout: 10_000 });

      const pokedRow = page.locator("li", { hasText: "#2" });
      assert.equal(await pokedRow.getByText("Poked 3× · last 10 min ago", { exact: true }).isVisible(), true);

      const quietRow = page.locator("li", { hasText: "#1" });
      assert.equal(await quietRow.getByText(/Poked/).count(), 0);
      assert.deepEqual(harness.unstubbedRequests, []);
    } finally {
      await page.close();
    }
  });
});
