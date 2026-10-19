import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, writeTestConfig } from "../testing/forge-fetch.js";

process.env.GITHUB_TOKEN = "gh-agent";
process.env.GITLAB_TOKEN = "gl-agent";
delete process.env.GITHUB_MERGE_TOKEN;
delete process.env.GITLAB_MERGE_TOKEN;
process.env.CRC_CONFIG_PATH = writeTestConfig({ gitlab_url: "https://gitlab.test" });

const github = await import("./github.js");
const gitlab = await import("./gitlab.js");
const { buildContainerEnv } = await import("../docker.js");

describe("merging without merge tokens set", () => {
  it("merges a GitHub pull request with GITHUB_TOKEN", async () => {
    const requests = stubFetch([() => ({ json: { merged: true } })]);
    await github.mergePullRequest("acme/widgets", "12");
    assert.deepEqual(requests, [
      {
        method: "PUT",
        url: "https://api.github.com/repos/acme/widgets/pulls/12/merge",
        token: "gh-agent",
        body: { merge_method: "merge" },
      },
    ]);
  });

  it("merges a GitLab merge request with GITLAB_TOKEN", async () => {
    const requests = stubFetch([() => ({ json: {} })]);
    await gitlab.mergeMergeRequest("acme/widgets", "5");
    assert.deepEqual(requests, [
      {
        method: "PUT",
        url: "https://gitlab.test/api/v4/projects/acme%2Fwidgets/merge_requests/5/merge",
        token: "gl-agent",
        body: undefined,
      },
    ]);
  });

  it("names the agent token in a refused merge's error", async () => {
    stubFetch([() => ({ status: 405, text: "protected branch" })]);
    await assert.rejects(github.mergePullRequest("acme/widgets", "12"), /\(using GITHUB_TOKEN\): 405/);
    await assert.rejects(gitlab.mergeMergeRequest("acme/widgets", "5"), /\(using GITLAB_TOKEN\): 405/);
  });

  it("still passes the agent token to containers", () => {
    const env = buildContainerEnv({
      repoUrl: "https://github.com/acme/widgets.git",
      repoSource: "github",
      gitlabUrl: "https://gitlab.test",
      gitUsername: "bot",
      gitEmail: "bot@example.com",
      initialPrompt: undefined,
      configEnv: undefined,
    });
    assert.ok(env.includes("GITHUB_TOKEN=gh-agent"));
  });
});
