import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapGitHubCiState,
  mapGitHubState,
  mapPullRequestNode,
  type GitHubPullRequestNode,
} from "./github.js";

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
    viewerCanUpdateBranch: false,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    comments: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    ...overrides,
  };
}

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
        reviewThreads: {
          nodes: [
            { isResolved: true, comments: { nodes: [{ body: "looks good" }] } },
            { isResolved: false, comments: { nodes: [{ body: "please rename this" }] } },
          ],
        },
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

  it("flags a behind PR as needing rebase even when protection reports BLOCKED instead of BEHIND", () => {
    const item = mapPullRequestNode(
      makeNode({ mergeStateStatus: "BLOCKED", viewerCanUpdateBranch: true }),
      "bot-login",
    );
    assert.equal(item.needsRebase, true);
    assert.equal(item.hasConflicts, false);
  });

  it("flags a behind PR as needing rebase even when it reports CLEAN without strict protection", () => {
    const item = mapPullRequestNode(
      makeNode({ mergeStateStatus: "CLEAN", viewerCanUpdateBranch: true }),
      "bot-login",
    );
    assert.equal(item.needsRebase, true);
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

  it("flags a plain pull request comment whose whole body is a stdin placeholder", () => {
    const item = mapPullRequestNode(
      makeNode({ comments: { nodes: [{ body: "Looks good" }, { body: "@-" }] } }),
      "bot-login",
    );
    assert.equal(item.hasPlaceholderComment, true);
  });

  it("flags a review summary whose whole body is a stdin placeholder", () => {
    const item = mapPullRequestNode(
      makeNode({ reviews: { nodes: [{ body: "" }, { body: "@-" }] } }),
      "bot-login",
    );
    assert.equal(item.hasPlaceholderComment, true);
  });

  it("does not mistake an approval with no summary text for a placeholder", () => {
    const item = mapPullRequestNode(makeNode({ reviews: { nodes: [{ body: "" }] } }), "bot-login");
    assert.equal(item.hasPlaceholderComment, false);
  });

  it("flags a review thread comment whose whole body is a stdin placeholder", () => {
    const item = mapPullRequestNode(
      makeNode({
        reviewThreads: {
          nodes: [{ isResolved: false, comments: { nodes: [{ body: "rename this" }, { body: "-" }] } }],
        },
      }),
      "bot-login",
    );
    assert.equal(item.hasPlaceholderComment, true);
  });

  it("leaves real comments unflagged", () => {
    const item = mapPullRequestNode(
      makeNode({
        comments: { nodes: [{ body: "Pass the body with `@-` only to `gh api`" }] },
        reviewThreads: {
          nodes: [{ isResolved: false, comments: { nodes: [{ body: "- rename this\n- and this" }] } }],
        },
      }),
      "bot-login",
    );
    assert.equal(item.hasPlaceholderComment, false);
  });
});
