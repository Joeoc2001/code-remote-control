import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { writeTestConfig } from "../testing/forge-fetch.js";
import { makeLinkedTask } from "../testing/fixtures.js";

process.env.CRC_STATE_DIR = mkdtempSync(join(tmpdir(), "crc-task-routes-"));
process.env.CRC_CONFIG_PATH = writeTestConfig({});

const { tasksRouter } = await import("./routes.js");
const { taskStore } = await import("./runtime.js");

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
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  function patch(id: string, body: unknown): Promise<Response> {
    return fetch(`${origin}/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("revokes the approval stored in CRC without touching the task's phase", async () => {
    taskStore.save(
      makeLinkedTask({
        id: "approved",
        phase: "waiting_ci",
        approval: { approvedAt: "2026-08-20T11:00:00.000Z", headSha: "abc123", diffHash: "diff-hash-1" },
      }),
    );

    const res = await patch("approved", { approval: "revoke" });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { approval: unknown; phase: string };
    assert.equal(body.approval, null);
    assert.equal(body.phase, "waiting_ci");
    assert.equal(taskStore.get("approved")?.approval, null);
  });

  it("rejects any other approval value", async () => {
    const approval = { approvedAt: "2026-08-20T11:00:00.000Z", headSha: "abc123", diffHash: null };
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
