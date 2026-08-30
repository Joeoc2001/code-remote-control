const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { INSTANCE_STATES, instanceStatusPath, writeInstanceStatus } = require("../claude/hooks/instance-status.js");

const HOOK_SCRIPT = path.join(__dirname, "..", "claude", "hooks", "instance-status.js");

describe("instance-status hook", () => {
  let root;
  let statusPath;
  let originalPath;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "crc-instance-status-"));
    statusPath = path.join(root, "crc-instance-status.json");
    originalPath = process.env.CRC_INSTANCE_STATUS_PATH;
    process.env.CRC_INSTANCE_STATUS_PATH = statusPath;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.CRC_INSTANCE_STATUS_PATH;
    else process.env.CRC_INSTANCE_STATUS_PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });

  const readStatus = () => JSON.parse(readFileSync(statusPath, "utf-8"));
  const statusInode = () => statSync(statusPath).ino;

  test("defaults to the path the metadata server reads", () => {
    delete process.env.CRC_INSTANCE_STATUS_PATH;

    assert.equal(instanceStatusPath(), "/run/crc-instance-status.json");
  });

  test("accepts exactly the states the UI renders", () => {
    assert.deepEqual(INSTANCE_STATES, ["working", "waiting", "awaiting-background", "finished"]);
  });

  for (const state of INSTANCE_STATES) {
    test(`writes { state: "${state}", updatedAt }`, () => {
      assert.equal(writeInstanceStatus(state), true);

      const status = readStatus();
      assert.deepEqual(Object.keys(status).sort(), ["state", "updatedAt"]);
      assert.equal(status.state, state);
      assert.equal(new Date(status.updatedAt).toISOString(), status.updatedAt);
    });
  }

  test("rejects any other state, including the booleans of the old schema", () => {
    for (const bad of ["finished!", "true", true, false, undefined, "idle_prompt"]) {
      assert.throws(() => writeInstanceStatus(bad), /expects one of working, waiting, awaiting-background, finished/);
    }
    assert.equal(existsSync(statusPath), false);
  });

  test("skips the write when the stored state already matches", () => {
    writeInstanceStatus("waiting");
    const before = readStatus();
    const inodeBefore = statusInode();

    assert.equal(writeInstanceStatus("waiting"), false);
    assert.deepEqual(readStatus(), before);
    assert.equal(statusInode(), inodeBefore);
  });

  test("rewrites the file atomically when the state changes", () => {
    writeInstanceStatus("waiting");
    const inodeBefore = statusInode();

    assert.equal(writeInstanceStatus("working"), true);
    assert.equal(readStatus().state, "working");
    assert.notEqual(statusInode(), inodeBefore);
  });

  test("repairs a corrupt status file instead of skipping the write", () => {
    writeFileSync(statusPath, "not json at all");

    assert.equal(writeInstanceStatus("working"), true);
    assert.equal(readStatus().state, "working");
  });

  test("leaves no staging file behind", () => {
    writeInstanceStatus("working");
    writeInstanceStatus("finished");

    assert.deepEqual(readdirSync(root), ["crc-instance-status.json"]);
  });

  test("writes the state named on the command line", () => {
    execFileSync("node", [HOOK_SCRIPT, "waiting"], { env: { ...process.env, CRC_INSTANCE_STATUS_PATH: statusPath } });

    assert.equal(readStatus().state, "waiting");
  });

  test("exits non-zero when the command line names an unknown state", () => {
    assert.throws(
      () => execFileSync("node", [HOOK_SCRIPT, "confused"], {
        env: { ...process.env, CRC_INSTANCE_STATUS_PATH: statusPath },
        stdio: ["ignore", "ignore", "pipe"],
      }),
      (err) => err.status !== 0 && /expects one of working, waiting, awaiting-background, finished/.test(String(err.stderr)),
    );
    assert.equal(existsSync(statusPath), false);
  });
});

describe("instance status states", () => {
  const readRepoFile = (...segments) => readFileSync(path.join(__dirname, "..", ...segments), "utf-8");

  test("the hook writes exactly the states the shared type declares", () => {
    const types = readRepoFile("packages", "container-metadata-types", "src", "index.ts");
    const union = types.match(/export type InstanceState =([^;]+);/);
    assert.ok(union, "InstanceState union not found");
    const declared = [...union[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);

    assert.deepEqual(INSTANCE_STATES, declared);
  });

  test("the metadata server accepts exactly the states the shared type declares", () => {
    const server = readRepoFile("packages", "container-metadata-server", "src", "instance-status.ts");
    const list = server.match(/const INSTANCE_STATES: readonly InstanceState\[\] = \[([^\]]+)\]/);
    assert.ok(list, "metadata server state list not found");
    const accepted = [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);

    assert.deepEqual(accepted, INSTANCE_STATES);
  });

  test("the session script treats only the finished state as a finished task", () => {
    const script = readRepoFile("docker", "start-claude-session.sh");

    assert.match(script, /grep -q '"state"\[\[:space:\]\]\*:\[\[:space:\]\]\*"finished"'/);
  });
});
