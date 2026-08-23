import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GRAPHQL_NODE_LIMIT,
  listingQueryNodeCount,
  mapGitHubCiState,
  mapGitHubState,
  mapPullRequestNode,
  type GitHubPullRequestNode,
} from "./github.js";

function makeThread(
  isResolved: boolean,
  bodies: string[],
): GitHubPullRequestNode["reviewThreads"]["nodes"][number] {
  return { isResolved, comments: { nodes: bodies.map((body) => ({ body })) } };
}

function makeNode(overrides: Partial<GitHubPullRequestNode> = {}): GitHubPullRequestNode {
  return {
    number: 12,
    title: "Add widgets",
    url: "https://github.com/acme/widgets/pull/12",
    body: "body",
    state: "OPEN",
    headRefOid: "abc123",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    reviewThreads: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    ...overrides,
  };
}

describe("the open pull request listing query", () => {
  it("stays inside GitHub's node limit now that it also pulls comment bodies", () => {
    assert.ok(
      listingQueryNodeCount() <= GRAPHQL_NODE_LIMIT,
      `listing query asks for ${listingQueryNodeCount()} nodes, limit is ${GRAPHQL_NODE_LIMIT}`,
    );
  });
});

describe("review comment bodies", () => {
  it("flags a review comment that is nothing but the stdin marker", () => {
    for (const marker of ["@-", "-", " @- "]) {
      const item = mapPullRequestNode(
        makeNode({ reviewThreads: { nodes: [makeThread(false, ["Real comment", marker])] } }),
        "bot-login",
      );
      assert.equal(item.hasPlaceholderComment, true, `marker=${JSON.stringify(marker)}`);
    }
  });

  it("leaves real review comments alone, including ones that merely mention the marker", () => {
    const item = mapPullRequestNode(
      makeNode({
        reviewThreads: {
          nodes: [makeThread(false, ["Do not pass `@-` here", "- fix the typo\n- add a test"])],
        },
      }),
      "bot-login",
    );
    assert.equal(item.hasPlaceholderComment, false);
  });
});

describe("mapGitHubCiState", () => {
  it("maps rollup states to CI states", () => {
    assert.equal(mapGitHubCiState(null), "none");
    assert.equal(mapGitHubCiState("SUCCESS"), "success");
    assert.equal(mapGitHubCiState("FAILURE"), "failed");
    assert.equal(mapGitHubCiState("ERROR"), "failed");
    assert.equal(mapGitHubCiState("PENDING"), "running");
    assert.equal(mapGitHubCiState("EXPECTED"), "running");
  });

  it("throws on an unknown rollup state", () => {
    assert.throws(() => mapGitHubCiState("SOMETHING_NEW"));
  });
});

describe("mapGitHubState", () => {
  it("maps pull request states", () => {
    assert.equal(mapGitHubState("OPEN"), "open");
    assert.equal(mapGitHubState("MERGED"), "merged");
    assert.equal(mapGitHubState("CLOSED"), "closed");
  });
});

describe("mapPullRequestNode", () => {
  it("maps a clean, green, reviewed pull request", () => {
    const item = mapPullRequestNode(makeNode(), "bot-login");
    assert.deepEqual(item, {
      id: "12",
      reference: "#12",
      title: "Add widgets",
      url: "https://github.com/acme/widgets/pull/12",
      body: "body",
      kind: "pull_request",
      state: "open",
      headSha: "abc123",
      ciState: "success",
      hasConflicts: false,
      needsRebase: false,
      mergeStateKnown: true,
      approvedByHuman: false,
      hasUnresolvedComments: false,
      hasPlaceholderComment: false,
    });
  });

  it("detects conflicts, divergence, and unresolved threads", () => {
    const item = mapPullRequestNode(
      makeNode({
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        reviewThreads: { nodes: [makeThread(true, ["Looks good"]), makeThread(false, ["Please fix"])] },
      }),
      "bot-login",
    );
    assert.equal(item.hasConflicts, true);
    assert.equal(item.needsRebase, false);
    assert.equal(item.hasUnresolvedComments, true);
  });

  it("flags a PR behind its base branch as needing rebase", () => {
    const item = mapPullRequestNode(makeNode({ mergeStateStatus: "BEHIND" }), "bot-login");
    assert.equal(item.needsRebase, true);
    assert.equal(item.hasConflicts, false);
  });

  it("treats UNKNOWN mergeability as unsettled, never as clean", () => {
    assert.equal(mapPullRequestNode(makeNode({ mergeable: "UNKNOWN" }), "bot-login").mergeStateKnown, false);
    assert.equal(
      mapPullRequestNode(makeNode({ mergeStateStatus: "UNKNOWN" }), "bot-login").mergeStateKnown,
      false,
    );
  });

  it("maps a missing status check rollup to ciState none", () => {
    const item = mapPullRequestNode(
      makeNode({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }),
      "bot-login",
    );
    assert.equal(item.ciState, "none");
  });

  it("counts an approval only when it is not from the token's own account", () => {
    const selfApproved = makeNode({
      latestOpinionatedReviews: { nodes: [{ state: "APPROVED", author: { login: "bot-login" } }] },
    });
    assert.equal(mapPullRequestNode(selfApproved, "bot-login").approvedByHuman, false);

    const humanApproved = makeNode({
      latestOpinionatedReviews: {
        nodes: [
          { state: "CHANGES_REQUESTED", author: { login: "reviewer" } },
          { state: "APPROVED", author: { login: "human" } },
        ],
      },
    });
    assert.equal(mapPullRequestNode(humanApproved, "bot-login").approvedByHuman, true);

    const ghostApproved = makeNode({
      latestOpinionatedReviews: { nodes: [{ state: "APPROVED", author: null }] },
    });
    assert.equal(mapPullRequestNode(ghostApproved, "bot-login").approvedByHuman, false);
  });
});
