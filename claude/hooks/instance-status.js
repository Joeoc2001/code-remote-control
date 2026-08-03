const { renameSync, writeFileSync } = require("node:fs");

const INSTANCE_STATUS_PATH = "/run/crc-instance-status.json";

function writeInstanceStatus(finished) {
  const payload = { finished, updatedAt: new Date().toISOString() };
  const stagingPath = `${INSTANCE_STATUS_PATH}.${process.pid}.tmp`;
  writeFileSync(stagingPath, `${JSON.stringify(payload)}\n`, { encoding: "utf-8", mode: 0o644 });
  renameSync(stagingPath, INSTANCE_STATUS_PATH);
}

module.exports = { INSTANCE_STATUS_PATH, writeInstanceStatus };

if (require.main === module) {
  const state = process.argv[2];
  if (state !== "finished" && state !== "working") {
    throw new Error(`instance-status.js expects 'finished' or 'working', got '${state}'`);
  }
  writeInstanceStatus(state === "finished");
}
