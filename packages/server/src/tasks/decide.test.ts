import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Task, TaskAttempt } from "../types.js";
import { decide, PER_STEP_SPAWN_CAP, REVIEW_CYCLE_CAP, TOTAL_SPAWN_CAP } from "./decide.js";
import { makeAttempt, makeLinkedTask, makeReviewRequest, makeTask } from "../testing/fixtures.js";

describe("decide: terminal and guard states", () => {
  it("does nothing for paused tasks", () => {
    assert.deepEqual(decide(makeTask({ phase: "paused" }), null), { kind: "noop", phase: null });
  });

  it("does nothing for merged tasks", () => {
    assert.deepEqual(decide(makeTask({ phase: "merged" }), null), { kind: "noop", phase: null });
  });

  it("does nothing for failed tasks", () => {
    assert.deepEqual(decide(makeTask({ phase: "failed" }), null), { kind: "noop", phase: null });
  });

  it("throws if called while an agent container is active", () => {
    assert.throws(() => decide(makeTask({ activeContainerId: "c0ffee0000000000" }), null));
  });

  it("throws if given forge state for a task with no linked PR/MR", () => {
    assert.throws(() => decide(makeTask(), makeReviewRequest()));
  });

  it("throws if the linked PR/MR's forge state is missing", () => {
    assert.throws(() => decide(makeLinkedTask(), null));
  });
});

describe("decide: rules 0-1 (no PR/MR yet)", () => {
  it("rule 0: spawns an implement agent for a fresh task", () => {
    assert.deepEqual(decide(makeTask(), null), { kind: "spawn", step: "implement", headShaBefore: null });
  });

  it("rule 1: fails when implement already ran without opening a PR/MR", () => {
    const task = makeTask({
      attemptsByStep: { implement: 1, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
    });
    const decision = decide(task, null);
    assert.equal(decision.kind, "fail");
    assert.match((decision as { reason: string }).reason, /finished without opening/);
  });

  it("rule 1: attributes the failure to the attempt error when implement did not finish cleanly", () => {
    const task = makeTask({
      attemptsByStep: { implement: 1, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
      attempts: [
        {
          step: "implement",
          containerId: "c0ffee0000000000",
          headShaBefore: null,
          startedAt: "2026-08-20T10:00:00.000Z",
          finishedAt: "2026-08-20T12:00:00.000Z",
          error: "Attempt timed out after 120 minutes",
        },
      ],
    });
    const decision = decide(task, null);
    assert.equal(decision.kind, "fail");
    assert.match((decision as { reason: string }).reason, /timed out after 120 minutes/);
  });
});

describe("decide: rules 2-3 (PR/MR no longer open)", () => {
  it("rule 2: marks the task merged when the PR/MR is merged", () => {
    assert.deepEqual(decide(makeLinkedTask(), makeReviewRequest({ state: "merged" })), {
      kind: "mark_merged",
    });
  });

  it("rule 3: fails when the PR/MR was closed without merging", () => {
    const decision = decide(makeLinkedTask(), makeReviewRequest({ state: "closed" }));
    assert.equal(decision.kind, "fail");
  });
});

describe("decide: rules 4-5 (CI)", () => {
  it("rule 4: waits while CI is pending", () => {
    assert.deepEqual(decide(makeLinkedTask(), makeReviewRequest({ ciState: "pending" })), {
      kind: "noop",
      phase: "waiting_ci",
    });
  });

  it("rule 4: waits while CI is running", () => {
    assert.deepEqual(decide(makeLinkedTask(), makeReviewRequest({ ciState: "running" })), {
      kind: "noop",
      phase: "waiting_ci",
    });
  });

  it("rule 5: spawns a fix_ci agent when CI failed", () => {
    assert.deepEqual(decide(makeLinkedTask(), makeReviewRequest({ ciState: "failed" })), {
      kind: "spawn",
      step: "fix_ci",
      headShaBefore: null,
    });
  });

  it("rule 5 outranks unknown merge state", () => {
    const decision = decide(
      makeLinkedTask(),
      makeReviewRequest({ ciState: "failed", mergeStateKnown: false }),
    );
    assert.deepEqual(decision, { kind: "spawn", step: "fix_ci", headShaBefore: null });
  });

  it("a repo with no CI falls through to the later rules", () => {
    const decision = decide(makeLinkedTask(), makeReviewRequest({ ciState: "none", headSha: "def456" }));
    assert.deepEqual(decision, { kind: "spawn", step: "review", headShaBefore: "def456" });
  });
});

describe("decide: unknown merge state", () => {
  it("waits until the forge has computed mergeability", () => {
    assert.deepEqual(decide(makeLinkedTask(), makeReviewRequest({ mergeStateKnown: false })), {
      kind: "noop",
      phase: null,
    });
  });
});

describe("decide: rules 6-7 (divergence and conflicts)", () => {
  it("rule 6: rebases via the forge API on GitLab when behind without conflicts", () => {
    const task = makeLinkedTask({ repoSource: "gitlab" });
    assert.deepEqual(decide(task, makeReviewRequest({ needsRebase: true, kind: "merge_request" })), {
      kind: "forge_rebase",
    });
  });

  it("rule 6: spawns a rebase agent on GitHub when behind without conflicts", () => {
    assert.deepEqual(decide(makeLinkedTask(), makeReviewRequest({ needsRebase: true })), {
      kind: "spawn",
      step: "rebase",
      headShaBefore: null,
    });
  });

  it("rule 7: spawns a rebase agent on conflicts", () => {
    assert.deepEqual(decide(makeLinkedTask(), makeReviewRequest({ hasConflicts: true })), {
      kind: "spawn",
      step: "rebase",
      headShaBefore: null,
    });
  });

  it("rule 7: conflicts route to the rebase agent even on GitLab and even when also behind", () => {
    const task = makeLinkedTask({ repoSource: "gitlab" });
    const decision = decide(task, makeReviewRequest({ needsRebase: true, hasConflicts: true }));
    assert.deepEqual(decision, { kind: "spawn", step: "rebase", headShaBefore: null });
  });
});

describe("decide: rules 8-11 (review, comments, approval, merge)", () => {
  it("rule 8: spawns a review agent when the head has never been reviewed", () => {
    assert.deepEqual(decide(makeLinkedTask(), makeReviewRequest({ headSha: "abc123" })), {
      kind: "spawn",
      step: "review",
      headShaBefore: "abc123",
    });
  });

  it("rule 8: spawns a review agent when the head moved since the last review", () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123" });
    assert.deepEqual(decide(task, makeReviewRequest({ headSha: "def456" })), {
      kind: "spawn",
      step: "review",
      headShaBefore: "def456",
    });
  });

  it("rule 9: spawns an address_comments agent when reviewed but comments are unresolved", () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123" });
    assert.deepEqual(decide(task, makeReviewRequest({ hasUnresolvedComments: true })), {
      kind: "spawn",
      step: "address_comments",
      headShaBefore: null,
    });
  });

  it("rule 10: waits for a human when reviewed, comment-free, and unapproved", () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123" });
    assert.deepEqual(decide(task, makeReviewRequest()), { kind: "noop", phase: "waiting_approval" });
  });

  it("rule 11: merges once a human has approved", () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123" });
    assert.deepEqual(decide(task, makeReviewRequest({ approvedByHuman: true })), { kind: "merge" });
  });
});

describe("decide: spawn caps", () => {
  it("fails instead of spawning fix_ci a fourth time", () => {
    const task = makeLinkedTask({
      attemptsByStep: {
        implement: 1,
        fix_ci: PER_STEP_SPAWN_CAP,
        rebase: 0,
        review: 0,
        address_comments: 0,
      },
    });
    const decision = decide(task, makeReviewRequest({ ciState: "failed" }));
    assert.equal(decision.kind, "fail");
  });

  it("fails instead of spawning rebase past its cap", () => {
    const task = makeLinkedTask({
      attemptsByStep: {
        implement: 1,
        fix_ci: 0,
        rebase: PER_STEP_SPAWN_CAP,
        review: 0,
        address_comments: 0,
      },
    });
    const decision = decide(task, makeReviewRequest({ hasConflicts: true }));
    assert.equal(decision.kind, "fail");
  });

  it("review and address_comments are not per-step capped", () => {
    const task = makeLinkedTask({
      attemptsByStep: {
        implement: 1,
        fix_ci: 0,
        rebase: 0,
        review: PER_STEP_SPAWN_CAP + 2,
        address_comments: 0,
      },
    });
    const decision = decide(task, makeReviewRequest({ headSha: "def456" }));
    assert.deepEqual(decision, { kind: "spawn", step: "review", headShaBefore: "def456" });
  });

  it("fails any spawn once the total cap is reached", () => {
    const task = makeLinkedTask({
      attemptsByStep: {
        implement: 1,
        fix_ci: 0,
        rebase: 0,
        review: 6,
        address_comments: TOTAL_SPAWN_CAP - 7,
      },
    });
    const decision = decide(task, makeReviewRequest({ headSha: "def456" }));
    assert.equal(decision.kind, "fail");
  });
});

function totalAttemptsOf(task: Task): number {
  return Object.values(task.attemptsByStep).reduce((sum, count) => sum + count, 0);
}

function reviewCycleAttempts(cycles: number): TaskAttempt[] {
  const attempts: TaskAttempt[] = [makeAttempt({ step: "implement" })];
  for (let i = 0; i < cycles; i++) {
    attempts.push(makeAttempt({ step: "review" }), makeAttempt({ step: "address_comments" }));
  }
  return attempts;
}

function cyclingTask(cycles: number, overrides: Partial<Task> = {}): Task {
  const attempts = reviewCycleAttempts(cycles);
  return makeLinkedTask({
    attempts,
    attemptsByStep: {
      implement: 1,
      fix_ci: 0,
      rebase: 0,
      review: cycles,
      address_comments: cycles,
    },
    ...overrides,
  });
}

describe("decide: review/address_comments cycle cap", () => {
  it("keeps cycling while under the cap", () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP - 1);
    assert.deepEqual(decide(task, makeReviewRequest({ headSha: "def456" })), {
      kind: "spawn",
      step: "review",
      headShaBefore: "def456",
    });
  });

  it("fails instead of spawning yet another review once the cap is reached", () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP);
    const decision = decide(task, makeReviewRequest({ headSha: "def456" }));
    assert.equal(decision.kind, "fail");
    assert.match((decision as { reason: string }).reason, /cycled 3 times/);
  });

  it("fails instead of spawning yet another address_comments once the cap is reached", () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP, { lastReviewedSha: "abc123" });
    const decision = decide(task, makeReviewRequest({ hasUnresolvedComments: true }));
    assert.equal(decision.kind, "fail");
    assert.match((decision as { reason: string }).reason, /cycled 3 times/);
  });

  it("fails well before the total spawn cap, with a reason naming the cycle", () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP);
    const decision = decide(task, makeReviewRequest({ headSha: "def456" }));
    assert.equal(decision.kind, "fail");
    const reason = (decision as { reason: string }).reason;
    assert.doesNotMatch(reason, /total spawn cap/);
    assert.match(reason, /Review and comment-addressing/);
    assert.ok(totalAttemptsOf(task) < TOTAL_SPAWN_CAP);
  });

  it("only counts the trailing run, so an intervening step resets the cycle", () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP, { lastReviewedSha: "abc123" });
    task.attempts.push(makeAttempt({ step: "fix_ci" }));
    task.attemptsByStep.fix_ci = 1;
    assert.deepEqual(decide(task, makeReviewRequest({ hasUnresolvedComments: true })), {
      kind: "spawn",
      step: "address_comments",
      headShaBefore: null,
    });
  });

  it("does not cap steps outside the cycle", () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP);
    assert.deepEqual(decide(task, makeReviewRequest({ hasConflicts: true })), {
      kind: "spawn",
      step: "rebase",
      headShaBefore: null,
    });
  });

  it("back-to-back reviews with no comments addressed do not count as cycles", () => {
    const task = makeLinkedTask({
      attempts: [
        makeAttempt({ step: "implement" }),
        makeAttempt({ step: "review" }),
        makeAttempt({ step: "review" }),
        makeAttempt({ step: "review" }),
        makeAttempt({ step: "review" }),
      ],
      attemptsByStep: { implement: 1, fix_ci: 0, rebase: 0, review: 4, address_comments: 0 },
    });
    assert.deepEqual(decide(task, makeReviewRequest({ headSha: "def456" })), {
      kind: "spawn",
      step: "review",
      headShaBefore: "def456",
    });
  });
});
