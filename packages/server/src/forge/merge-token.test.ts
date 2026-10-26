import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, writeTestConfig, type RecordedRequest, type Route } from "../testing/forge-fetch.js";

process.env.GITHUB_TOKEN = "gh-agent";
process.env.GITHUB_MERGE_TOKEN = "gh-merge";
process.env.GITLAB_TOKEN = "gl-agent";
process.env.GITLAB_MERGE_TOKEN = "gl-merge";
process.env.CRC_CONFIG_PATH = writeTestConfig({ gitlab_url: "https://gitlab.test", merge_method: "squash" });

const github = await import("./github.js");
const gitlab = await import("./gitlab.js");
const { buildContainerEnv } = await import("../docker.js");

const LOGIN_BY_TOKEN: Record<string, string> = {
  "gh-agent": "crc-bot",
  "gh-merge": "owner",
  "gl-agent": "crc-bot",
  "gl-merge": "owner",
};

function pullRequestNode(approvers: string[]): Record<string, unknown> {
  return {
    number: 12,
    title: "Add widgets",
    url: "https://github.com/acme/widgets/pull/12",
    body: "body",
    state: "OPEN",
    headRefOid: "abc123",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    viewerCanUpdateBranch: false,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    comments: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    latestOpinionatedReviews: {
      nodes: approvers.map((login) => ({ state: "APPROVED", author: { login } })),
    },
  };
}

function githubRoutes(approvers: string[], mergeStatus = 200): Route[] {
  return [
    (request) => {
      if (request.url !== "https://api.github.com/graphql") return null;
      const { query } = request.body as { query: string };
      if (query.includes("viewer { login }")) return { json: { data: { viewer: { login: LOGIN_BY_TOKEN[request.token] } } } };
      return { json: { data: { repository: { pullRequest: pullRequestNode(approvers) } } } };
    },
    (request) =>
      request.url.endsWith("/pulls/12/merge")
        ? mergeStatus === 200 ? { json: { merged: true } } : { status: mergeStatus, text: "protected branch" }
        : null,
    (request) => (request.url.endsWith("/pulls/12/update-branch") ? { json: {} } : null),
    (request) => (request.url.endsWith("/pulls/12") ? { text: "diff --git a/x b/x\n" } : null),
    (request) => (request.url.includes("/issues?") ? { json: [] } : null),
    (request) => (request.url.includes("/user/repos?") ? { json: [] } : null),
  ];
}

function gitlabRoutes(approvers: string[], mergeStatus = 200): Route[] {
  const mr = "https://gitlab.test/api/v4/projects/acme%2Fwidgets/merge_requests/5";
  return [
    (request) =>
      request.url === "https://gitlab.test/api/v4/user" ? { json: { username: LOGIN_BY_TOKEN[request.token] } } : null,
    (request) =>
      request.url === `${mr}/approvals`
        ? { json: { approved_by: approvers.map((username) => ({ user: { username } })) } }
        : null,
    (request) => (request.url.startsWith(`${mr}/discussions`) ? { json: [] } : null),
    (request) => (request.url.startsWith(`${mr}/diffs`) ? { json: [] } : null),
    (request) =>
      request.url === `${mr}/merge`
        ? mergeStatus === 200 ? { json: {} } : { status: mergeStatus, text: "protected branch" }
        : null,
    (request) => (request.url === `${mr}/rebase` ? { json: {} } : null),
    (request) =>
      request.url.startsWith(`${mr}?`)
        ? {
            json: {
              iid: 5,
              title: "Add widgets",
              web_url: "https://gitlab.test/acme/widgets/-/merge_requests/5",
              description: null,
              state: "opened",
              sha: "abc123",
              has_conflicts: false,
              detailed_merge_status: "mergeable",
              head_pipeline: { status: "success" },
            },
          }
        : null,
    (request) => (request.url.includes("/api/v4/projects?") ? { json: [] } : null),
  ];
}

function tokensUsed(requests: RecordedRequest[]): string[] {
  return [...new Set(requests.map((request) => request.token))];
}

describe("GitHub with GITHUB_MERGE_TOKEN set", () => {
  it("merges with the merge token and the configured merge method", async () => {
    const requests = stubFetch(githubRoutes([]));
    await github.mergePullRequest("acme/widgets", "12");
    assert.deepEqual(requests, [
      {
        method: "PUT",
        url: "https://api.github.com/repos/acme/widgets/pulls/12/merge",
        token: "gh-merge",
        body: { merge_method: "squash" },
      },
    ]);
  });

  it("approves the pull request at the given head with the merge token", async () => {
    const requests = stubFetch([(request) => (request.url.endsWith("/pulls/12/reviews") ? { json: {} } : null)]);
    await github.approvePullRequest("acme/widgets", "12", "def456");
    assert.deepEqual(requests, [
      {
        method: "POST",
        url: "https://api.github.com/repos/acme/widgets/pulls/12/reviews",
        token: "gh-merge",
        body: { commit_id: "def456", event: "APPROVE" },
      },
    ]);
  });

  it("names the merge token in a refused approval's error", async () => {
    stubFetch([() => ({ status: 422, text: "Can not approve your own pull request" })]);
    await assert.rejects(
      github.approvePullRequest("acme/widgets", "12", "def456"),
      /^Error: GitHub API error \(using GITHUB_MERGE_TOKEN\): 422 Error: Can not approve your own pull request$/,
    );
  });

  it("rebases with the agent token", async () => {
    const requests = stubFetch(githubRoutes([]));
    await github.rebasePullRequest("acme/widgets", "12");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.github.com/repos/acme/widgets/pulls/12/update-branch");
    assert.equal(requests[0].token, "gh-agent");
  });

  it("reads with the agent token only", async () => {
    const requests = stubFetch(githubRoutes([]));
    await github.fetchRepos();
    await github.fetchOpenIssues("acme/widgets");
    await github.fetchPullRequest("acme/widgets", "12");
    await github.fetchPullRequestDiffHash("acme/widgets", "12");
    assert.equal(requests.length, 5);
    assert.deepEqual(tokensUsed(requests), ["gh-agent"]);
  });

  it("ignores approvals from the agent account and counts the merge token owner's", async () => {
    stubFetch(githubRoutes(["crc-bot"]));
    assert.equal((await github.fetchPullRequest("acme/widgets", "12")).approvedByHuman, false);
    stubFetch(githubRoutes(["owner"]));
    assert.equal((await github.fetchPullRequest("acme/widgets", "12")).approvedByHuman, true);
  });

  it("names the merge token in a refused merge's error", async () => {
    stubFetch(githubRoutes([], 405));
    await assert.rejects(
      github.mergePullRequest("acme/widgets", "12"),
      /^Error: GitHub API error \(using GITHUB_MERGE_TOKEN\): 405 Error: protected branch$/,
    );
  });

  it("names the agent token in a refused rebase's error", async () => {
    stubFetch([() => ({ status: 403, text: "forbidden" })]);
    await assert.rejects(github.rebasePullRequest("acme/widgets", "12"), /\(using GITHUB_TOKEN\): 403/);
  });
});

describe("GitLab with GITLAB_MERGE_TOKEN set", () => {
  it("merges with the merge token and the configured merge method", async () => {
    const requests = stubFetch(gitlabRoutes([]));
    await gitlab.mergeMergeRequest("acme/widgets", "5");
    assert.deepEqual(requests, [
      {
        method: "PUT",
        url: "https://gitlab.test/api/v4/projects/acme%2Fwidgets/merge_requests/5/merge",
        token: "gl-merge",
        body: { squash: true },
      },
    ]);
  });

  it("approves the merge request at the given head with the merge token", async () => {
    const requests = stubFetch([
      (request) =>
        request.url === "https://gitlab.test/api/v4/projects/acme%2Fwidgets/merge_requests/5/approve" ? { json: {} } : null,
    ]);
    await gitlab.approveMergeRequest("acme/widgets", "5", "def456");
    assert.deepEqual(requests, [
      {
        method: "POST",
        url: "https://gitlab.test/api/v4/projects/acme%2Fwidgets/merge_requests/5/approve",
        token: "gl-merge",
        body: { sha: "def456" },
      },
    ]);
  });

  it("names the merge token in a refused approval's error", async () => {
    stubFetch([() => ({ status: 401, text: "You are not allowed to approve" })]);
    await assert.rejects(
      gitlab.approveMergeRequest("acme/widgets", "5", "def456"),
      /^Error: GitLab API error \(using GITLAB_MERGE_TOKEN\): 401 Error: You are not allowed to approve$/,
    );
  });

  it("rebases with the agent token", async () => {
    const requests = stubFetch(gitlabRoutes([]));
    await gitlab.rebaseMergeRequest("acme/widgets", "5");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://gitlab.test/api/v4/projects/acme%2Fwidgets/merge_requests/5/rebase");
    assert.equal(requests[0].token, "gl-agent");
  });

  it("reads with the agent token only", async () => {
    const requests = stubFetch(gitlabRoutes([]));
    await gitlab.fetchRepos();
    await gitlab.fetchMergeRequest("acme/widgets", "5");
    await gitlab.fetchMergeRequestDiffHash("acme/widgets", "5");
    assert.ok(requests.some((request) => request.url === "https://gitlab.test/api/v4/user"));
    assert.deepEqual(tokensUsed(requests), ["gl-agent"]);
  });

  it("ignores approvals from the agent account and counts the merge token owner's", async () => {
    stubFetch(gitlabRoutes(["crc-bot"]));
    assert.equal((await gitlab.fetchMergeRequest("acme/widgets", "5")).approvedByHuman, false);
    stubFetch(gitlabRoutes(["owner"]));
    assert.equal((await gitlab.fetchMergeRequest("acme/widgets", "5")).approvedByHuman, true);
  });

  it("names the merge token in a refused merge's error", async () => {
    stubFetch(gitlabRoutes([], 405));
    await assert.rejects(
      gitlab.mergeMergeRequest("acme/widgets", "5"),
      /^Error: GitLab API error \(using GITLAB_MERGE_TOKEN\): 405 Error: protected branch$/,
    );
  });
});

describe("buildContainerEnv with merge tokens set", () => {
  const base = {
    repoUrl: "https://github.com/acme/widgets.git",
    gitlabUrl: "https://gitlab.test",
    gitUsername: "bot",
    gitEmail: "bot@example.com",
    initialPrompt: undefined,
    configEnv: { FOO: "bar" },
  };

  for (const repoSource of ["github", "gitlab"] as const) {
    it(`passes only the agent token to a ${repoSource} container`, () => {
      const env = buildContainerEnv({ ...base, repoSource });
      const agentToken = repoSource === "github" ? "GITHUB_TOKEN=gh-agent" : "GITLAB_TOKEN=gl-agent";
      assert.ok(env.includes(agentToken));
      assert.ok(env.includes("FOO=bar"));
      assert.equal(env.filter((entry) => entry.includes("MERGE_TOKEN")).length, 0);
      assert.equal(env.filter((entry) => entry.includes("gh-merge") || entry.includes("gl-merge")).length, 0);
    });
  }

  it("refuses a config env entry named like a merge token", () => {
    assert.throws(
      () => buildContainerEnv({ ...base, repoSource: "github", configEnv: { GITHUB_MERGE_TOKEN: "anything" } }),
      /^Error: Refusing to pass GITHUB_MERGE_TOKEN into an agent container$/,
    );
  });

  it("refuses a config env entry carrying a merge token's value", () => {
    assert.throws(
      () => buildContainerEnv({ ...base, repoSource: "github", configEnv: { GH_TOKEN: "gh-merge" } }),
      /^Error: Refusing to pass the value of GITHUB_MERGE_TOKEN into an agent container$/,
    );
    assert.throws(
      () => buildContainerEnv({ ...base, repoSource: "github", configEnv: { GLAB_TOKEN: "gl-merge" } }),
      /^Error: Refusing to pass the value of GITLAB_MERGE_TOKEN into an agent container$/,
    );
  });
});
