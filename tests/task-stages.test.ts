import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Task, TaskAttempt } from "@crc/shared";
import { startClientApp, type ClientAppHarness } from "./helpers/client-app-harness.js";
import { makeTask } from "./helpers/task-fixture.js";

function attempt(step: TaskAttempt["step"], startedAt: string, finishedAt: string): TaskAttempt {
  return {
    step,
    containerId: null,
    headShaBefore: null,
    diffHashBefore: null,
    startedAt,
    finishedAt,
    finishedObservation: null,
    error: null,
  };
}

const secondStageTask: Task = {
  ...makeTask("s", "waiting_ci", "2026-01-01T00:00:00.000Z"),
  reviewRequest: { id: "13", url: "https://example.test/pull/13", sourceBranch: "stage-2" },
  attempts: [
    attempt("implement", "2026-01-01T00:00:00.000Z", "2026-01-01T00:10:00.000Z"),
    attempt("review", "2026-01-01T00:20:00.000Z", "2026-01-01T00:25:00.000Z"),
    attempt("implement", "2026-01-01T02:00:00.000Z", "2026-01-01T02:10:00.000Z"),
  ],
  completedStages: [
    {
      reviewRequest: { id: "11", url: "https://example.test/pull/11", sourceBranch: "stage-1" },
      startedAt: "2026-01-01T00:00:00.000Z",
      mergedAt: "2026-01-01T01:00:00.000Z",
      firstAttemptIndex: 0,
      attemptCount: 2,
    },
  ],
  stageStartedAt: "2026-01-01T01:02:00.000Z",
};

const checkingTask: Task = {
  ...makeTask("c", "checking_closure", "2026-01-02T00:00:00.000Z"),
  reviewRequest: { id: "21", url: "https://example.test/pull/21", sourceBranch: "c" },
  mergedAt: "2026-01-02T01:00:00.000Z",
};

describe("multi-stage task UI", () => {
  let harness: ClientAppHarness;
  const logRequests: string[] = [];

  before(async () => {
    harness = await startClientApp({
      "/api/tasks": [secondStageTask, checkingTask],
      "/api/tasks/s": secondStageTask,
      "/api/tasks/s/attempts/1/log": { log: "stage one review log" },
    });
  });

  after(async () => {
    await harness.stop();
  });

  test("shows previous stages collapsed above the task, with only the current stage's attempts listed", async () => {
    const page = await harness.browser.newPage();
    page.on("request", (request) => {
      if (request.url().includes("/attempts/")) logRequests.push(new URL(request.url()).pathname);
    });
    try {
      await page.goto(`${harness.origin}/tasks/s`, { waitUntil: "networkidle" });
      const details = page.locator("details", { hasText: "Previous stages (1)" });
      await details.waitFor({ timeout: 10_000 });

      assert.equal(await details.getAttribute("open"), null);
      assert.equal(await page.getByRole("heading", { name: "Stage 1" }).isVisible(), false);
      const detailsBox = await details.boundingBox();
      const titleBox = await page.getByRole("heading", { name: "#s Task s" }).boundingBox();
      assert.ok(detailsBox && titleBox && detailsBox.y < titleBox.y, "previous stages should sit above the task header");

      const currentSection = page.locator("section", { hasText: "Stage 2 attempts" });
      assert.deepEqual(
        (await currentSection.locator("li > div > span:first-child").allTextContents()).map((t) => t.trim()),
        ["#3"],
      );

      await details.locator("summary").click();
      assert.equal(await page.getByRole("heading", { name: "Stage 1" }).isVisible(), true);
      assert.equal(await details.getByRole("link", { name: "PR/MR #11" }).getAttribute("href"), "https://example.test/pull/11");
      assert.deepEqual(
        (await details.locator("li > div > span:first-child").allTextContents()).map((t) => t.trim()),
        ["#1", "#2"],
      );

      await details.locator("li").nth(1).getByRole("button", { name: "Show log" }).click();
      await details.getByText("stage one review log").waitFor({ timeout: 5_000 });
      assert.deepEqual(logRequests, ["/api/tasks/s/attempts/1/log"]);
      assert.deepEqual(harness.unstubbedRequests, []);
    } finally {
      await page.close();
    }
  });

  test("labels stage numbers and the closure check on the task list", async () => {
    const page = await harness.browser.newPage();
    try {
      await page.goto(`${harness.origin}/tasks`, { waitUntil: "networkidle" });
      await page.locator("article h3").first().waitFor({ timeout: 10_000 });

      const stageCard = page.locator("article", { hasText: "Task s" });
      assert.equal(await stageCard.getByText("Stage 2", { exact: true }).isVisible(), true);

      const checkingCard = page.locator("article", { hasText: "Task c" });
      assert.equal(await checkingCard.getByText("Checking issue", { exact: true }).isVisible(), true);
      assert.equal(await checkingCard.getByText(/^Stage \d/).count(), 0);
    } finally {
      await page.close();
    }
  });
});
