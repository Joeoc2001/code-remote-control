import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { startClientApp, type ClientAppHarness } from "./helpers/client-app-harness.js";
import { makeTask } from "./helpers/task-fixture.js";

const TASKS = [
  makeTask("1", "agent_running", "2026-01-01T00:00:00.000Z"),
  makeTask("2", "failed", "2026-01-02T00:00:00.000Z"),
  makeTask("3", "merged", "2026-01-03T00:00:00.000Z"),
  makeTask("4", "waiting_approval", "2026-01-04T00:00:00.000Z"),
  makeTask("5", "waiting_ci", "2026-01-05T00:00:00.000Z"),
  makeTask("6", "failed", "2026-01-06T00:00:00.000Z"),
];

describe("tasks page order", () => {
  let harness: ClientAppHarness;

  before(async () => {
    harness = await startClientApp({ "/api/tasks": TASKS });
  });

  after(async () => {
    await harness.stop();
  });

  async function cardTitles(page: Page): Promise<string[]> {
    return (await page.locator("article h3").allTextContents()).map((text) => text.trim());
  }

  test("lists failed tasks, then tasks needing approval, then the rest, newest first within each", async () => {
    const page = await harness.browser.newPage();
    try {
      await page.goto(`${harness.origin}/tasks`, { waitUntil: "networkidle" });
      await page.locator("article h3").first().waitFor({ timeout: 10_000 });

      assert.deepEqual(await cardTitles(page), [
        "#6 Task 6",
        "#2 Task 2",
        "#4 Task 4",
        "#5 Task 5",
        "#3 Task 3",
        "#1 Task 1",
      ]);
    } finally {
      await page.close();
    }
  });

  test("moves a task into its new group when a task-updated event changes its phase", async () => {
    const page = await harness.browser.newPage();
    try {
      await page.goto(`${harness.origin}/tasks`, { waitUntil: "networkidle" });
      await page.locator("article h3").first().waitFor({ timeout: 10_000 });

      harness.sendEvent("task-updated", { ...TASKS[0], phase: "failed", updatedAt: "2026-02-01T00:00:00.000Z" });
      await page.waitForFunction(() => document.querySelectorAll("article h3")[2]?.textContent?.trim() === "#1 Task 1");
      assert.deepEqual(await cardTitles(page), [
        "#6 Task 6",
        "#2 Task 2",
        "#1 Task 1",
        "#4 Task 4",
        "#5 Task 5",
        "#3 Task 3",
      ]);

      harness.sendEvent("task-updated", { ...TASKS[4], phase: "waiting_approval" });
      await page.waitForFunction(() => document.querySelectorAll("article h3")[3]?.textContent?.trim() === "#5 Task 5");
      assert.deepEqual(await cardTitles(page), [
        "#6 Task 6",
        "#2 Task 2",
        "#1 Task 1",
        "#5 Task 5",
        "#4 Task 4",
        "#3 Task 3",
      ]);
    } finally {
      await page.close();
    }
  });

  test("no unstubbed requests were made", () => {
    assert.deepEqual(harness.unstubbedRequests, []);
  });
});
