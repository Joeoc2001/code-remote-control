import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AGENT_DISPLAY_NAMES, agentKindSchema, configFileSchema, resolveConfigFile } from "@crc/shared";

const base = {
  root_domain: "example.com",
  git: { email: "bot@example.com", username: "bot" },
};

function resolve(file: Record<string, unknown>) {
  return resolveConfigFile(configFileSchema.parse({ ...base, ...file })).configurations;
}

describe("agent selection in configurations", () => {
  test("a configuration with no agent is a claude configuration, so existing files keep working", () => {
    const [resolved] = resolve({ oauth: { accessToken: "token" }, configurations: [{ name: "default" }] });

    assert.equal(resolved.agent, "claude");
    assert.deepEqual(resolved, { name: "default", agent: "claude", oauth: { accessToken: "token" }, claude: undefined, env: undefined, docker: undefined });
  });

  test("an antigravity configuration resolves its gemini credentials and antigravity settings", () => {
    const [resolved] = resolve({
      configurations: [{ name: "gemini", agent: "antigravity", gemini: { api_key: "key" }, antigravity: { model: "gemini-3.1-pro" } }],
    });

    assert.deepEqual(resolved, {
      name: "gemini",
      agent: "antigravity",
      gemini: { api_key: "key" },
      antigravity: { model: "gemini-3.1-pro" },
      env: undefined,
      docker: undefined,
    });
  });

  test("claude and antigravity configurations can sit side by side, each inheriting its own top-level defaults", () => {
    const [claude, antigravity] = resolve({
      oauth: { accessToken: "token" },
      claude: { model: "opus" },
      gemini: { api_key: "key" },
      antigravity: { model: "gemini-3.1-pro", effort: "low" },
      env: { SHARED: "1" },
      configurations: [{ name: "claude" }, { name: "gemini", agent: "antigravity", antigravity: { effort: "high" } }],
    });

    assert.equal(claude.agent, "claude");
    assert.deepEqual(claude.agent === "claude" && claude.claude, { model: "opus" });
    assert.ok(!("gemini" in claude) && !("antigravity" in claude));

    assert.equal(antigravity.agent, "antigravity");
    assert.deepEqual(antigravity.agent === "antigravity" && antigravity.gemini, { api_key: "key" });
    assert.deepEqual(antigravity.agent === "antigravity" && antigravity.antigravity, { model: "gemini-3.1-pro", effort: "high" });
    assert.ok(!("oauth" in antigravity) && !("claude" in antigravity));
    assert.deepEqual(antigravity.env, { SHARED: "1" });
  });

  test("a top-level agent is the default and a configuration can override it either way", () => {
    const [inherited, overridden] = resolve({
      agent: "antigravity",
      oauth: { accessToken: "token" },
      gemini: { api_key: "key" },
      configurations: [{ name: "inherits" }, { name: "overrides", agent: "claude" }],
    });

    assert.equal(inherited.agent, "antigravity");
    assert.equal(overridden.agent, "claude");
  });

  test("an antigravity configuration without gemini credentials fails at load time, naming the configuration", () => {
    assert.throws(
      () => resolve({ oauth: { accessToken: "token" }, configurations: [{ name: "gemini", agent: "antigravity" }] }),
      /Configuration 'gemini' uses the antigravity agent but has no gemini block and no top-level gemini default is set/,
    );
  });

  test("an antigravity configuration does not need an oauth block", () => {
    assert.doesNotThrow(() => resolve({ configurations: [{ name: "gemini", agent: "antigravity", gemini: { api_key: "key" } }] }));
  });

  test("a claude configuration without oauth still fails at load time, even when gemini credentials exist", () => {
    assert.throws(
      () => resolve({ gemini: { api_key: "key" }, configurations: [{ name: "default" }] }),
      /Configuration 'default' uses the claude agent but has no oauth block and no top-level oauth default is set/,
    );
  });

  test("rejects an agent it does not know and an empty api key", () => {
    assert.throws(() => resolve({ configurations: [{ name: "x", agent: "codex", oauth: { accessToken: "token" } }] }));
    assert.throws(() => resolve({ configurations: [{ name: "x", agent: "antigravity", gemini: { api_key: "" } }] }));
    assert.throws(() => resolve({ configurations: [{ name: "x", agent: "antigravity", gemini: {} }] }));
  });

  test("every agent has a display name for the UI", () => {
    assert.deepEqual(Object.keys(AGENT_DISPLAY_NAMES).sort(), [...agentKindSchema.options].sort());
    assert.equal(AGENT_DISPLAY_NAMES.claude, "Claude Code");
    assert.equal(AGENT_DISPLAY_NAMES.antigravity, "Antigravity");
  });
});
