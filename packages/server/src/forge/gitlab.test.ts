import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapGitLabCiState,
  mapGitLabState,
  mapMergeRequestDetail,
  summarizeDiscussions,
  type GitLabDiscussion,
  type GitLabMergeRequestDetail,
} from "./gitlab.js";

function makeDetail(overrides: Partial<GitLabMergeRequestDetail> = {}): GitLabMergeRequestDetail {
  return {
    iid: 34,
    title: "Add widgets",
    web_url: "https://gitlab.com/acme/widgets/-/merge_requests/34",
    description: "body",
    state: "opened",
    sha: "abc123",
    has_conflicts: false,
    diverged_commits_count: 0,
    detailed_merge_status: "mergeable",
    head_pipeline: { status: "success" },
    ...overrides,
  };
}

function makeNote(overrides: Partial<GitLabDiscussion["notes"][number]> = {}): GitLabDiscussion["notes"][number] {
  return { body: "Please fix this", system: false, resolvable: true, resolved: false, ...overrides };
}

const NO_DISCUSSIONS = { hasUnresolvedComments: false, hasPlaceholderComment: false };

describe("summarizeDiscussions", () => {
  it("reports an unresolved discussion only while a resolvable note is unresolved", () => {
    assert.equal(summarizeDiscussions([]).hasUnresolvedComments, false);
    assert.equal(
      summarizeDiscussions([{ notes: [makeNote({ resolved: true })] }]).hasUnresolvedComments,
      false,
    );
    assert.equal(
      summarizeDiscussions([{ notes: [makeNote({ resolvable: false })] }]).hasUnresolvedComments,
      false,
    );
    assert.equal(summarizeDiscussions([{ notes: [makeNote()] }]).hasUnresolvedComments, true);
  });

  it("flags a note that is nothing but the stdin marker", () => {
    for (const marker of ["@-", "-", " @-\n"]) {
      const discussions = [{ notes: [makeNote({ body: "Real note" }), makeNote({ body: marker })] }];
      assert.equal(
        summarizeDiscussions(discussions).hasPlaceholderComment,
        true,
        `marker=${JSON.stringify(marker)}`,
      );
    }
  });

  it("leaves real notes alone, including ones that merely mention the marker", () => {
    const discussions = [
      { notes: [makeNote({ body: "Do not pass `@-` here" }), makeNote({ body: "- fix\n- test" })] },
    ];
    assert.equal(summarizeDiscussions(discussions).hasPlaceholderComment, false);
  });

  it("ignores GitLab's own system notes", () => {
    const discussions = [{ notes: [makeNote({ body: "-", system: true, resolvable: false })] }];
    assert.equal(summarizeDiscussions(discussions).hasPlaceholderComment, false);
  });
});

describe("mapGitLabCiState", () => {
  it("maps pipeline statuses to CI states", () => {
    assert.equal(mapGitLabCiState(null), "none");
    assert.equal(mapGitLabCiState("created"), "pending");
    assert.equal(mapGitLabCiState("waiting_for_resource"), "pending");
    assert.equal(mapGitLabCiState("preparing"), "pending");
    assert.equal(mapGitLabCiState("pending"), "pending");
    assert.equal(mapGitLabCiState("scheduled"), "pending");
    assert.equal(mapGitLabCiState("running"), "running");
    assert.equal(mapGitLabCiState("success"), "success");
    assert.equal(mapGitLabCiState("failed"), "failed");
    assert.equal(mapGitLabCiState("canceled"), "failed");
    assert.equal(mapGitLabCiState("skipped"), "none");
    assert.equal(mapGitLabCiState("manual"), "none");
  });

  it("throws on an unknown pipeline status", () => {
    assert.throws(() => mapGitLabCiState("something_new"));
  });
});

describe("mapGitLabState", () => {
  it("maps merge request states", () => {
    assert.equal(mapGitLabState("opened"), "open");
    assert.equal(mapGitLabState("locked"), "open");
    assert.equal(mapGitLabState("merged"), "merged");
    assert.equal(mapGitLabState("closed"), "closed");
  });

  it("throws on an unknown state", () => {
    assert.throws(() => mapGitLabState("something_new"));
  });
});

describe("mapMergeRequestDetail", () => {
  it("keys the id off the iid so it matches in-container code-status ids", () => {
    const item = mapMergeRequestDetail(makeDetail(), NO_DISCUSSIONS, false);
    assert.equal(item.id, "34");
    assert.equal(item.reference, "!34");
    assert.equal(item.kind, "merge_request");
  });

  it("maps a clean, green merge request", () => {
    const item = mapMergeRequestDetail(makeDetail(), NO_DISCUSSIONS, true);
    assert.deepEqual(item, {
      id: "34",
      reference: "!34",
      title: "Add widgets",
      url: "https://gitlab.com/acme/widgets/-/merge_requests/34",
      body: "body",
      kind: "merge_request",
      state: "open",
      headSha: "abc123",
      ciState: "success",
      hasConflicts: false,
      needsRebase: false,
      mergeStateKnown: true,
      approvedByHuman: true,
      hasUnresolvedComments: false,
      hasPlaceholderComment: false,
    });
  });

  it("flags divergence from the target branch as needing rebase", () => {
    const item = mapMergeRequestDetail(makeDetail({ diverged_commits_count: 3 }), NO_DISCUSSIONS, false);
    assert.equal(item.needsRebase, true);
  });

  it("treats an unsettled merge status as unknown, never as clean", () => {
    for (const status of ["checking", "unchecked", "preparing"]) {
      const item = mapMergeRequestDetail(makeDetail({ detailed_merge_status: status }), NO_DISCUSSIONS, false);
      assert.equal(item.mergeStateKnown, false, `detailed_merge_status=${status}`);
    }
  });

  it("falls back to merge_status when detailed_merge_status is absent", () => {
    const item = mapMergeRequestDetail(
      makeDetail({ detailed_merge_status: undefined, merge_status: "checking" }),
      NO_DISCUSSIONS,
      false,
    );
    assert.equal(item.mergeStateKnown, false);
  });

  it("treats a missing pipeline as no CI", () => {
    const item = mapMergeRequestDetail(makeDetail({ head_pipeline: null }), NO_DISCUSSIONS, false);
    assert.equal(item.ciState, "none");
  });

  it("passes through conflict, discussion, and approval state", () => {
    const item = mapMergeRequestDetail(
      makeDetail({ has_conflicts: true }),
      { hasUnresolvedComments: true, hasPlaceholderComment: true },
      false,
    );
    assert.equal(item.hasConflicts, true);
    assert.equal(item.hasUnresolvedComments, true);
    assert.equal(item.hasPlaceholderComment, true);
    assert.equal(item.approvedByHuman, false);
  });
});
