const { readFileSync, renameSync, writeFileSync } = require("node:fs");

const INSTANCE_STATES = ["working", "waiting", "awaiting-background", "finished"];

function instanceStatusPath() {
  return process.env.CRC_INSTANCE_STATUS_PATH || "/run/crc-instance-status.json";
}

function currentInstanceState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8")).state;
  } catch {
    return null;
  }
}

function writeInstanceStatus(state) {
  if (!INSTANCE_STATES.includes(state)) {
    throw new Error(`instance-status.js expects one of ${INSTANCE_STATES.join(", ")}, got '${state}'`);
  }

  const path = instanceStatusPath();
  if (currentInstanceState(path) === state) return false;

  const payload = { state, updatedAt: new Date().toISOString() };
  const stagingPath = `${path}.${process.pid}.tmp`;
  writeFileSync(stagingPath, `${JSON.stringify(payload)}\n`, { encoding: "utf-8", mode: 0o644 });
  renameSync(stagingPath, path);
  return true;
}

module.exports = { INSTANCE_STATES, instanceStatusPath, writeInstanceStatus };

if (require.main === module) {
  writeInstanceStatus(process.argv[2]);
}
