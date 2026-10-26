import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Task, TaskAttempt, UpdateTaskRequest } from "@crc/shared";
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
    ...overrides,
  };
}

const approvedTask: Task = {
  ...makeTask("a", "waiting_ci", "2026-01-01T00:00:00.000Z"),
  approval: { approvedAt: "2026-01-01T02:00:00.000Z", headSha: "0123456789abcdef", diffHash: "diff-hash-1" },
  attempts: [
    attempt({ step: "implement", isMaterial: true }),
    attempt({ step: "review" }),
    attempt({ step: "rebase", isMaterial: false }),
  ],
};

const unpinnedTask: Task = {
  ...makeTask("u", "waiting_ci", "2026-01-01T00:00:00.000Z"),
  approval: { approvedAt: "2026-01-01T02:00:00.000Z", headSha: null, diffHash: "diff-hash-1" },
};

const unapprovedTask: Task = makeTask("n", "waiting_approval", "2026-01-01T00:00:00.000Z");

describe("CRC-stored approvals in the task view", () => {
  let harness: ClientAppHarness;

  before(async () => {
    harness = await startClientApp({
      "/api/tasks": [approvedTask, unpinnedTask, unapprovedTask],
      "/api/tasks/a": approvedTask,
      "/api/tasks/u": unpinnedTask,
      "/api/tasks/n": unapprovedTask,
    });
  });

  after(async () => {
    await harness.stop();
  });

  test("shows each attempt's is_material report, and nothing for an attempt that made none", async () => {
    const page = await harness.browser.newPage();
    try {
      await page.goto(`${harness.origin}/tasks/a`, { waitUntil: "networkidle" });
      await page.locator("li", { hasText: /^#\d/ }).first().waitFor({ timeout: 10_000 });

      const implementRow = page.locator("li", { hasText: "#1" });
      assert.equal(await implementRow.getByText("Material", { exact: true }).isVisible(), true);
      const reviewRow = page.locator("li", { hasText: "#2" });
      assert.equal(await reviewRow.getByText(/material/i).count(), 0);
      const rebaseRow = page.locator("li", { hasText: "#3" });
      assert.equal(await rebaseRow.getByText("Not material", { exact: true }).isVisible(), true);
      assert.deepEqual(harness.unstubbedRequests, []);
    } finally {
      await page.close();
    }
  });

  test("shows the stored approval with its pinned head and revokes it on request", async () => {
    const page = await harness.browser.newPage();
    const patches: UpdateTaskRequest[] = [];
    await page.route("**/api/tasks/a", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      patches.push(route.request().postDataJSON() as UpdateTaskRequest);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...approvedTask, approval: null }) });
    });
    try {
      await page.goto(`${harness.origin}/tasks/a`, { waitUntil: "networkidle" });
      const summary = page.getByText(/^Approved in CRC since/);
      await summary.waitFor({ timeout: 10_000 });
      assert.match(await summary.innerText(), /\(head 01234567\)$/);

      await page.getByRole("button", { name: "Revoke approval" }).click();
      await summary.waitFor({ state: "detached", timeout: 10_000 });

      assert.deepEqual(patches, [{ approval: "revoke" }]);
      assert.equal(await page.getByRole("button", { name: "Revoke approval" }).count(), 0);
    } finally {
      await page.close();
    }
  });

  test("explains that an unpinned approval carries over to the next head", async () => {
    const page = await harness.browser.newPage();
    try {
      await page.goto(`${harness.origin}/tasks/u`, { waitUntil: "networkidle" });
      const summary = page.getByText(/^Approved in CRC since/);
      await summary.waitFor({ timeout: 10_000 });
      assert.match(await summary.innerText(), /\(carries over to the next head\)$/);
    } finally {
      await page.close();
    }
  });

  test("shows no approval for a task without one", async () => {
    const page = await harness.browser.newPage();
    try {
      await page.goto(`${harness.origin}/tasks/n`, { waitUntil: "networkidle" });
      await page.getByText("No agents have been spawned yet.").waitFor({ timeout: 10_000 });
      assert.equal(await page.getByText(/Approved in CRC/).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Revoke approval" }).count(), 0);
    } finally {
      await page.close();
    }
  });
});
