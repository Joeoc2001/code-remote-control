import type { Task, TaskPhase } from "@crc/shared";

export function makeTask(id: string, phase: TaskPhase, createdAt: string): Task {
  return {
    id,
    repoFullName: "example/repo",
    repoSource: "github",
    workItem: {
      id,
      reference: `#${id}`,
      title: `Task ${id}`,
      url: `https://example.test/issues/${id}`,
      body: null,
      kind: "issue",
    },
    sourceText: null,
    createdIssueUrl: null,
    configByStep: {
      implement: "default",
      fix_ci: "default",
      rebase: "default",
      review: "default",
      address_comments: "default",
    },
    phase,
    reviewRequest: null,
    lastReviewedSha: null,
    lastReviewedDiffHash: null,
    activeContainerId: null,
    activeStep: null,
    attemptsByStep: { implement: 1, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
    attempts: [],
    completedStages: [],
    stageStartedAt: createdAt,
    mergedAt: null,
    consecutiveErrors: 0,
    error: null,
    createdAt,
    updatedAt: createdAt,
  };
}
