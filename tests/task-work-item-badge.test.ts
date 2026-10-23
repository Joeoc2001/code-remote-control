import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { Task, TaskPhase } from "@crc/shared";
import { taskWorkItemBadge } from "../packages/client/src/components/taskWorkItemBadge.js";
import { startClientApp, type ClientAppHarness } from "./helpers/client-app-harness.js";
import { makeTask } from "./helpers/task-fixture.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function textTask(id: string, createdIssueUrl: string | null): Task {
  return { ...makeTask(id, "agent_running", CREATED_AT), workItem: null, sourceText: `Text task ${id}`, createdIssueUrl };
}

function gitlabTask(id: string): Task {
  const task = makeTask(id, "waiting_ci", CREATED_AT);
  return {
    ...task,
    repoSource: "gitlab",
    workItem: { ...task.workItem!, reference: `#${id}`, url: `https://gitlab.example.test/work_items/${id}`, kind: "work_item" },
  };
}

describe("taskWorkItemBadge", () => {
  test("labels an issue by its reference and links to it", () => {
    assert.deepEqual(taskWorkItemBadge(makeTask("12", "agent_running", CREATED_AT)), {
      url: "https://example.test/issues/12",
      label: "Issue #12",
      state: "open",
    });
  });

  test("labels a GitLab work item as a work item", () => {
    assert.deepEqual(taskWorkItemBadge(gitlabTask("7")), {
      url: "https://gitlab.example.test/work_items/7",
      label: "Work item #7",
      state: "open",
    });
  });

  test("is closed only once the task is merged", () => {
    const phases: TaskPhase[] = [
      "spawning",
      "agent_running",
      "waiting_ci",
      "waiting_approval",
      "merging",
      "checking_closure",
      "merged",
      "failed",
      "paused",
    ];
    assert.deepEqual(
      Object.fromEntries(phases.map((phase) => [phase, taskWorkItemBadge(makeTask("1", phase, CREATED_AT))?.state])),
      {
        spawning: "open",
        agent_running: "open",
        waiting_ci: "open",
        waiting_approval: "open",
        merging: "open",
        checking_closure: "open",
        merged: "closed",
        failed: "open",
        paused: "open",
      },
    );
  });

  test("falls back to the created issue URL before the issue is adopted", () => {
    assert.deepEqual(taskWorkItemBadge(textTask("t", "https://example.test/issues/99")), {
      url: "https://example.test/issues/99",
      label: "Issue",
      state: "open",
    });
  });

  test("prefers the adopted work item over the created issue URL", () => {
    const task = { ...makeTask("5", "agent_running", CREATED_AT), createdIssueUrl: "https://example.test/issues/other" };
    assert.equal(taskWorkItemBadge(task)?.url, "https://example.test/issues/5");
  });

  test("is absent for a text task with no issue yet", () => {
    assert.equal(taskWorkItemBadge(textTask("t", null)), null);
  });
});

const ISSUE_TASK: Task = {
  ...makeTask("12", "waiting_ci", "2026-01-04T00:00:00.000Z"),
  reviewRequest: { id: "34", url: "https://example.test/pull/34", sourceBranch: "feature" },
};
const MERGED_TASK = makeTask("13", "merged", "2026-01-03T00:00:00.000Z");
const GITLAB_TASK = { ...gitlabTask("7"), createdAt: "2026-01-02T00:00:00.000Z" };
const PENDING_TEXT_TASK = { ...textTask("pending", "https://example.test/issues/99"), createdAt: "2026-01-01T00:00:00.000Z" };
const BARE_TEXT_TASK = { ...textTask("bare", null), createdAt: "2025-12-31T00:00:00.000Z" };

describe("work item badges in the UI", () => {
  let harness: ClientAppHarness;

  before(async () => {
    harness = await startClientApp({
      "/api/tasks": [ISSUE_TASK, MERGED_TASK, GITLAB_TASK, PENDING_TEXT_TASK, BARE_TEXT_TASK],
      "/api/tasks/12": ISSUE_TASK,
    });
  });

  after(async () => {
    await harness.stop();
  });

  async function badgeRow(page: Page, title: string): Promise<{ text: string; href: string | null; label: string | null }[]> {
    const card = page.locator("article", { has: page.locator("h3", { hasText: title }) });
    return card.locator("a[target=_blank]").evaluateAll((links) =>
      links.map((link) => ({
        text: link.textContent!.trim(),
        href: link.getAttribute("href"),
        label: link.getAttribute("aria-label"),
      })),
    );
  }

  test("task cards show the work item badge before the PR/MR badge", async () => {
    const page = await harness.browser.newPage();
    try {
      await page.goto(`${harness.origin}/tasks`, { waitUntil: "networkidle" });
      await page.locator("article h3").first().waitFor({ timeout: 10_000 });

      assert.deepEqual(await badgeRow(page, "#12 Task 12"), [
        { text: "Issue #12", href: "https://example.test/issues/12", label: "Open Issue #12 (open)" },
        { text: "PR/MR #34", href: "https://example.test/pull/34", label: "Open PR/MR #34 (open)" },
      ]);
      assert.deepEqual(await badgeRow(page, "#13 Task 13"), [
        { text: "Issue #13", href: "https://example.test/issues/13", label: "Open Issue #13 (closed)" },
      ]);
      assert.deepEqual(await badgeRow(page, "#7 Task 7"), [
        { text: "Work item #7", href: "https://gitlab.example.test/work_items/7", label: "Open Work item #7 (open)" },
      ]);
      assert.deepEqual(await badgeRow(page, "Text task pending"), [
        { text: "Issue", href: "https://example.test/issues/99", label: "Open Issue (open)" },
      ]);
      assert.deepEqual(await badgeRow(page, "Text task bare"), []);
    } finally {
      await page.close();
    }
  });

  test("clicking the badge on a task card opens the issue without navigating to the task", async () => {
    const context = await harness.browser.newContext();
    await context.route("https://example.test/**", (route) => route.fulfill({ body: "issue page" }));
    const page = await context.newPage();
    try {
      await page.goto(`${harness.origin}/tasks`, { waitUntil: "networkidle" });
      await page.locator("article h3").first().waitFor({ timeout: 10_000 });

      const [popup] = await Promise.all([
        context.waitForEvent("page"),
        page.getByRole("link", { name: "Open Issue #12 (open)", exact: true }).click(),
      ]);
      await popup.waitForLoadState();

      assert.equal(popup.url(), "https://example.test/issues/12");
      assert.equal(new URL(page.url()).pathname, "/tasks");
    } finally {
      await context.close();
    }
  });

  test("the task view shows the work item badge before the PR/MR badge", async () => {
    const page = await harness.browser.newPage();
    try {
      await page.goto(`${harness.origin}/tasks/12`, { waitUntil: "networkidle" });
      const issueBadge = page.getByRole("link", { name: "Open Issue #12 (open)", exact: true });
      await issueBadge.waitFor({ timeout: 10_000 });

      const badges = await issueBadge
        .locator("xpath=..")
        .locator("a[target=_blank]")
        .evaluateAll((links) => links.map((link) => [link.textContent!.trim(), link.getAttribute("href")]));
      assert.deepEqual(badges, [
        ["Issue #12", "https://example.test/issues/12"],
        ["PR/MR #34", "https://example.test/pull/34"],
      ]);
    } finally {
      await page.close();
    }
  });

  test("no unstubbed requests were made", () => {
    assert.deepEqual(harness.unstubbedRequests, []);
  });
});
