import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Task, TaskAttempt } from "../types.js";
import { decide, PER_STEP_SPAWN_CAP, REVIEW_CYCLE_CAP, TOTAL_SPAWN_CAP } from "./decide.js";
import { makeAttempt, makeLinkedTask, makeReviewRequest, makeTask, makeTextTask } from "../testing/fixtures.js";

const CHANGED_DIFF = "sha256-of-a-different-diff";
const REVIEWED_DIFF = "sha256-of-the-reviewed-diff";

function diffHash(hash: string) {
  let calls = 0;
  return {
    fetch: async () => {
      calls += 1;
      return hash;
    },
    calls: () => calls,
  };
}

const changedDiff = () => async () => CHANGED_DIFF;

const noDiffFetch = async (): Promise<string> => {
  throw new Error("getDiffHash should not have been called");
};

describe("decide: terminal and guard states", () => {
  it("does nothing for paused tasks", async () => {
    assert.deepEqual(await decide(makeTask({ phase: "paused" }), null, noDiffFetch), {
      kind: "noop",
      phase: null,
    });
  });

  it("does nothing for merged tasks", async () => {
    assert.deepEqual(await decide(makeTask({ phase: "merged" }), null, noDiffFetch), {
      kind: "noop",
      phase: null,
    });
  });

  it("does nothing for failed tasks", async () => {
    assert.deepEqual(await decide(makeTask({ phase: "failed" }), null, noDiffFetch), {
      kind: "noop",
      phase: null,
    });
  });

  it("throws if called while an agent container is active", async () => {
    await assert.rejects(() =>
      decide(makeTask({ activeContainerId: "c0ffee0000000000" }), null, noDiffFetch),
    );
  });

  it("throws if given forge state for a task with no linked PR/MR", async () => {
    await assert.rejects(() => decide(makeTask(), makeReviewRequest(), noDiffFetch));
  });

  it("throws if the linked PR/MR's forge state is missing", async () => {
    await assert.rejects(() => decide(makeLinkedTask(), null, noDiffFetch));
  });
});

describe("decide: text tasks (no work item yet)", () => {
  it("spawns a create_issue agent for a fresh text task", async () => {
    assert.deepEqual(await decide(makeTextTask(), null, noDiffFetch), {
      kind: "spawn",
      step: "create_issue",
      headShaBefore: null,
      diffHashBefore: null,
    });
  });

  it("fails when create_issue already ran without reporting an issue URL", async () => {
    const task = makeTextTask({
      attemptsByStep: { create_issue: 1, implement: 0, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
    });
    const decision = await decide(task, null, noDiffFetch);
    assert.equal(decision.kind, "fail");
    assert.match((decision as { reason: string }).reason, /finished without reporting a created issue URL/);
  });

  it("attributes the failure to the attempt error when create_issue did not finish cleanly", async () => {
    const task = makeTextTask({
      attemptsByStep: { create_issue: 1, implement: 0, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
      attempts: [
        makeAttempt({
          step: "create_issue",
          finishedAt: "2026-08-20T12:00:00.000Z",
          error: "Attempt timed out after 120 minutes",
        }),
      ],
    });
    const decision = await decide(task, null, noDiffFetch);
    assert.equal(decision.kind, "fail");
    assert.match((decision as { reason: string }).reason, /timed out after 120 minutes/);
  });

  it("throws if given forge state before the issue exists", async () => {
    await assert.rejects(() => decide(makeTextTask(), makeReviewRequest(), noDiffFetch));
  });

  it("spawns an implement agent once the created issue has been adopted", async () => {
    const task = makeTextTask({
      workItem: makeTask().workItem,
      createdIssueUrl: "https://github.com/acme/widgets/issues/7",
      attemptsByStep: { create_issue: 1, implement: 0, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
    });
    assert.deepEqual(await decide(task, null, noDiffFetch), {
      kind: "spawn",
      step: "implement",
      headShaBefore: null,
      diffHashBefore: null,
    });
  });
});

describe("decide: rules 0-1 (no PR/MR yet)", () => {
  it("rule 0: spawns an implement agent for a fresh task", async () => {
    assert.deepEqual(await decide(makeTask(), null, noDiffFetch), {
      kind: "spawn",
      step: "implement",
      headShaBefore: null,
      diffHashBefore: null,
    });
  });

  it("rule 1: fails when implement already ran without opening a PR/MR", async () => {
    const task = makeTask({
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
    });
    const decision = await decide(task, null, noDiffFetch);
    assert.equal(decision.kind, "fail");
    assert.match((decision as { reason: string }).reason, /finished without opening/);
  });

  it("rule 1: attributes the failure to the attempt error when implement did not finish cleanly", async () => {
    const task = makeTask({
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
      attempts: [
        {
          step: "implement",
          containerId: "c0ffee0000000000",
          headShaBefore: null,
          diffHashBefore: null,
          startedAt: "2026-08-20T10:00:00.000Z",
          finishedAt: "2026-08-20T12:00:00.000Z",
          finishedObservation: null,
          error: "Attempt timed out after 120 minutes",
        },
      ],
    });
    const decision = await decide(task, null, noDiffFetch);
    assert.equal(decision.kind, "fail");
    assert.match((decision as { reason: string }).reason, /timed out after 120 minutes/);
  });
});

describe("decide: rules 2-3 (PR/MR no longer open)", () => {
  it("rule 2: marks the task merged when the PR/MR is merged", async () => {
    assert.deepEqual(await decide(makeLinkedTask(), makeReviewRequest({ state: "merged" }), noDiffFetch), {
      kind: "mark_merged",
    });
  });

  it("rule 3: fails when the PR/MR was closed without merging", async () => {
    const decision = await decide(makeLinkedTask(), makeReviewRequest({ state: "closed" }), noDiffFetch);
    assert.equal(decision.kind, "fail");
  });
});

describe("decide: unusable PR/MR bodies", () => {
  for (const placeholder of ["@-", "@", "-", " @- "]) {
    it(`fails when the description is the stdin placeholder ${JSON.stringify(placeholder)}`, async () => {
      const decision = await decide(
        makeLinkedTask(),
        makeReviewRequest({ body: placeholder }),
        noDiffFetch,
      );
      assert.equal(decision.kind, "fail");
      assert.match((decision as { reason: string }).reason, /stdin placeholder/);
      assert.match((decision as { reason: string }).reason, /description/);
    });
  }

  it("fails when the description is missing entirely", async () => {
    const decision = await decide(makeLinkedTask(), makeReviewRequest({ body: null }), noDiffFetch);
    assert.equal(decision.kind, "fail");
    assert.match((decision as { reason: string }).reason, /empty description/);
  });

  it("fails when the description is only whitespace", async () => {
    const decision = await decide(makeLinkedTask(), makeReviewRequest({ body: " \n " }), noDiffFetch);
    assert.equal(decision.kind, "fail");
    assert.match((decision as { reason: string }).reason, /empty description/);
  });

  it("fails when a comment on the PR/MR is a stdin placeholder", async () => {
    const decision = await decide(
      makeLinkedTask(),
      makeReviewRequest({ hasPlaceholderComment: true }),
      noDiffFetch,
    );
    assert.equal(decision.kind, "fail");
    assert.match((decision as { reason: string }).reason, /comment/);
    assert.match((decision as { reason: string }).reason, /stdin placeholder/);
  });

  it("tells the operator to fix the body by hand and resume", async () => {
    const decision = await decide(makeLinkedTask(), makeReviewRequest({ body: "@-" }), noDiffFetch);
    assert.match((decision as { reason: string }).reason, /Fix it by hand, then resume the task\./);
  });

  it("leaves a description that merely mentions a placeholder alone", async () => {
    const decision = await decide(
      makeLinkedTask({ lastReviewedSha: "abc123" }),
      makeReviewRequest({ body: "Pass the body with `@-` only to `gh api`" }),
      noDiffFetch,
    );
    assert.equal(decision.kind, "noop");
  });

  it("still marks a merged PR/MR merged, whatever its body looks like", async () => {
    assert.deepEqual(
      await decide(makeLinkedTask(), makeReviewRequest({ state: "merged", body: "@-" }), noDiffFetch),
      { kind: "mark_merged" },
    );
  });

  it("checks the body before spawning any agent, so no work is wasted on a broken PR/MR", async () => {
    const decision = await decide(
      makeLinkedTask(),
      makeReviewRequest({ body: "@-", ciState: "failed", hasUnresolvedComments: true }),
      noDiffFetch,
    );
    assert.equal(decision.kind, "fail");
  });
});

describe("decide: rules 4-5 (CI)", () => {
  it("rule 4: waits while CI is pending", async () => {
    assert.deepEqual(await decide(makeLinkedTask(), makeReviewRequest({ ciState: "pending" }), noDiffFetch), {
      kind: "noop",
      phase: "waiting_ci",
    });
  });

  it("rule 4: waits while CI is running", async () => {
    assert.deepEqual(await decide(makeLinkedTask(), makeReviewRequest({ ciState: "running" }), noDiffFetch), {
      kind: "noop",
      phase: "waiting_ci",
    });
  });

  it("rule 4: rebases eagerly instead of waiting on CI when behind without conflicts", async () => {
    assert.deepEqual(
      await decide(makeLinkedTask(), makeReviewRequest({ ciState: "pending", needsRebase: true }), noDiffFetch),
      {
        kind: "spawn",
        step: "rebase",
        headShaBefore: null,
        diffHashBefore: null,
      },
    );
  });

  it("rule 4: rebases eagerly via the forge API on GitLab while CI is running", async () => {
    const task = makeLinkedTask({ repoSource: "gitlab" });
    assert.deepEqual(
      await decide(
        task,
        makeReviewRequest({ ciState: "running", needsRebase: true, kind: "merge_request" }),
        noDiffFetch,
      ),
      { kind: "forge_rebase" },
    );
  });

  it("rule 4: rebases eagerly instead of waiting on CI when conflicted", async () => {
    assert.deepEqual(
      await decide(makeLinkedTask(), makeReviewRequest({ ciState: "running", hasConflicts: true }), noDiffFetch),
      {
        kind: "spawn",
        step: "rebase",
        headShaBefore: null,
        diffHashBefore: null,
      },
    );
  });

  it("rule 4: keeps waiting on CI while mergeability is still unknown", async () => {
    assert.deepEqual(
      await decide(
        makeLinkedTask(),
        makeReviewRequest({ ciState: "pending", needsRebase: true, mergeStateKnown: false }),
        noDiffFetch,
      ),
      { kind: "noop", phase: "waiting_ci" },
    );
  });

  it("rule 5: spawns a fix_ci agent when CI failed", async () => {
    assert.deepEqual(await decide(makeLinkedTask(), makeReviewRequest({ ciState: "failed" }), noDiffFetch), {
      kind: "spawn",
      step: "fix_ci",
      headShaBefore: null,
      diffHashBefore: null,
    });
  });

  it("rule 5: failed CI still routes to fix_ci, not an eager rebase", async () => {
    assert.deepEqual(
      await decide(makeLinkedTask(), makeReviewRequest({ ciState: "failed", needsRebase: true }), noDiffFetch),
      {
        kind: "spawn",
        step: "fix_ci",
        headShaBefore: null,
        diffHashBefore: null,
      },
    );
  });

  it("rule 5 outranks unknown merge state", async () => {
    const decision = await decide(
      makeLinkedTask(),
      makeReviewRequest({ ciState: "failed", mergeStateKnown: false }),
      noDiffFetch,
    );
    assert.deepEqual(decision, {
      kind: "spawn",
      step: "fix_ci",
      headShaBefore: null,
      diffHashBefore: null,
    });
  });

  it("a repo with no CI falls through to the later rules", async () => {
    const decision = await decide(
      makeLinkedTask(),
      makeReviewRequest({ ciState: "none", headSha: "def456" }),
      changedDiff(),
    );
    assert.deepEqual(decision, {
      kind: "spawn",
      step: "review",
      headShaBefore: "def456",
      diffHashBefore: CHANGED_DIFF,
    });
  });
});

describe("decide: unknown merge state", () => {
  it("waits until the forge has computed mergeability", async () => {
    assert.deepEqual(
      await decide(makeLinkedTask(), makeReviewRequest({ mergeStateKnown: false }), noDiffFetch),
      { kind: "noop", phase: null },
    );
  });
});

describe("decide: rules 6-7 (divergence and conflicts)", () => {
  it("rule 6: rebases via the forge API on GitLab when behind without conflicts", async () => {
    const task = makeLinkedTask({ repoSource: "gitlab" });
    assert.deepEqual(
      await decide(task, makeReviewRequest({ needsRebase: true, kind: "merge_request" }), noDiffFetch),
      { kind: "forge_rebase" },
    );
  });

  it("rule 6: spawns a rebase agent on GitHub when behind without conflicts", async () => {
    assert.deepEqual(await decide(makeLinkedTask(), makeReviewRequest({ needsRebase: true }), noDiffFetch), {
      kind: "spawn",
      step: "rebase",
      headShaBefore: null,
      diffHashBefore: null,
    });
  });

  it("rule 7: spawns a rebase agent on conflicts", async () => {
    assert.deepEqual(await decide(makeLinkedTask(), makeReviewRequest({ hasConflicts: true }), noDiffFetch), {
      kind: "spawn",
      step: "rebase",
      headShaBefore: null,
      diffHashBefore: null,
    });
  });

  it("rule 7: conflicts route to the rebase agent even on GitLab and even when also behind", async () => {
    const task = makeLinkedTask({ repoSource: "gitlab" });
    const decision = await decide(
      task,
      makeReviewRequest({ needsRebase: true, hasConflicts: true }),
      noDiffFetch,
    );
    assert.deepEqual(decision, {
      kind: "spawn",
      step: "rebase",
      headShaBefore: null,
      diffHashBefore: null,
    });
  });
});

describe("decide: rules 8-11 (review, comments, approval, merge)", () => {
  it("rule 8: spawns a review agent when the head has never been reviewed", async () => {
    assert.deepEqual(
      await decide(makeLinkedTask(), makeReviewRequest({ headSha: "abc123" }), changedDiff()),
      {
        kind: "spawn",
        step: "review",
        headShaBefore: "abc123",
        diffHashBefore: CHANGED_DIFF,
      },
    );
  });

  it("rule 8: spawns a review agent when the head moved and the diff changed with it", async () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123", lastReviewedDiffHash: REVIEWED_DIFF });
    assert.deepEqual(await decide(task, makeReviewRequest({ headSha: "def456" }), changedDiff()), {
      kind: "spawn",
      step: "review",
      headShaBefore: "def456",
      diffHashBefore: CHANGED_DIFF,
    });
  });

  it("rule 8: marks the rewritten head reviewed when the diff is unchanged", async () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123", lastReviewedDiffHash: REVIEWED_DIFF });
    const stub = diffHash(REVIEWED_DIFF);
    assert.deepEqual(await decide(task, makeReviewRequest({ headSha: "def456" }), stub.fetch), {
      kind: "mark_reviewed",
      headSha: "def456",
      diffHash: REVIEWED_DIFF,
    });
    assert.equal(stub.calls(), 1);
  });

  it("rule 8: reviews a rewritten head that has no recorded diff to compare against", async () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123", lastReviewedDiffHash: null });
    const decision = await decide(task, makeReviewRequest({ headSha: "def456" }), changedDiff());
    assert.deepEqual(decision, {
      kind: "spawn",
      step: "review",
      headShaBefore: "def456",
      diffHashBefore: CHANGED_DIFF,
    });
  });

  it("rule 8: reviews a rewritten head whose diff could not be hashed", async () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123", lastReviewedDiffHash: REVIEWED_DIFF });
    const decision = await decide(task, makeReviewRequest({ headSha: "def456" }), async () => null);
    assert.deepEqual(decision, {
      kind: "spawn",
      step: "review",
      headShaBefore: "def456",
      diffHashBefore: null,
    });
  });

  it("rule 8: reviews a rewritten head when neither diff could be hashed", async () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123", lastReviewedDiffHash: null });
    const decision = await decide(task, makeReviewRequest({ headSha: "def456" }), async () => null);
    assert.deepEqual(decision, {
      kind: "spawn",
      step: "review",
      headShaBefore: "def456",
      diffHashBefore: null,
    });
  });

  it("rule 8: does not fetch the diff when the head SHA is unchanged", async () => {
    const stub = diffHash(REVIEWED_DIFF);
    const task = makeLinkedTask({ lastReviewedSha: "abc123", lastReviewedDiffHash: REVIEWED_DIFF });
    assert.deepEqual(await decide(task, makeReviewRequest({ headSha: "abc123" }), stub.fetch), {
      kind: "noop",
      phase: "waiting_approval",
    });
    assert.equal(stub.calls(), 0);
  });

  it("rule 9: spawns an address_comments agent when reviewed but comments are unresolved", async () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123" });
    assert.deepEqual(
      await decide(task, makeReviewRequest({ hasUnresolvedComments: true }), noDiffFetch),
      {
        kind: "spawn",
        step: "address_comments",
        headShaBefore: null,
        diffHashBefore: null,
      },
    );
  });

  it("rule 10: waits for a human when reviewed, comment-free, and unapproved", async () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123" });
    assert.deepEqual(await decide(task, makeReviewRequest(), noDiffFetch), {
      kind: "noop",
      phase: "waiting_approval",
    });
  });

  it("rule 11: merges once a human has approved", async () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123" });
    assert.deepEqual(await decide(task, makeReviewRequest({ approvedByHuman: true }), noDiffFetch), {
      kind: "merge",
    });
  });
});

describe("decide: spawn caps", () => {
  it("fails instead of spawning fix_ci a fourth time", async () => {
    const task = makeLinkedTask({
      attemptsByStep: {
        create_issue: 0,
        implement: 1,
        fix_ci: PER_STEP_SPAWN_CAP,
        rebase: 0,
        review: 0,
        address_comments: 0,
      },
    });
    const decision = await decide(task, makeReviewRequest({ ciState: "failed" }), noDiffFetch);
    assert.equal(decision.kind, "fail");
  });

  it("fails instead of spawning rebase past its cap", async () => {
    const task = makeLinkedTask({
      attemptsByStep: {
        create_issue: 0,
        implement: 1,
        fix_ci: 0,
        rebase: PER_STEP_SPAWN_CAP,
        review: 0,
        address_comments: 0,
      },
    });
    const decision = await decide(task, makeReviewRequest({ hasConflicts: true }), noDiffFetch);
    assert.equal(decision.kind, "fail");
  });

  it("review and address_comments are not per-step capped", async () => {
    const task = makeLinkedTask({
      attemptsByStep: {
        create_issue: 0,
        implement: 1,
        fix_ci: 0,
        rebase: 0,
        review: PER_STEP_SPAWN_CAP + 2,
        address_comments: 0,
      },
    });
    const decision = await decide(task, makeReviewRequest({ headSha: "def456" }), changedDiff());
    assert.deepEqual(decision, {
      kind: "spawn",
      step: "review",
      headShaBefore: "def456",
      diffHashBefore: CHANGED_DIFF,
    });
  });

  it("fails any spawn once the total cap is reached", async () => {
    const task = makeLinkedTask({
      attemptsByStep: {
        create_issue: 0,
        implement: 1,
        fix_ci: 0,
        rebase: 0,
        review: 6,
        address_comments: TOTAL_SPAWN_CAP - 7,
      },
    });
    const decision = await decide(task, makeReviewRequest({ headSha: "def456" }), changedDiff());
    assert.equal(decision.kind, "fail");
  });

  it("an unchanged diff carries the review forward instead of burning the last spawn", async () => {
    const task = makeLinkedTask({
      lastReviewedSha: "abc123",
      lastReviewedDiffHash: REVIEWED_DIFF,
      attemptsByStep: {
        create_issue: 0,
        implement: 1,
        fix_ci: 0,
        rebase: 0,
        review: 6,
        address_comments: TOTAL_SPAWN_CAP - 7,
      },
    });
    const decision = await decide(task, makeReviewRequest({ headSha: "def456" }), diffHash(REVIEWED_DIFF).fetch);
    assert.deepEqual(decision, { kind: "mark_reviewed", headSha: "def456", diffHash: REVIEWED_DIFF });
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
      create_issue: 0,
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
  it("keeps cycling while under the cap", async () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP - 1);
    assert.deepEqual(await decide(task, makeReviewRequest({ headSha: "def456" }), changedDiff()), {
      kind: "spawn",
      step: "review",
      headShaBefore: "def456",
      diffHashBefore: CHANGED_DIFF,
    });
  });

  it("still verifies the final fix round, spawning the confirming review at the cap", async () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP);
    assert.deepEqual(await decide(task, makeReviewRequest({ headSha: "def456" }), changedDiff()), {
      kind: "spawn",
      step: "review",
      headShaBefore: "def456",
      diffHashBefore: CHANGED_DIFF,
    });
  });

  it("fails instead of spawning yet another address_comments once the cap is reached", async () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP, { lastReviewedSha: "abc123" });
    const decision = await decide(task, makeReviewRequest({ hasUnresolvedComments: true }), noDiffFetch);
    assert.equal(decision.kind, "fail");
    assert.match((decision as { reason: string }).reason, /cycled 3 times/);
  });

  it("fails well before the total spawn cap, with a reason naming the cycle and the way out", async () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP, { lastReviewedSha: "abc123" });
    const decision = await decide(task, makeReviewRequest({ hasUnresolvedComments: true }), noDiffFetch);
    assert.equal(decision.kind, "fail");
    const reason = (decision as { reason: string }).reason;
    assert.doesNotMatch(reason, /total spawn cap/);
    assert.match(reason, /Review and comment-addressing/);
    assert.match(reason, /resume the task/);
    assert.ok(totalAttemptsOf(task) < TOTAL_SPAWN_CAP);
  });

  it("does not count address_comments attempts that failed", async () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP, { lastReviewedSha: "abc123" });
    const lastFix = task.attempts[task.attempts.length - 1];
    lastFix.error = "Attempt timed out after 120 minutes";
    assert.deepEqual(
      await decide(task, makeReviewRequest({ hasUnresolvedComments: true }), noDiffFetch),
      {
        kind: "spawn",
        step: "address_comments",
        headShaBefore: null,
        diffHashBefore: null,
      },
    );
  });

  it("does not cap a comment round on a PR/MR the reviewer already declared ready", async () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP, { lastReviewedSha: "abc123", phase: "waiting_approval" });
    assert.deepEqual(
      await decide(task, makeReviewRequest({ hasUnresolvedComments: true }), noDiffFetch),
      {
        kind: "spawn",
        step: "address_comments",
        headShaBefore: null,
        diffHashBefore: null,
      },
    );
  });

  it("resuming a failed task clears the cycle, since only attempts since the resume count", async () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP, { lastReviewedSha: "abc123" });
    task.attemptsByStep = { create_issue: 0, implement: 0, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 };
    assert.deepEqual(
      await decide(task, makeReviewRequest({ hasUnresolvedComments: true }), noDiffFetch),
      {
        kind: "spawn",
        step: "address_comments",
        headShaBefore: null,
        diffHashBefore: null,
      },
    );
  });

  it("only counts the trailing run, so an intervening step resets the cycle", async () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP, { lastReviewedSha: "abc123" });
    task.attempts.push(makeAttempt({ step: "fix_ci" }));
    task.attemptsByStep.fix_ci = 1;
    assert.deepEqual(
      await decide(task, makeReviewRequest({ hasUnresolvedComments: true }), noDiffFetch),
      {
        kind: "spawn",
        step: "address_comments",
        headShaBefore: null,
        diffHashBefore: null,
      },
    );
  });

  it("does not cap steps outside the cycle", async () => {
    const task = cyclingTask(REVIEW_CYCLE_CAP);
    assert.deepEqual(await decide(task, makeReviewRequest({ hasConflicts: true }), noDiffFetch), {
      kind: "spawn",
      step: "rebase",
      headShaBefore: null,
      diffHashBefore: null,
    });
  });

  it("back-to-back reviews with no comments addressed do not count as cycles", async () => {
    const task = makeLinkedTask({
      lastReviewedSha: "abc123",
      attempts: [
        makeAttempt({ step: "implement" }),
        makeAttempt({ step: "review" }),
        makeAttempt({ step: "review" }),
        makeAttempt({ step: "review" }),
        makeAttempt({ step: "review" }),
      ],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 0, rebase: 0, review: 4, address_comments: 0 },
    });
    assert.deepEqual(
      await decide(task, makeReviewRequest({ hasUnresolvedComments: true }), noDiffFetch),
      {
        kind: "spawn",
        step: "address_comments",
        headShaBefore: null,
        diffHashBefore: null,
      },
    );
  });
});
