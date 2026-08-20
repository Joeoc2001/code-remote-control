const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const dockerfile = readFileSync(path.join(repoRoot, "docker", "Dockerfile.env"), "utf-8");
const entrypoint = readFileSync(path.join(repoRoot, "docker", "entrypoint.sh"), "utf-8");

function copyDestination(source) {
  const line = dockerfile
    .split("\n")
    .find((candidate) => candidate.startsWith("COPY ") && candidate.includes(source));
  assert.ok(line, `Dockerfile.env does not COPY ${source}`);
  return line.trim().split(/\s+/).pop();
}

describe("env container wiring", () => {
  test("entrypoint.sh is valid bash", () => {
    execFileSync("bash", ["-n", path.join(repoRoot, "docker", "entrypoint.sh")]);
  });

  test("the session script is installed at the path the entrypoint invokes", () => {
    const installedPath = copyDestination("docker/start-claude-session.sh");

    assert.ok(
      entrypoint.includes(`${installedPath} "$CLAUDE_SESSION"`),
      `entrypoint.sh does not invoke ${installedPath}`,
    );
  });

  test("the installed session script is made executable", () => {
    const installedPath = copyDestination("docker/start-claude-session.sh");

    assert.match(dockerfile, new RegExp(`RUN chmod \\+x [^\\n]*${installedPath}`));
  });

  test("the entrypoint no longer launches claude itself", () => {
    assert.ok(!entrypoint.includes("CRC_INITIAL_PROMPT"));
    assert.ok(!/tmux new-session/.test(entrypoint));
  });
});
