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
    isMaterial: null,
    closureNotice: null,
    ...overrides,
  };
}

const SENT_AT = "2026-01-01T00:09:00.000Z";

const task: Task = {
  ...makeTask("c", "waiting_ci", "2026-01-01T00:00:00.000Z"),
  attempts: [
    attempt({ step: "implement", closureNotice: { closesWorkItem: true, sentAt: SENT_AT } }),
    attempt({ step: "review", startedAt: "2026-01-01T01:00:00.000Z", finishedAt: "2026-01-01T01:05:00.000Z" }),
    attempt({
      step: "implement",
      startedAt: "2026-01-01T02:00:00.000Z",
      finishedAt: "2026-01-01T02:05:00.000Z",
      closureNotice: { closesWorkItem: false, sentAt: SENT_AT },
    }),
  ],
};

describe("closure notices in the task view", () => {
  let harness: ClientAppHarness;

  before(async () => {
    harness = await startClientApp({ "/api/tasks": [task], "/api/tasks/c": task });
  });

  after(async () => {
    await harness.stop();
  });

  test("shows what each implement agent was told about closing the issue, and nothing for an attempt never told", async () => {
    const page = await harness.browser.newPage();
    try {
      await page.goto(`${harness.origin}/tasks/c`, { waitUntil: "networkidle" });
      await page.locator("li", { hasText: /^#\d/ }).first().waitFor({ timeout: 10_000 });

      const closesChip = page.locator("li", { hasText: "#1" }).getByText("Told: closes issue", { exact: true });
      assert.equal(await closesChip.isVisible(), true);
      const closesTitle = await closesChip.getAttribute("title");
      assert.match(closesTitle ?? "", /its PR\/MR will close the issue when merged/);
      assert.match(closesTitle ?? "", /2026/);

      assert.equal(await page.locator("li", { hasText: "#2" }).getByText(/Told:/).count(), 0);

      const leavesOpenChip = page.locator("li", { hasText: "#3" }).getByText("Told: leaves issue open", { exact: true });
      assert.equal(await leavesOpenChip.isVisible(), true);
      assert.match((await leavesOpenChip.getAttribute("title")) ?? "", /its PR\/MR will not close the issue when merged/);

      assert.deepEqual(harness.unstubbedRequests, []);
    } finally {
      await page.close();
    }
  });
});
