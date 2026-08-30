import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { instanceStatusPath, readInstanceStatus } from "../packages/container-metadata-server/src/instance-status.js";
import { writeInstanceStatus } from "../claude/hooks/instance-status.js";

describe("container metadata server: instance status", () => {
  let root: string;
  let statusPath: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "crc-metadata-status-"));
    statusPath = path.join(root, "crc-instance-status.json");
    originalPath = process.env.CRC_INSTANCE_STATUS_PATH;
    process.env.CRC_INSTANCE_STATUS_PATH = statusPath;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.CRC_INSTANCE_STATUS_PATH;
    else process.env.CRC_INSTANCE_STATUS_PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });

  test("reads the same file the hook writes", () => {
    delete process.env.CRC_INSTANCE_STATUS_PATH;

    assert.equal(instanceStatusPath(), "/run/crc-instance-status.json");
  });

  test("reports working when no hook has run yet", async () => {
    assert.deepEqual(await readInstanceStatus(), { state: "working", updatedAt: null });
  });

  for (const state of ["working", "waiting", "finished"] as const) {
    test(`round-trips the '${state}' state written by the hook`, async () => {
      writeInstanceStatus(state);

      const status = await readInstanceStatus();
      assert.equal(status.state, state);
      assert.equal(typeof status.updatedAt, "string");
    });
  }

  test("fails loudly on a state it does not know", async () => {
    writeFileSync(statusPath, JSON.stringify({ state: "confused", updatedAt: "2026-08-30T10:00:00.000Z" }));

    await assert.rejects(readInstanceStatus(), /malformed/);
  });

  test("fails loudly on the booleans of the old schema", async () => {
    writeFileSync(statusPath, JSON.stringify({ finished: true, updatedAt: "2026-08-30T10:00:00.000Z" }));

    await assert.rejects(readInstanceStatus(), /malformed/);
  });

  test("fails loudly on a missing timestamp", async () => {
    writeFileSync(statusPath, JSON.stringify({ state: "waiting" }));

    await assert.rejects(readInstanceStatus(), /malformed/);
  });

  test("fails loudly on a file that is not JSON", async () => {
    writeFileSync(statusPath, "not json at all");

    await assert.rejects(readInstanceStatus());
  });
});
