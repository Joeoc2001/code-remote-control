import type { RepoReviewRequest, Task, TaskAttempt } from "../types.js";

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    repoFullName: "acme/widgets",
    repoSource: "github",
    workItem: {
      id: "7",
      reference: "#7",
      title: "Add widgets",
      url: "https://github.com/acme/widgets/issues/7",
      body: null,
      kind: "issue",
    },
    configByStep: {
      implement: "default",
      fix_ci: "default",
      rebase: "default",
      review: "default",
      address_comments: "default",
    },
    phase: "spawning",
    reviewRequest: null,
    lastReviewedSha: null,
    lastReviewedDiffHash: null,
    activeContainerId: null,
    activeStep: null,
    attemptsByStep: { implement: 0, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
    attempts: [],
    consecutiveErrors: 0,
    error: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

export function makeLinkedTask(overrides: Partial<Task> = {}): Task {
  return makeTask({
    reviewRequest: {
      id: "12",
      url: "https://github.com/acme/widgets/pull/12",
      sourceBranch: "feature",
    },
    attemptsByStep: { implement: 1, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
    ...overrides,
  });
}

export function makeReviewRequest(overrides: Partial<RepoReviewRequest> = {}): RepoReviewRequest {
  return {
    id: "12",
    reference: "#12",
    title: "Add widgets",
    url: "https://github.com/acme/widgets/pull/12",
    body: "Adds widgets",
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
    ...overrides,
  };
}

export function makeAttempt(overrides: Partial<TaskAttempt> = {}): TaskAttempt {
  return {
    step: "implement",
    containerId: "c0ffee0000000000",
    headShaBefore: null,
    diffHashBefore: null,
    startedAt: "2026-08-20T10:00:00.000Z",
    finishedAt: null,
    finishedObservation: null,
    error: null,
    ...overrides,
  };
}
