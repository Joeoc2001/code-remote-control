const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const START_SESSION_SCRIPT = path.join(__dirname, "..", "..", "docker", "start-claude-session.sh");

const RECORD_ARGV = `record_argv() {
  local file="$1"
  shift
  : > "$file"
  for arg in "$@"; do printf '%s\\0' "$arg" >> "$file"; done
}
`;

const TMUX_STUB = `#!/bin/bash
${RECORD_ARGV}
record_argv "$CRC_TEST_DIR/tmux-argv" "$@"
[ "$1" = "new-session" ] || exit 90
[ "$2" = "-d" ] || exit 91
[ "$3" = "-s" ] || exit 92
shift 4
exec "$@"
`;

const CLAUDE_STUB = `#!/bin/bash
${RECORD_ARGV}
record_argv "$CRC_TEST_DIR/claude-argv" "$@"
printf '%s' "\${CRC_RESUME_PROMPT-}" > "$CRC_TEST_DIR/claude-resume-prompt-env"
printf '%s' "\${CRC_INITIAL_PROMPT-}" > "$CRC_TEST_DIR/claude-initial-prompt-env"
`;

function writeStub(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function prepare({ transcriptFiles = [], transcriptSubdirs = [], createTranscriptDir = true, initialPrompt }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "crc-session-test-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeStub(bin, "claude", CLAUDE_STUB);

  const transcriptDir = path.join(root, "projects", "-workspace");
  if (createTranscriptDir) {
    mkdirSync(transcriptDir, { recursive: true });
    for (const name of transcriptFiles) {
      writeFileSync(path.join(transcriptDir, name), '{"type":"user"}\n');
    }
    for (const name of transcriptSubdirs) {
      mkdirSync(path.join(transcriptDir, name), { recursive: true });
    }
  }

  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    CRC_TEST_DIR: root,
    CRC_TRANSCRIPT_DIR: transcriptDir,
  };
  if (initialPrompt !== undefined) env.CRC_INITIAL_PROMPT = initialPrompt;

  return { root, bin, transcriptDir, env };
}

function readArgv(file) {
  const raw = readFileSync(file, "utf-8");
  const parts = raw.split("\0");
  parts.pop();
  return parts;
}

function collect(root) {
  const read = (name, parse) => {
    const file = path.join(root, name);
    if (!existsSync(file)) return null;
    return parse(file);
  };
  return {
    tmuxArgv: read("tmux-argv", readArgv),
    claudeArgv: read("claude-argv", readArgv),
    claudeResumePromptEnv: read("claude-resume-prompt-env", (file) => readFileSync(file, "utf-8")),
    claudeInitialPromptEnv: read("claude-initial-prompt-env", (file) => readFileSync(file, "utf-8")),
  };
}

function startSession(options = {}) {
  const { root, bin, env } = prepare(options);
  writeStub(bin, "tmux", TMUX_STUB);

  const scriptArgs = options.args ?? [options.sessionName ?? "crc"];
  let stdout = "";
  let error = null;
  try {
    stdout = execFileSync("bash", [START_SESSION_SCRIPT, ...scriptArgs], {
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    error = err;
  }

  return { stdout, error, ...collect(root) };
}

function requireTmux() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    throw new Error("tmux is required to run the real-tmux integration tests");
  }
}

async function startSessionWithRealTmux(options = {}) {
  requireTmux();
  const { root, env } = prepare(options);
  const tmuxEnv = { ...env, TMUX_TMPDIR: root, TERM: "xterm-256color" };
  const sessionName = options.sessionName ?? "crc";

  try {
    execFileSync("bash", [START_SESSION_SCRIPT, sessionName], {
      env: tmuxEnv,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const argvFile = path.join(root, "claude-argv");
    const deadline = Date.now() + 10_000;
    while (!existsSync(argvFile) && Date.now() < deadline) {
      await delay(25);
    }
    if (!existsSync(argvFile)) throw new Error("tmux never launched the claude command");
    await delay(50);

    return collect(root);
  } finally {
    try {
      execFileSync("tmux", ["kill-server"], { env: tmuxEnv, stdio: "ignore" });
    } catch {
      // the server exits on its own once the stub command finishes
    }
  }
}

function resumePromptFromScript() {
  const result = startSession({ transcriptFiles: ["session.jsonl"] });
  if (result.error) throw result.error;
  return result.claudeArgv[1];
}

module.exports = {
  START_SESSION_SCRIPT,
  startSession,
  startSessionWithRealTmux,
  resumePromptFromScript,
};
