import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { stubFetch, writeTestConfig, type Route } from "../testing/forge-fetch.js";
import { makeLinkedTask } from "../testing/fixtures.js";

process.env.GITHUB_TOKEN = "gh-agent";
process.env.GITHUB_MERGE_TOKEN = "gh-merge";
process.env.CRC_STATE_DIR = mkdtempSync(join(tmpdir(), "crc-task-routes-"));
process.env.CRC_CONFIG_PATH = writeTestConfig({});

const { tasksRouter } = await import("./routes.js");
const { taskStore } = await import("./runtime.js");

const realFetch = globalThis.fetch;

function crcReviewRoutes(dismissStatus = 200): Route[] {
  return [
    (request) =>
      request.url === "https://api.github.com/user"
        ? { json: { login: request.token === "gh-merge" ? "owner" : "crc-bot" } }
        : null,
    (request) =>
      request.url === "https://api.github.com/repos/acme/widgets/pulls/12/reviews?per_page=100&page=1"
        ? { json: [{ id: 9, state: "APPROVED", user: { login: "owner" } }] }
        : null,
    (request) =>
      request.url.endsWith("/dismissals")
        ? dismissStatus === 200 ? { json: {} } : { status: dismissStatus, text: "Forbidden" }
        : null,
  ];
}

describe("PATCH /api/tasks/:id approval", () => {
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

  after(async () => {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  function patch(id: string, body: unknown): Promise<Response> {
    return realFetch(`${origin}/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("revokes the approval stored in CRC and withdraws CRC's approval on the forge, without touching the task's phase", async () => {
    const requests = stubFetch(crcReviewRoutes());
    taskStore.save(
      makeLinkedTask({
        id: "approved",
        phase: "waiting_ci",
        approval: { approvedAt: "2026-08-20T11:00:00.000Z", headSha: "abc123", diffHash: "diff-hash-1", carriesTo: null, rebasingFrom: null },
      }),
    );

    const before = Date.now();
    const res = await patch("approved", { approval: "revoke" });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { approval: unknown; approvalCancelledAt: string; phase: string };
    assert.equal(body.approval, null);
    assert.ok(Date.parse(body.approvalCancelledAt) >= before);
    assert.equal(body.phase, "waiting_ci");
    assert.equal(taskStore.get("approved")?.approval, null);
    assert.deepEqual(
      requests.filter((request) => request.method === "PUT"),
      [
        {
          method: "PUT",
          url: "https://api.github.com/repos/acme/widgets/pulls/12/reviews/9/dismissals",
          token: "gh-merge",
          body: { message: "Approval revoked in Code Remote Control", event: "DISMISS" },
        },
      ],
    );
  });

  it("keeps the approval when the forge refuses to withdraw CRC's approval", async () => {
    stubFetch(crcReviewRoutes(403));
    const approval = { approvedAt: "2026-08-20T11:00:00.000Z", headSha: "abc123", diffHash: "diff-hash-1", carriesTo: null, rebasingFrom: null };
    taskStore.save(makeLinkedTask({ id: "refused", phase: "merging", approval }));

    const res = await patch("refused", { approval: "revoke" });

    assert.equal(res.status, 500);
    assert.deepEqual(taskStore.get("refused")?.approval, approval);
  });

  it("does not call the forge when there is no approval to revoke", async () => {
    const requests = stubFetch([]);
    taskStore.save(makeLinkedTask({ id: "unapproved" }));

    const res = await patch("unapproved", { approval: "revoke" });

    assert.equal(res.status, 200);
    assert.deepEqual(requests, []);
  });

  it("rejects any other approval value", async () => {
    const approval = { approvedAt: "2026-08-20T11:00:00.000Z", headSha: "abc123", diffHash: null, carriesTo: null, rebasingFrom: null };
    taskStore.save(makeLinkedTask({ id: "kept", approval }));

    const res = await patch("kept", { approval: "grant" });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "approval must be 'revoke'" });
    assert.deepEqual(taskStore.get("kept")?.approval, approval);
  });

  it("still rejects an empty patch", async () => {
    taskStore.save(makeLinkedTask({ id: "empty" }));
    const res = await patch("empty", {});
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Provide phase, configByStep or approval" });
  });
});
