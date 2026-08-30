import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildClaudeHooks } from "../packages/server/src/docker.js";
import { INSTANCE_STATES } from "../claude/hooks/instance-status.js";

const repoRoot = path.join(__dirname, "..");
const hooks = buildClaudeHooks() as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>>;

function statesWrittenBy(event: string, matcher?: string): string[] {
  return (hooks[event] ?? [])
    .filter((entry) => entry.matcher === matcher)
    .flatMap((entry) => entry.hooks.map((hook) => hook.command))
    .flatMap((command) => {
      const match = command.match(/instance-status\.js (\S+)$/);
      return match ? [match[1]] : [];
    });
}

describe("instance status hook wiring", () => {
  test("every instance-status hook names a state the hook script accepts", () => {
    const commands = Object.values(hooks)
      .flat()
      .flatMap((entry) => entry.hooks.map((hook) => hook.command))
      .filter((command) => command.includes("instance-status.js"));

    assert.ok(commands.length > 0);
    for (const command of commands) {
      const state = command.split(" ").pop();
      assert.ok(INSTANCE_STATES.includes(state), `${command} does not name a valid instance state`);
    }
  });

  test("a submitted prompt marks the agent as working", () => {
    assert.deepEqual(statesWrittenBy("UserPromptSubmit"), ["working"]);
  });

  test("asking the user a question marks the agent as waiting", () => {
    assert.deepEqual(statesWrittenBy("PreToolUse", "AskUserQuestion"), ["waiting"]);
  });

  test("a permission prompt marks the agent as waiting", () => {
    assert.deepEqual(statesWrittenBy("Notification", "permission_prompt"), ["waiting"]);
  });

  test("any finished tool call clears the wait, so an answered question resumes as working", () => {
    assert.deepEqual(statesWrittenBy("PostToolUse"), ["working"]);
  });

  test("the end of a session marks the agent as finished", () => {
    assert.deepEqual(statesWrittenBy("SessionEnd"), ["finished"]);
  });

  test("the end of a turn is left to the git hygiene hook", () => {
    assert.deepEqual(statesWrittenBy("Stop"), []);
    assert.equal(hooks.Stop.length, 1);
    assert.match(hooks.Stop[0].hooks[0].command, /git-hygiene\.js$/);
  });

  test("the git hygiene hook only ever writes states the hook script accepts", () => {
    const source = readFileSync(path.join(repoRoot, "claude", "hooks", "git-hygiene.js"), "utf-8");
    const calls = [...source.matchAll(/writeInstanceStatus\((.*?)\)/g)].map((match) => match[1]);

    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.ok(/^"(.+)"$/.test(call), `writeInstanceStatus(${call}) is not a literal state`);
      assert.ok(INSTANCE_STATES.includes(call.slice(1, -1)), `writeInstanceStatus(${call}) is not a valid state`);
    }
  });

  test("no hook maps the post-turn idle notification onto a state, which would clobber finished", () => {
    for (const entry of hooks.Notification ?? []) {
      assert.notEqual(entry.matcher, "idle_prompt");
    }
    assert.ok(!JSON.stringify(hooks).includes("idle_prompt"));
  });

  test("the checked-in settings template matches the hooks the server injects", () => {
    const template = JSON.parse(readFileSync(path.join(repoRoot, "claude", "settings.template.json"), "utf-8"));

    assert.deepEqual(template.hooks, hooks);
  });
});
