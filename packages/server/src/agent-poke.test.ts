import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildStallPokePrompt } from "@crc/shared/prompts";
import { buildPokeCommands, CLAUDE_TMUX_SESSION } from "./agent-poke.js";

const root = mkdtempSync(join(tmpdir(), "crc-agent-poke-"));
const socket = join(root, "tmux.sock");
const session = "crc-poke-test";

function tmux(argv: string[]): void {
  const [binary, ...args] = argv;
  assert.equal(binary, "tmux");
  execFileSync("tmux", ["-S", socket, ...args]);
}

async function waitForFile(path: string, expected: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path) && readFileSync(path, "utf-8") === expected) break;
    await sleep(50);
  }
  return readFileSync(path, "utf-8");
}

after(() => {
  try {
    execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
  } catch {}
  rmSync(root, { recursive: true, force: true });
});

describe("agent poke commands", () => {
  it("targets the tmux session the env container starts claude in", () => {
    const entrypoint = readFileSync(join(import.meta.dirname, "..", "..", "..", "docker", "entrypoint.sh"), "utf-8");
    assert.match(entrypoint, /CLAUDE_SESSION="\$\{CRC_TMUX_SESSION:\?/);
    assert.match(entrypoint, /tmux attach -t "\$CLAUDE_SESSION"/);
    assert.equal(CLAUDE_TMUX_SESSION, "crc");
  });

  it("types the message literally and submits it as one line in a real tmux session", async () => {
    const output = join(root, "received.txt");
    execFileSync("tmux", ["-S", socket, "new-session", "-d", "-s", session, `stty -echo; head -n 1 > '${output}'`]);
    const message = `${buildStallPokePrompt([{ kind: "shell", label: 'Wait for "CI"; `echo hi` $HOME' }], 30)} Enter C-c`;

    const commands = buildPokeCommands(session, message);
    tmux(commands.type);
    tmux(commands.submit);

    assert.equal(await waitForFile(output, `${message}\n`), `${message}\n`);
  });

  it("refuses a message that would be split across several submissions", () => {
    assert.throws(() => buildPokeCommands(session, "first line\nsecond line"), /single non-empty line/);
    assert.throws(() => buildPokeCommands(session, "carriage\rreturn"), /single non-empty line/);
    assert.throws(() => buildPokeCommands(session, ""), /single non-empty line/);
  });
});

describe("stall poke prompt", () => {
  it("names each pending background task and how to deal with hung ones", () => {
    const prompt = buildStallPokePrompt(
      [
        { kind: "shell", label: "Wait for\nCI" },
        { kind: "agent", label: "Review the diff" },
        { kind: "remote", label: "Remote work" },
      ],
      30,
    );

    assert.match(prompt, /over 30 minutes/);
    assert.match(prompt, /shell "Wait for CI", agent "Review the diff", remote "Remote work"/);
    assert.match(prompt, /TaskStop/);
    assert.doesNotThrow(() => buildPokeCommands(session, prompt));
  });

  it("tells a silent agent to interrupt a hung command", () => {
    for (const pendingTasks of [null, []]) {
      const prompt = buildStallPokePrompt(pendingTasks, 30);
      assert.match(prompt, /No activity has been recorded in this session for over 30 minutes/);
      assert.match(prompt, /interrupt it and retry it in the background/);
      assert.doesNotThrow(() => buildPokeCommands(session, prompt));
    }
  });
});
