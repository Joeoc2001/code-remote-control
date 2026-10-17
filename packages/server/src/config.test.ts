import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { agentToken, mergeToken, validateEnvironment } from "./config.js";

describe("mergeToken", () => {
  it("uses the merge token when it is set", () => {
    assert.deepEqual(
      mergeToken({ GITHUB_TOKEN: "agent", GITHUB_MERGE_TOKEN: "merge" }, "GITHUB_TOKEN", "GITHUB_MERGE_TOKEN"),
      { envName: "GITHUB_MERGE_TOKEN", value: "merge" },
    );
  });

  it("falls back to the agent token when the merge token is unset or empty", () => {
    for (const env of [{ GITHUB_TOKEN: "agent" }, { GITHUB_TOKEN: "agent", GITHUB_MERGE_TOKEN: "" }]) {
      assert.deepEqual(mergeToken(env, "GITHUB_TOKEN", "GITHUB_MERGE_TOKEN"), {
        envName: "GITHUB_TOKEN",
        value: "agent",
      });
    }
  });
});

describe("agentToken", () => {
  it("reads the named variable", () => {
    assert.deepEqual(agentToken({ GITLAB_TOKEN: "agent" }, "GITLAB_TOKEN"), { envName: "GITLAB_TOKEN", value: "agent" });
    assert.deepEqual(agentToken({}, "GITLAB_TOKEN"), { envName: "GITLAB_TOKEN", value: "" });
  });
});

describe("validateEnvironment", () => {
  function warnings(env: Record<string, string>): string[] {
    const warn = mock.method(console, "warn", () => {});
    try {
      validateEnvironment(env);
      return warn.mock.calls.map((call) => String(call.arguments[0]));
    } finally {
      warn.mock.restore();
    }
  }

  it("requires GITHUB_TOKEN", () => {
    assert.throws(() => validateEnvironment({}), /^Error: Missing required environment variables: GITHUB_TOKEN$/);
  });

  it("accepts distinct merge tokens without warning", () => {
    assert.deepEqual(
      warnings({ GITHUB_TOKEN: "a", GITHUB_MERGE_TOKEN: "b", GITLAB_TOKEN: "c", GITLAB_MERGE_TOKEN: "d" }),
      [],
    );
  });

  it("throws when GITHUB_MERGE_TOKEN equals GITHUB_TOKEN", () => {
    assert.throws(
      () => validateEnvironment({ GITHUB_TOKEN: "same", GITHUB_MERGE_TOKEN: "same" }),
      /^Error: GITHUB_MERGE_TOKEN must differ from GITHUB_TOKEN/,
    );
  });

  it("throws when GITLAB_MERGE_TOKEN equals GITLAB_TOKEN", () => {
    assert.throws(
      () => validateEnvironment({ GITHUB_TOKEN: "a", GITHUB_MERGE_TOKEN: "b", GITLAB_TOKEN: "same", GITLAB_MERGE_TOKEN: "same" }),
      /^Error: GITLAB_MERGE_TOKEN must differ from GITLAB_TOKEN/,
    );
  });

  it("throws when a merge token is set without its agent token", () => {
    assert.throws(
      () => validateEnvironment({ GITHUB_TOKEN: "a", GITHUB_MERGE_TOKEN: "b", GITLAB_MERGE_TOKEN: "d" }),
      /^Error: GITLAB_MERGE_TOKEN is set but GITLAB_TOKEN is not\.$/,
    );
  });

  it("warns once per configured forge whose merge token is unset", () => {
    const github = warnings({ GITHUB_TOKEN: "a" });
    assert.equal(github.length, 1);
    assert.match(github[0], /^GITHUB_MERGE_TOKEN is not set/);

    const both = warnings({ GITHUB_TOKEN: "a", GITLAB_TOKEN: "c" });
    assert.equal(both.length, 2);
    assert.match(both[1], /^GITLAB_MERGE_TOKEN is not set/);
  });
});
