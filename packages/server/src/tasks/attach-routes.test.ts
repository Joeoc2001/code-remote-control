import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { stubFetch, writeTestConfig, type RecordedRequest } from "../testing/forge-fetch.js";
import { makeLinkedTask, makeTask } from "../testing/fixtures.js";
import type { GitHubPullRequestNode } from "../forge/github.js";
import type { AttachableReviewRequest, Task } from "../types.js";

process.env.GITHUB_TOKEN = "gh-agent";
process.env.CRC_STATE_DIR = mkdtempSync(join(tmpdir(), "crc-attach-routes-"));
process.env.CRC_CONFIG_PATH = writeTestConfig({
  configurations: [
    { name: "default", oauth: { accessToken: "token" } },
    { name: "big", oauth: { accessToken: "token" } },
  ],
});

const { tasksRouter } = await import("./routes.js");
const { taskStore } = await import("./runtime.js");

const realFetch = globalThis.fetch;

function pullRequest(number: number, overrides: Partial<GitHubPullRequestNode> = {}): GitHubPullRequestNode {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    body: "Description",
    state: "OPEN",
    headRefName: `branch-${number}`,
    isCrossRepository: false,
    headRefOid: `sha-${number}`,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    viewerCanUpdateBranch: false,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    comments: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    ...overrides,
  };
}

function issue(number: number) {
  return { number, title: `Issue ${number}`, html_url: `https://github.com/acme/widgets/issues/${number}`, body: null };
}

function stubForge(pullRequests: GitHubPullRequestNode[], issues = [issue(7), issue(8), issue(9)]): RecordedRequest[] {
  return stubFetch([
    (request) => {
      if (request.url !== "https://api.github.com/graphql") return null;
      const { query } = request.body as { query: string };
      if (query.includes("query { viewer")) return { json: { data: { viewer: { login: "crc-bot" } } } };
      return {
        json: {
          data: {
            repository: {
              pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: pullRequests },
            },
          },
        },
      };
    },
    (request) =>
      request.url.startsWith("https://api.github.com/repos/acme/widgets/issues?state=open") ? { json: issues } : null,
  ]);
}

function resetStore(tasks: Task[]): void {
  for (const task of taskStore.list()) taskStore.remove(task.id);
  for (const task of tasks) taskStore.save(task);
}

describe("attaching tasks to open PRs/MRs", () => {
  let server: Server;
  let origin: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(tasksRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no port");
    origin = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => resetStore([]));

  after(async () => {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function list(): Promise<{ status: number; items: AttachableReviewRequest[] }> {
    const res = await realFetch(`${origin}/api/attachable-review-requests?repoFullName=acme/widgets&repoSource=github`);
    const body = (await res.json()) as { items: AttachableReviewRequest[] };
    return { status: res.status, items: body.items };
  }

  function create(body: Record<string, unknown>): Promise<Response> {
    return realFetch(`${origin}/api/tasks/from-review-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoFullName: "acme/widgets",
        repoSource: "github",
        reviewRequestId: "12",
        workItemId: "7",
        configName: "default",
        ...body,
      }),
    });
  }

  function patch(id: string, body: unknown): Promise<Response> {
    return realFetch(`${origin}/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  describe("GET /api/attachable-review-requests", () => {
    it("lists open PRs that mention an open issue, with the issues they mention", async () => {
      stubForge([
        pullRequest(12, { body: "Closes #7, see also https://github.com/acme/widgets/issues/9" }),
        pullRequest(13, { body: "Unrelated refactor" }),
        pullRequest(14, { body: "Fixes #77 and other/repo#8" }),
      ]);

      const { status, items } = await list();

      assert.equal(status, 200);
      assert.deepEqual(
        items.map((item) => ({
          reviewRequest: item.reviewRequest.reference,
          sourceBranch: item.reviewRequest.sourceBranch,
          workItems: item.workItems.map((workItem) => workItem.reference),
          unusableReason: item.unusableReason,
        })),
        [{ reviewRequest: "#12", sourceBranch: "branch-12", workItems: ["#7", "#9"], unusableReason: null }],
      );
    });

    it("excludes PRs held by a live task but keeps ones held only by merged or failed tasks", async () => {
      stubForge([pullRequest(12, { body: "Closes #7" }), pullRequest(13, { body: "Closes #8" }), pullRequest(14, { body: "Closes #9" })]);
      resetStore([
        makeLinkedTask({ id: "live", phase: "waiting_ci" }),
        makeLinkedTask({
          id: "failed",
          phase: "failed",
          reviewRequest: { id: "13", url: "https://github.com/acme/widgets/pull/13", sourceBranch: "branch-13" },
        }),
        makeLinkedTask({
          id: "merged",
          phase: "merged",
          reviewRequest: { id: "14", url: "https://github.com/acme/widgets/pull/14", sourceBranch: "branch-14" },
        }),
      ]);

      const { items } = await list();

      assert.deepEqual(
        items.map((item) => item.reviewRequest.reference),
        ["#13", "#14"],
      );
    });

    it("does not treat a live task on another repository as holding the PR", async () => {
      stubForge([pullRequest(12, { body: "Closes #7" })]);
      resetStore([makeLinkedTask({ id: "elsewhere", phase: "waiting_ci", repoFullName: "acme/other" })]);

      const { items } = await list();

      assert.deepEqual(items.map((item) => item.reviewRequest.reference), ["#12"]);
    });

    it("drops work items held by a live task, and PRs left mentioning none", async () => {
      stubForge([pullRequest(12, { body: "Closes #7" }), pullRequest(13, { body: "Closes #7 and #8" })]);
      resetStore([makeTask({ id: "implementing", phase: "spawning" })]);

      const { items } = await list();

      assert.deepEqual(
        items.map((item) => [item.reviewRequest.reference, item.workItems.map((workItem) => workItem.reference)]),
        [["#13", ["#8"]]],
      );
    });

    it("lists PRs whose description is unusable or which come from a fork with the reason they cannot be attached", async () => {
      stubForge([
        pullRequest(12, { title: "Fix #7", body: "" }),
        pullRequest(13, { body: "Closes #8", isCrossRepository: true }),
      ]);

      const { items } = await list();

      assert.deepEqual(
        items.map((item) => [item.reviewRequest.reference, item.unusableReason]),
        [
          ["#12", "#12 has an empty description: the agent that opened it never posted the body it wrote"],
          ["#13", "#13 comes from a fork, so agents cannot push to its source branch"],
        ],
      );
    });

    it("rejects an invalid repository", async () => {
      const res = await realFetch(`${origin}/api/attachable-review-requests?repoFullName=acme/widgets&repoSource=svn`);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "repoSource must be 'github' or 'gitlab'" });
    });
  });

  describe("POST /api/tasks/from-review-request", () => {
    it("creates a task linked to both the issue and the PR, ready to skip planning and implementation", async () => {
      stubForge([pullRequest(12, { body: "Closes #7" })]);

      const res = await create({ configByStep: { review: "big" } });

      assert.equal(res.status, 201);
      const task = (await res.json()) as Task;
      assert.equal(task.workItem?.reference, "#7");
      assert.deepEqual(task.reviewRequest, {
        id: "12",
        url: "https://github.com/acme/widgets/pull/12",
        sourceBranch: "branch-12",
      });
      assert.equal(task.phase, "spawning");
      assert.equal(task.lastReviewedSha, null);
      assert.equal(task.configByStep.review, "big");
      assert.equal(task.configByStep.implement, "default");
      assert.deepEqual(Object.values(task.attemptsByStep), [0, 0, 0, 0, 0, 0]);
      assert.deepEqual(taskStore.get(task.id), task);
    });

    it("returns 404 when the PR is not open", async () => {
      stubForge([pullRequest(13, { body: "Closes #7" })]);
      const res = await create({});
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "PR/MR not found among the repository's open PRs/MRs" });
    });

    it("returns 400 when the work item is not open", async () => {
      stubForge([pullRequest(12, { body: "Closes #70" })]);
      const res = await create({ workItemId: "70" });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Work item not found among the repository's open items" });
    });

    it("returns 400 when the PR does not mention the work item", async () => {
      stubForge([pullRequest(12, { body: "Closes #8" })]);
      const res = await create({});
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "#12 does not mention #7" });
    });

    it("returns 400 when the PR's description is unusable", async () => {
      stubForge([pullRequest(12, { title: "Fix #7", body: "" })]);
      const res = await create({});
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), {
        error: "#12 has an empty description: the agent that opened it never posted the body it wrote",
      });
    });

    it("returns 400 when the PR comes from a fork", async () => {
      stubForge([pullRequest(12, { body: "Closes #7", isCrossRepository: true })]);
      const res = await create({});
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "#12 comes from a fork, so agents cannot push to its source branch" });
    });

    it("returns 409 when a live task already holds the PR", async () => {
      stubForge([pullRequest(12, { body: "Closes #7 and #8" })]);
      resetStore([makeLinkedTask({ id: "holder", phase: "waiting_approval", workItem: null })]);
      const res = await create({ workItemId: "8" });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "PR/MR already has a live task (holder)" });
    });

    it("returns 409 when a live task already holds the work item", async () => {
      stubForge([pullRequest(12, { body: "Closes #7" })]);
      resetStore([makeTask({ id: "implementing", phase: "agent_running" })]);
      const res = await create({});
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "Work item already has a live task (implementing)" });
    });

    it("allows attaching when only a failed task holds the PR", async () => {
      stubForge([pullRequest(12, { body: "Closes #7" })]);
      resetStore([makeLinkedTask({ id: "gave-up", phase: "failed" })]);
      const res = await create({});
      assert.equal(res.status, 201);
    });

    it("rejects an unknown configuration without calling the forge", async () => {
      const requests = stubForge([]);
      const res = await create({ configName: "missing" });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Configuration 'missing' not found" });
      assert.deepEqual(requests, []);
    });

    it("rejects a request missing the PR or work item id", async () => {
      const res = await create({ reviewRequestId: undefined });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), {
        error: "repoFullName, configName, reviewRequestId, and workItemId are required",
      });
    });
  });

  describe("PATCH /api/tasks/:id resume", () => {
    it("refuses to resume a failed task whose PR another live task now holds", async () => {
      resetStore([
        makeLinkedTask({ id: "gave-up", phase: "failed" }),
        makeLinkedTask({ id: "attached", phase: "waiting_ci" }),
      ]);

      const res = await patch("gave-up", { phase: "resume" });

      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "Another live task (attached) already holds this PR/MR" });
      assert.equal(taskStore.get("gave-up")?.phase, "failed");
    });

    it("still resumes a paused task that holds its own PR", async () => {
      resetStore([makeLinkedTask({ id: "paused", phase: "paused" })]);

      const res = await patch("paused", { phase: "resume" });

      assert.equal(res.status, 200);
      assert.equal(taskStore.get("paused")?.phase, "spawning");
    });
  });
});
