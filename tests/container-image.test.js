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
    const installedPath = copyDestination("docker/start-agent-session.sh");

    assert.ok(
      entrypoint.includes(`${installedPath} "$AGENT_SESSION"`),
      `entrypoint.sh does not invoke ${installedPath}`,
    );
  });

  test("the installed session script is made executable", () => {
    const installedPath = copyDestination("docker/start-agent-session.sh");

    assert.match(dockerfile, new RegExp(`RUN chmod \\+x [^\\n]*${installedPath}`));
  });

  test("the agent memory is installed as both Claude Code's and Antigravity's user memory", () => {
    const destinations = dockerfile
      .split("\n")
      .filter((line) => line.startsWith("COPY docker/agent-memory.md "))
      .map((line) => line.trim().split(/\s+/).pop());

    assert.deepEqual(destinations, ["/root/.claude/CLAUDE.md", "/root/.gemini/GEMINI.md"]);
  });

  test("the agent memory names no single agent", () => {
    const memory = readFileSync(path.join(repoRoot, "docker", "agent-memory.md"), "utf-8");

    assert.match(memory, /^# Agent memory\n/);
    assert.doesNotMatch(memory, /Claude|Antigravity|Gemini/);
  });

  test("the Antigravity CLI is installed as agy from a pinned, checksum-verified release", () => {
    assert.match(dockerfile, /ARG ANTIGRAVITY_CLI_URL\nARG ANTIGRAVITY_CLI_SHA512\n/);
    assert.match(dockerfile, /curl -fsSL -o \/tmp\/antigravity-cli\.tar\.gz "\$\{ANTIGRAVITY_CLI_URL:\?\}"/);
    assert.match(dockerfile, /echo "\$\{ANTIGRAVITY_CLI_SHA512:\?\}  \/tmp\/antigravity-cli\.tar\.gz" \| sha512sum -c -/);
    assert.match(dockerfile, /install -m 0755 \/tmp\/antigravity \/usr\/local\/bin\/agy/);
  });

  test("the image is the only source of the Antigravity CLI version", () => {
    assert.match(dockerfile, /^ENV AGY_CLI_DISABLE_AUTO_UPDATE=1$/m);
  });

  test("the build workflow resolves the Antigravity release and passes it to the env image build", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "build.yml"), "utf-8");

    for (const arg of ["ANTIGRAVITY_CLI_URL", "ANTIGRAVITY_CLI_SHA512"]) {
      assert.ok(dockerfile.includes(`ARG ${arg}`), `Dockerfile.env does not declare ${arg}`);
      assert.ok(workflow.includes(`echo "${arg}=$(jq -er `), `build.yml does not resolve ${arg}`);
      assert.ok(workflow.includes(`${arg}=\${{ env.${arg} }}`), `build.yml does not pass ${arg} as a build arg`);
    }
  });

  test("the hook scripts are installed where both harnesses' hook commands look for them", () => {
    assert.equal(copyDestination("agent-hooks/hooks"), "/opt/crc/hooks");
  });

  test("the directories the server injects Antigravity files into exist in the image", () => {
    assert.match(dockerfile, /RUN mkdir -p [^\n]*\/root\/\.gemini\/config[^\n]*\/root\/\.gemini\/antigravity-cli\/cache/);
  });

  test("the entrypoint takes the tmux session name from the server instead of hardcoding it", () => {
    assert.match(entrypoint, /AGENT_SESSION="\$\{CRC_TMUX_SESSION:\?[^}]*\}"/);
    assert.ok(!entrypoint.includes('AGENT_SESSION="crc"'));
  });

  test("the entrypoint refuses to start without a tmux session name", () => {
    const line = entrypoint.split("\n").find((candidate) => candidate.startsWith("AGENT_SESSION="));
    const script = `set -e; ${line}; echo "$AGENT_SESSION"`;
    assert.throws(
      () => execFileSync("bash", ["-c", script], { env: { PATH: process.env.PATH }, stdio: "pipe" }),
      (err) => /CRC_TMUX_SESSION must name/.test(String(err.stderr)),
    );
    assert.equal(execFileSync("bash", ["-c", script], { env: { PATH: process.env.PATH, CRC_TMUX_SESSION: "crc" } }).toString().trim(), "crc");
  });

  test("the entrypoint no longer launches claude itself", () => {
    assert.ok(!entrypoint.includes("CRC_INITIAL_PROMPT"));
    assert.ok(!/tmux new-session/.test(entrypoint));
  });
});
