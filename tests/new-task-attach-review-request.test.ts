import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import type {
  AttachableReviewRequest,
  CreateTaskFromReviewRequestRequest,
  RepoReviewRequest,
  RepoWorkItem,
} from "@crc/shared";
import { startClientApp, type ClientAppHarness } from "./helpers/client-app-harness.js";
import { makeTask } from "./helpers/task-fixture.js";

function workItem(number: number): RepoWorkItem {
  return {
    id: String(number),
    reference: `#${number}`,
    title: `Issue ${number}`,
    url: `https://github.com/example/repo/issues/${number}`,
    body: null,
    kind: "issue",
  };
}

function reviewRequest(number: number, title: string): RepoReviewRequest {
  return {
    id: String(number),
    reference: `#${number}`,
    title,
    url: `https://github.com/example/repo/pull/${number}`,
    body: "Description",
    kind: "pull_request",
    state: "open",
    sourceBranch: `branch-${number}`,
    fromFork: false,
    headSha: `sha-${number}`,
    ciState: "success",
    hasConflicts: false,
    needsRebase: false,
    mergeStateKnown: true,
    humanApprovedAt: null,
    hasUnresolvedComments: false,
    hasPlaceholderComment: false,
  };
}

interface AttachBackend {
  listings: string[];
  creates: CreateTaskFromReviewRequestRequest[];
}

async function installAttachBackend(page: Page, items: AttachableReviewRequest[]): Promise<AttachBackend> {
  const backend: AttachBackend = { listings: [], creates: [] };
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/attachable-review-requests**", async (route) => {
    const url = new URL(route.request().url());
    backend.listings.push(url.search);
    await json(route, 200, { items });
  });

  await page.route("**/api/tasks/from-review-request", async (route) => {
    const body = route.request().postDataJSON() as CreateTaskFromReviewRequestRequest;
    backend.creates.push(body);
    const item = items.find((entry) => entry.reviewRequest.id === body.reviewRequestId)!;
    await json(route, 201, {
      ...makeTask("attached", "spawning", "2026-02-01T00:00:00.000Z"),
      workItem: item.workItems.find((candidate) => candidate.id === body.workItemId),
      reviewRequest: { id: item.reviewRequest.id, url: item.reviewRequest.url, sourceBranch: item.reviewRequest.sourceBranch },
    });
  });

  return backend;
}

describe("New Task modal attaching to an open PR/MR", () => {
  let harness: ClientAppHarness;

  before(async () => {
    harness = await startClientApp({
      "/api/github/repos": { repos: [{ fullName: "example/repo", description: null }] },
    });
  });

  after(async () => {
    await harness.stop();
  });

  async function openModal(items: AttachableReviewRequest[]): Promise<{ page: Page; backend: AttachBackend }> {
    const page = await harness.browser.newPage();
    const backend = await installAttachBackend(page, items);
    await page.goto(`${harness.origin}/tasks`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "New Task" }).click();
    await page.getByRole("button", { name: "From open PR/MR" }).click();
    return { page, backend };
  }

  function attachButton(page: Page) {
    return page.getByRole("button", { name: "Attach Task", exact: true });
  }

  test("asks for a repository first, then shows the empty state", async () => {
    const { page, backend } = await openModal([]);
    try {
      await page.getByText("Select a repository first.").waitFor();
      assert.deepEqual(backend.listings, []);
      assert.equal(await attachButton(page).isDisabled(), true);

      await page.getByRole("button", { name: /example\/repo/ }).click();
      await page.getByText("No open PRs/MRs that mention an open issue and are not already handled by a task.").waitFor();
      assert.deepEqual(backend.listings, ["?repoFullName=example%2Frepo&repoSource=github"]);
      assert.equal(await attachButton(page).isDisabled(), true);
    } finally {
      await page.close();
    }
  });

  test("attaches to the chosen PR, tracking the chosen issue, and hides create_issue from the step picker", async () => {
    const { page, backend } = await openModal([
      { reviewRequest: reviewRequest(12, "Add widgets"), workItems: [workItem(7)], unusableReason: null },
      { reviewRequest: reviewRequest(13, "Fix gadgets"), workItems: [workItem(8), workItem(9)], unusableReason: null },
    ]);
    try {
      await page.getByRole("button", { name: /example\/repo/ }).click();
      await page.getByText("goes straight to review, rebase, CI fixes and comment addressing", { exact: false }).waitFor();
      await page.getByRole("radio", { name: /#12 Add widgets/ }).waitFor();
      await page.getByText("Mentions #8, #9").waitFor();
      assert.equal(await attachButton(page).isDisabled(), true);

      await page.getByRole("radio", { name: /#12 Add widgets/ }).check();
      assert.equal(await page.getByLabel("Issue this task tracks").count(), 0);

      await page.getByRole("radio", { name: /#13 Fix gadgets/ }).check();
      const issuePicker = page.getByLabel("Issue this task tracks");
      assert.equal(await issuePicker.inputValue(), "8");
      await issuePicker.selectOption("9");

      await page.getByRole("button", { name: "▸ Customise per step" }).click();
      await page.getByRole("combobox", { name: "Implement" }).waitFor();
      assert.equal(await page.getByRole("combobox", { name: "Create issue" }).count(), 0);

      await attachButton(page).click();
      await page.getByRole("heading", { name: "New Task" }).waitFor({ state: "detached" });

      assert.deepEqual(backend.creates, [
        {
          repoFullName: "example/repo",
          repoSource: "github",
          reviewRequestId: "13",
          workItemId: "9",
          configName: "default",
          configByStep: {},
        },
      ]);
    } finally {
      await page.close();
    }
  });

  test("shows why an unusable PR cannot be attached and does not let it be selected", async () => {
    const { page, backend } = await openModal([
      {
        reviewRequest: reviewRequest(14, "Empty body"),
        workItems: [workItem(7)],
        unusableReason: "#14 has an empty description",
      },
    ]);
    try {
      await page.getByRole("button", { name: /example\/repo/ }).click();
      const radio = page.getByRole("radio", { name: /#14 Empty body/ });
      await radio.waitFor();
      await page.getByText("#14 has an empty description").waitFor();
      assert.equal(await radio.isDisabled(), true);
      assert.equal(await attachButton(page).isDisabled(), true);
      assert.deepEqual(backend.creates, []);
    } finally {
      await page.close();
    }
  });
});
