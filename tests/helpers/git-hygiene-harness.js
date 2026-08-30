const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK_SCRIPT = path.join(__dirname, "..", "..", "claude", "hooks", "git-hygiene.js");

const NO_OUTPUT_STUB = "#!/bin/bash\nexit 0\n";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "crc test",
      GIT_AUTHOR_EMAIL: "crc@example.com",
      GIT_COMMITTER_NAME: "crc test",
      GIT_COMMITTER_EMAIL: "crc@example.com",
    },
  }).trim();
}

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "crc-git-hygiene-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  for (const name of ["gh", "glab"]) {
    const file = path.join(bin, name);
    writeFileSync(file, NO_OUTPUT_STUB);
    chmodSync(file, 0o755);
  }
  return { root, bin };
}

function makeWorkspace(root, { repo = "none", dirty = false } = {}) {
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  if (repo === "none") return workspace;

  git(workspace, "init", "-b", "main");
  writeFileSync(path.join(workspace, "README.md"), "hello\n");
  git(workspace, "add", ".");
  git(workspace, "commit", "-m", "initial");

  if (repo === "pushed") {
    const remote = path.join(root, "remote.git");
    git(root, "init", "--bare", remote);
    git(workspace, "remote", "add", "origin", remote);
    git(workspace, "push", "-u", "origin", "main");
  }

  if (dirty) writeFileSync(path.join(workspace, "README.md"), "uncommitted\n");
  return workspace;
}

function writeTranscript(root, entries) {
  const transcriptPath = path.join(root, "session.jsonl");
  writeFileSync(transcriptPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return transcriptPath;
}

function runHook({ root, bin, workspace, payload }) {
  const statusPath = path.join(root, "crc-instance-status.json");
  const result = execFileSync("node", [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      CRC_WORKSPACE_DIR: workspace,
      CRC_INSTANCE_STATUS_PATH: statusPath,
      CRC_RUN_DIR: root,
    },
  });

  return {
    stdout: result,
    decision: result.trim() ? JSON.parse(result) : null,
    instanceStatus: existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf-8")) : null,
  };
}

module.exports = { git, makeRoot, makeWorkspace, runHook, writeTranscript };
