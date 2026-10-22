const { readFileSync, renameSync, writeFileSync } = require("node:fs");

const INSTANCE_STATES = ["working", "waiting", "awaiting-background", "finished"];
const ACTIVITY_REFRESH_MS = 60_000;

function instanceStatusPath() {
  return process.env.CRC_INSTANCE_STATUS_PATH || "/run/crc-instance-status.json";
}

function currentInstanceStatus(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function sameStatus(current, state, details) {
  if (current === null || current.state !== state) return false;
  return JSON.stringify(current.pendingTasks ?? null) === JSON.stringify(details.pendingTasks ?? null);
}

function activityIsFresh(current, now) {
  const lastActivityAt = Date.parse(current.lastActivityAt);
  return Number.isFinite(lastActivityAt) && now.getTime() - lastActivityAt < ACTIVITY_REFRESH_MS;
}

function writeInstanceStatus(state, details = {}) {
  if (!INSTANCE_STATES.includes(state)) {
    throw new Error(`instance-status.js expects one of ${INSTANCE_STATES.join(", ")}, got '${state}'`);
  }

  const path = instanceStatusPath();
  const current = currentInstanceStatus(path);
  const now = new Date();
  const unchanged = sameStatus(current, state, details);
  if (unchanged && activityIsFresh(current, now)) return false;

  const updatedAt = unchanged && typeof current.updatedAt === "string" ? current.updatedAt : now.toISOString();
  const payload = { state, ...details, updatedAt, lastActivityAt: now.toISOString() };
  const stagingPath = `${path}.${process.pid}.tmp`;
  writeFileSync(stagingPath, `${JSON.stringify(payload)}\n`, { encoding: "utf-8", mode: 0o644 });
  renameSync(stagingPath, path);
  return true;
}

module.exports = { ACTIVITY_REFRESH_MS, INSTANCE_STATES, instanceStatusPath, writeInstanceStatus };

if (require.main === module) {
  writeInstanceStatus(process.argv[2]);
}
