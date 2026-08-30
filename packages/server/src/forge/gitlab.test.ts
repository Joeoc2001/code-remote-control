import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hashMergeRequestDiffs,
  mapGitLabCiState,
  mapGitLabState,
  mapMergeRequestDetail,
  summariseDiscussions,
  type GitLabDiscussionNote,
  type GitLabMergeRequestDetail,
  type GitLabMergeRequestDiff,
} from "./gitlab.js";

const noDiscussionFlags = { hasUnresolvedComments: false, hasPlaceholderComment: false };

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
    const item = mapMergeRequestDetail(makeDetail(), noDiscussionFlags, false);
    assert.equal(item.id, "34");
    assert.equal(item.reference, "!34");
    assert.equal(item.kind, "merge_request");
  });

  it("maps a clean, green merge request", () => {
    const item = mapMergeRequestDetail(makeDetail(), noDiscussionFlags, true);
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
    const item = mapMergeRequestDetail(makeDetail({ diverged_commits_count: 3 }), noDiscussionFlags, false);
    assert.equal(item.needsRebase, true);
  });

  it("treats an unsettled merge status as unknown, never as clean", () => {
    for (const status of ["checking", "unchecked", "preparing"]) {
      const item = mapMergeRequestDetail(makeDetail({ detailed_merge_status: status }), noDiscussionFlags, false);
      assert.equal(item.mergeStateKnown, false, `detailed_merge_status=${status}`);
    }
  });

  it("falls back to merge_status when detailed_merge_status is absent", () => {
    const item = mapMergeRequestDetail(
      makeDetail({ detailed_merge_status: undefined, merge_status: "checking" }),
      noDiscussionFlags,
      false,
    );
    assert.equal(item.mergeStateKnown, false);
  });

  it("treats a missing pipeline as no CI", () => {
    const item = mapMergeRequestDetail(makeDetail({ head_pipeline: null }), noDiscussionFlags, false);
    assert.equal(item.ciState, "none");
  });

  it("passes through a placeholder comment flagged in the discussions", () => {
    const item = mapMergeRequestDetail(
      makeDetail(),
      { hasUnresolvedComments: false, hasPlaceholderComment: true },
      false,
    );
    assert.equal(item.hasPlaceholderComment, true);
  });

  it("passes through conflict, discussion, and approval state", () => {
    const item = mapMergeRequestDetail(
      makeDetail({ has_conflicts: true }),
      { hasUnresolvedComments: true, hasPlaceholderComment: false },
      false,
    );
    assert.equal(item.hasConflicts, true);
    assert.equal(item.hasUnresolvedComments, true);
    assert.equal(item.approvedByHuman, false);
  });
});

describe("summariseDiscussions", () => {
  function makeNote(overrides: Partial<GitLabDiscussionNote> = {}): GitLabDiscussionNote {
    return { resolvable: false, resolved: false, system: false, body: "looks good", ...overrides };
  }

  it("reports a clean discussion list as neither unresolved nor placeholder", () => {
    assert.deepEqual(summariseDiscussions([{ notes: [makeNote({ resolvable: true, resolved: true })] }]), {
      hasUnresolvedComments: false,
      hasPlaceholderComment: false,
    });
  });

  it("reports an unresolved resolvable note", () => {
    const summary = summariseDiscussions([{ notes: [makeNote({ resolvable: true, resolved: false })] }]);
    assert.equal(summary.hasUnresolvedComments, true);
    assert.equal(summary.hasPlaceholderComment, false);
  });

  it("reports a note whose whole body is a stdin placeholder", () => {
    const summary = summariseDiscussions([
      { notes: [makeNote(), makeNote({ body: "@-" })] },
    ]);
    assert.equal(summary.hasPlaceholderComment, true);
    assert.equal(summary.hasUnresolvedComments, false);
  });

  it("ignores system notes, which the agent never wrote", () => {
    const summary = summariseDiscussions([{ notes: [makeNote({ system: true, body: "-" })] }]);
    assert.equal(summary.hasPlaceholderComment, false);
  });

  it("keeps flags raised by earlier pages", () => {
    const summary = summariseDiscussions([{ notes: [makeNote()] }], {
      hasUnresolvedComments: true,
      hasPlaceholderComment: true,
    });
    assert.deepEqual(summary, { hasUnresolvedComments: true, hasPlaceholderComment: true });
  });
});

function makeDiff(overrides: Partial<GitLabMergeRequestDiff> = {}): GitLabMergeRequestDiff {
  return {
    old_path: "src/widget.ts",
    new_path: "src/widget.ts",
    a_mode: "100644",
    b_mode: "100644",
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff: "@@ -1,3 +1,4 @@\n context\n+added\n context\n",
    ...overrides,
  };
}

describe("hashMergeRequestDiffs", () => {
  const readme = makeDiff({ old_path: "README.md", new_path: "README.md", diff: "@@ -1 +1 @@\n-a\n+b\n" });

  it("hashes the same changes to the same value regardless of the order they arrive in", () => {
    assert.equal(
      hashMergeRequestDiffs([makeDiff(), readme]),
      hashMergeRequestDiffs([readme, makeDiff()]),
    );
  });

  it("changes when a hunk changes", () => {
    assert.notEqual(
      hashMergeRequestDiffs([makeDiff()]),
      hashMergeRequestDiffs([makeDiff({ diff: "@@ -1,3 +1,4 @@\n context\n+something else\n context\n" })]),
    );
  });

  it("changes when a file is renamed", () => {
    assert.notEqual(
      hashMergeRequestDiffs([makeDiff()]),
      hashMergeRequestDiffs([makeDiff({ new_path: "src/gadget.ts", renamed_file: true })]),
    );
  });

  it("changes when a file's mode changes", () => {
    assert.notEqual(
      hashMergeRequestDiffs([makeDiff()]),
      hashMergeRequestDiffs([makeDiff({ b_mode: "100755" })]),
    );
  });

  it("changes when a file joins or leaves the change set", () => {
    assert.notEqual(hashMergeRequestDiffs([makeDiff()]), hashMergeRequestDiffs([makeDiff(), readme]));
    assert.notEqual(hashMergeRequestDiffs([makeDiff()]), hashMergeRequestDiffs([]));
  });

  it("keeps path and diff text unambiguous when either contains the separator", () => {
    assert.notEqual(
      hashMergeRequestDiffs([makeDiff({ new_path: "a", diff: "b\nc" })]),
      hashMergeRequestDiffs([makeDiff({ new_path: "a\nb", diff: "c" })]),
    );
  });

  it("refuses to hash a change set in which any file arrived without diff text", () => {
    assert.equal(hashMergeRequestDiffs([makeDiff(), makeDiff({ diff: "" })]), null);
  });
});
