import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerCodeStatus, InstanceStatus } from "@crc/container-metadata-types";
import type { ManagedContainer, RepoReviewRequest, ResolvedConfigFile, Task } from "../types.js";
import type { Forge } from "../forge/index.js";
import { TaskStore } from "./store.js";
import { REVIEW_CYCLE_CAP } from "./decide.js";
import {
  ATTEMPT_TIMEOUT_MS,
  MAX_CONSECUTIVE_ERRORS,
  runTaskSchedulerTick,
  type SchedulerDeps,
} from "./scheduler.js";
import { makeAttempt, makeLinkedTask, makeReviewRequest, makeTask } from "../testing/fixtures.js";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const RECENT_START = "2026-08-20T11:30:00.000Z";
const CONTAINER_ID = "c0ffee0000000000";
const CONTAINER_NAME = "crc-test-c0ffee";

const CONFIG_FILE: ResolvedConfigFile = {
  root_domain: "example.com",
  git: { email: "bot@example.com", username: "bot" },
  configurations: [{ name: "default", oauth: { accessToken: "token" } }],
};

function makeContainer(id: string, name: string, status = "running"): ManagedContainer {
  return {
    id,
    name,
    configName: "default",
    repoName: "acme/widgets",
    status,
    health: { container: "running", claude: "healthy" },
    subdomain: name,
    createdAt: RECENT_START,
  };
}

function makeCodeStatus(
  reviewRequest: { id: string; url: string; sourceBranch: string } | null,
): ContainerCodeStatus {
  return {
    branch: "feature",
    commitSha: "abc123",
    orgName: "acme",
    repoName: "widgets",
    provider: "github",
    currentTaskDescription: null,
    reviewRequest: reviewRequest
      ? {
          id: reviewRequest.id,
          title: "Add widgets",
          url: reviewRequest.url,
          state: "OPEN",
          isDraft: false,
          sourceBranch: reviewRequest.sourceBranch,
          targetBranch: "main",
        }
      : null,
    pipeline: null,
    warnings: [],
    updatedAt: NOW.toISOString(),
  };
}

interface HarnessOptions {
  tasks: Task[];
  containers?: ManagedContainer[];
  snapshot?: RepoReviewRequest[];
  listError?: Error;
  getContainerError?: Error;
  getReviewRequest?: (repoFullName: string, id: string) => Promise<RepoReviewRequest>;
  diffHash?: string | null;
  instanceStatus?: Record<string, InstanceStatus>;
  codeStatus?: Record<string, ContainerCodeStatus>;
  now?: Date;
}

function makeHarness(options: HarnessOptions) {
  const store = new TaskStore(mkdtempSync(join(tmpdir(), "crc-scheduler-")));
  for (const task of options.tasks) store.save(task);

  const created: Array<{ configName: string; repoFullName: string; prompt: string }> = [];
  const removed: string[] = [];
  const rebased: string[] = [];
  const diffHashFetches: string[] = [];
  const merged: string[] = [];
  const broadcasts: Task[] = [];
  const containers = new Map((options.containers ?? []).map((c) => [c.id, c]));
  let nextContainer = 0;

  const forge: Forge = {
    listWorkItems: async () => [],
    listReviewRequests: async () => {
      if (options.listError) throw options.listError;
      return options.snapshot ?? [];
    },
    getReviewRequest:
      options.getReviewRequest ??
      (async (_repo, id) => {
        throw new Error(`No single-item fetch stubbed for ${id}`);
      }),
    getDiffHash: async (_repo, id) => {
      diffHashFetches.push(id);
      return options.diffHash === undefined ? "diff-hash-1" : options.diffHash;
    },
    rebase: async (_repo, id) => {
      rebased.push(id);
    },
    merge: async (_repo, id) => {
      merged.push(id);
    },
  };

  const deps: SchedulerDeps = {
    store,
    getForge: () => forge,
    loadConfigurations: async () => CONFIG_FILE,
    getContainer: async (id) => {
      if (options.getContainerError) throw options.getContainerError;
      return containers.get(id) ?? null;
    },
    createContainer: async (_appConfig, config, repoFullName, _repoSource, opts) => {
      const id = `abcd00000000000${nextContainer}`;
      nextContainer += 1;
      created.push({ configName: config.name, repoFullName, prompt: opts.initialPrompt });
      const container = makeContainer(id, `crc-spawned-${id}`);
      containers.set(id, container);
      return container;
    },
    removeContainer: async (id) => {
      removed.push(id);
      containers.delete(id);
    },
    getContainerLogTail: async () => "captured log tail",
    fetchInstanceStatus: async (name) => {
      const status = options.instanceStatus?.[name];
      if (!status) throw new Error(`No instance status stubbed for ${name}`);
      return status;
    },
    fetchCodeStatus: async (name) => {
      const status = options.codeStatus?.[name];
      if (!status) throw new Error(`No code status stubbed for ${name}`);
      return status;
    },
    broadcastTaskUpdated: (task) => broadcasts.push(structuredClone(task)),
    now: () => options.now ?? NOW,
  };

  return { deps, store, created, removed, rebased, merged, broadcasts, diffHashFetches };
}

function makeActiveTask(overrides: Partial<Task> = {}): Task {
  return makeLinkedTask({
    phase: "agent_running",
    activeContainerId: CONTAINER_ID,
    activeStep: "fix_ci",
    attemptsByStep: { implement: 1, fix_ci: 1, rebase: 0, review: 0, address_comments: 0 },
    attempts: [
      makeAttempt({
        step: "implement",
        containerId: "0000000000000000",
        startedAt: "2026-08-20T10:00:00.000Z",
        finishedAt: "2026-08-20T10:30:00.000Z",
      }),
      makeAttempt({ step: "fix_ci", containerId: CONTAINER_ID, startedAt: RECENT_START }),
    ],
    ...overrides,
  });
}

describe("scheduler: spawning", () => {
  it("spawns an implement agent for a fresh task and persists the attempt", async () => {
    const task = makeTask();
    const harness = makeHarness({ tasks: [task] });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.equal(harness.created[0].configName, "default");
    assert.match(harness.created[0].prompt, /#7/);
    assert.match(harness.created[0].prompt, /open a pull\/merge request/);
    assert.equal(task.phase, "agent_running");
    assert.equal(task.activeStep, "implement");
    assert.ok(task.activeContainerId);
    assert.equal(task.attemptsByStep.implement, 1);
    assert.deepEqual(task.attempts[0].headShaBefore, null);
    assert.ok(harness.broadcasts.length > 0);

    const persisted = harness.store.list()[0];
    assert.equal(persisted.activeContainerId, task.activeContainerId);
  });

  it("spawns a review agent recording the head SHA it is reviewing", async () => {
    const task = makeLinkedTask({ phase: "waiting_ci" });
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ headSha: "def456" })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.match(harness.created[0].prompt, /Review pull request #12/);
    assert.equal(task.activeStep, "review");
    assert.equal(task.attempts[0].headShaBefore, "def456");
    assert.equal(task.attempts[0].diffHashBefore, "diff-hash-1");
    assert.deepEqual(harness.diffHashFetches, ["12"]);
  });

  it("tells the review agent to keep merge-ready feedback out of resolvable threads", async () => {
    const task = makeLinkedTask({ phase: "waiting_ci" });
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ headSha: "def456" })],
    });

    await runTaskSchedulerTick(harness.deps);

    const prompt = harness.created[0].prompt;
    assert.match(prompt, /Only open resolvable discussion threads/);
    assert.match(prompt, /unresolved thread blocks the merge automation/);
    assert.match(prompt, /single plain comment/);
  });

  it("hands every spawned agent the guidance for the forge it is posting to", async () => {
    const github = makeHarness({ tasks: [makeTask()] });
    await runTaskSchedulerTick(github.deps);
    assert.match(github.created[0].prompt, /gh pr create --body-file body\.md/);
    assert.doesNotMatch(github.created[0].prompt, /glab/);

    const gitlab = makeHarness({ tasks: [makeTask({ repoSource: "gitlab" })] });
    await runTaskSchedulerTick(gitlab.deps);
    assert.match(gitlab.created[0].prompt, /glab mr create --description "\$\(cat body\.md\)"/);

    const review = makeHarness({
      tasks: [makeLinkedTask({ phase: "waiting_ci" })],
      snapshot: [makeReviewRequest({ headSha: "def456" })],
    });
    await runTaskSchedulerTick(review.deps);
    assert.match(review.created[0].prompt, /never pass `@-`, `@` or `-` as the body value/);
  });

  it("fails a task whose PR/MR description is a stdin placeholder, without spawning an agent", async () => {
    const task = makeLinkedTask({ phase: "waiting_ci" });
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ body: "@-", ciState: "failed" })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 0);
    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /stdin placeholder '@-'/);
    assert.match(task.error ?? "", /Fix it by hand, then resume the task\./);
    assert.equal(harness.store.list()[0].phase, "failed");
  });

  it("fails a task whose PR/MR carries a placeholder comment", async () => {
    const task = makeLinkedTask({ phase: "waiting_ci", lastReviewedSha: "abc123" });
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ hasPlaceholderComment: true, hasUnresolvedComments: true })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 0);
    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /comment whose whole body is a stdin placeholder/);
  });

  it("fails a task ping-ponging between review and address_comments, naming the cycle", async () => {
    const attempts = [makeAttempt({ step: "implement" })];
    for (let i = 0; i < REVIEW_CYCLE_CAP; i++) {
      attempts.push(makeAttempt({ step: "review" }), makeAttempt({ step: "address_comments" }));
    }
    const task = makeLinkedTask({
      phase: "agent_running",
      lastReviewedSha: "abc123",
      attempts,
      attemptsByStep: {
        implement: 1,
        fix_ci: 0,
        rebase: 0,
        review: REVIEW_CYCLE_CAP,
        address_comments: REVIEW_CYCLE_CAP,
      },
    });
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ hasUnresolvedComments: true })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 0);
    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /Review and comment-addressing cycled 3 times/);
    assert.doesNotMatch(task.error ?? "", /total spawn cap/);
  });

  it("uses the step's configured configuration and fails loudly on an unknown one", async () => {
    const task = makeTask({
      configByStep: {
        implement: "missing-config",
        fix_ci: "default",
        rebase: "default",
        review: "default",
        address_comments: "default",
      },
    });
    const harness = makeHarness({ tasks: [task] });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 0);
    assert.equal(task.consecutiveErrors, 1);
    assert.match(task.error ?? "", /missing-config/);
  });
});

describe("scheduler: watching a running agent", () => {
  it("leaves a still-working agent alone", async () => {
    const task = makeActiveTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { finished: false, updatedAt: RECENT_START } },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 0);
    assert.equal(harness.removed.length, 0);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(task.phase, "agent_running");
  });

  it("tears down a finished agent, captures the PR link and log tail, and settles for a tick", async () => {
    const task = makeActiveTask({ reviewRequest: null });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { finished: true, updatedAt: NOW.toISOString() } },
      codeStatus: {
        [CONTAINER_NAME]: makeCodeStatus({
          id: "12",
          url: "https://github.com/acme/widgets/pull/12",
          sourceBranch: "feature",
        }),
      },
      snapshot: [makeReviewRequest({ ciState: "failed" })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [CONTAINER_ID]);
    assert.deepEqual(task.reviewRequest, {
      id: "12",
      url: "https://github.com/acme/widgets/pull/12",
      sourceBranch: "feature",
    });
    assert.equal(harness.store.readAttemptLog(task.id, 1), "captured log tail");
    assert.equal(task.activeContainerId, null);
    assert.equal(task.activeStep, null);
    assert.ok(task.attempts[1].finishedAt);
    assert.equal(task.attempts[1].error, null);
    assert.equal(harness.created.length, 0);

    await runTaskSchedulerTick(harness.deps);
    assert.equal(harness.created.length, 1);
    assert.match(harness.created[0].prompt, /failing CI/);
  });

  it("copies headShaBefore and diffHashBefore into the reviewed state when a review attempt completes", async () => {
    const task = makeActiveTask({
      activeStep: "review",
      attempts: [
        makeAttempt({
          step: "review",
          containerId: CONTAINER_ID,
          startedAt: RECENT_START,
          headShaBefore: "def456",
          diffHashBefore: "diff-hash-1",
        }),
      ],
      attemptsByStep: { implement: 1, fix_ci: 0, rebase: 0, review: 1, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { finished: true, updatedAt: NOW.toISOString() } },
      codeStatus: { [CONTAINER_NAME]: makeCodeStatus(null) },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.lastReviewedSha, "def456");
    assert.equal(task.lastReviewedDiffHash, "diff-hash-1");
  });

  it("times out a wedged attempt and kills its container", async () => {
    const startedAt = new Date(NOW.getTime() - ATTEMPT_TIMEOUT_MS - 60_000).toISOString();
    const task = makeActiveTask({
      attempts: [makeAttempt({ step: "fix_ci", containerId: CONTAINER_ID, startedAt })],
      attemptsByStep: { implement: 1, fix_ci: 1, rebase: 0, review: 0, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { finished: false, updatedAt: startedAt } },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [CONTAINER_ID]);
    assert.equal(task.activeContainerId, null);
    assert.match(task.attempts[0].error ?? "", /timed out/);
    assert.equal(harness.created.length, 0);
  });

  it("records the attempt as failed and re-evaluates when the container vanished", async () => {
    const task = makeActiveTask();
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ ciState: "failed" })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.match(task.attempts[1].error ?? "", /disappeared/);
    assert.equal(harness.created.length, 1);
    assert.equal(task.activeStep, "fix_ci");
    assert.equal(task.attemptsByStep.fix_ci, 2);
  });

  it("captures the log and removes an exited container before re-evaluating", async () => {
    const task = makeActiveTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME, "exited")],
      snapshot: [makeReviewRequest({ ciState: "failed" })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [CONTAINER_ID]);
    assert.equal(harness.store.readAttemptLog(task.id, 1), "captured log tail");
    assert.match(task.attempts[1].error ?? "", /stopped unexpectedly \(status: exited\)/);
    assert.equal(harness.created.length, 1);
  });

  it("treats a transient container-inspect error as an error, not a vanished agent", async () => {
    const task = makeActiveTask();
    const harness = makeHarness({
      tasks: [task],
      getContainerError: new Error("docker daemon hiccup"),
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(task.attempts[1].finishedAt, null);
    assert.equal(task.consecutiveErrors, 1);
    assert.match(task.error ?? "", /docker daemon hiccup/);
    assert.equal(harness.created.length, 0);
    assert.equal(harness.removed.length, 0);
  });

  it("fails a task whose implement agent finished without opening a PR/MR", async () => {
    const task = makeActiveTask({
      reviewRequest: null,
      activeStep: "implement",
      attempts: [makeAttempt({ step: "implement", containerId: CONTAINER_ID, startedAt: RECENT_START })],
      attemptsByStep: { implement: 1, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { finished: true, updatedAt: NOW.toISOString() } },
      codeStatus: { [CONTAINER_NAME]: makeCodeStatus(null) },
    });

    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.phase, "agent_running");
    assert.equal(task.reviewRequest, null);

    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /without opening a PR\/MR/);
    assert.equal(harness.created.length, 0);
  });
});

describe("scheduler: forge-state evaluation", () => {
  it("waits while CI runs", async () => {
    const task = makeLinkedTask({ phase: "agent_running" });
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ ciState: "running" })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "waiting_ci");
    assert.equal(harness.created.length, 0);
  });

  it("fetches the PR/MR directly when it is absent from the open-items snapshot", async () => {
    const task = makeLinkedTask();
    const fetchedIds: string[] = [];
    const harness = makeHarness({
      tasks: [task],
      snapshot: [],
      getReviewRequest: async (_repo, id) => {
        fetchedIds.push(id);
        return makeReviewRequest({ state: "merged" });
      },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(fetchedIds, ["12"]);
    assert.equal(task.phase, "merged");
  });

  it("fails the task when its PR/MR was closed without merging", async () => {
    const task = makeLinkedTask();
    const harness = makeHarness({
      tasks: [task],
      snapshot: [],
      getReviewRequest: async () => makeReviewRequest({ state: "closed" }),
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /closed/);
  });

  it("rebases via the forge API for a GitLab task that is behind without conflicts", async () => {
    const task = makeLinkedTask({ repoSource: "gitlab" });
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ kind: "merge_request", needsRebase: true })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.rebased, ["12"]);
    assert.equal(task.phase, "waiting_ci");
    assert.equal(harness.created.length, 0);
  });

  it("merges an approved, reviewed, comment-free PR", async () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123" });
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ approvedByHuman: true })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.merged, ["12"]);
    assert.equal(task.phase, "merged");
  });

  it("holds in waiting_approval until a human approves", async () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123" });
    const harness = makeHarness({ tasks: [task], snapshot: [makeReviewRequest()] });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "waiting_approval");
    assert.deepEqual(harness.merged, []);
    assert.equal(harness.created.length, 0);
  });
});

describe("scheduler: re-review after a history rewrite", () => {
  const SPAWNED_NAME = "crc-spawned-abcd000000000000";

  it("carries the reviewed state across a clean GitLab rebase instead of spawning a review", async () => {
    const task = makeLinkedTask({
      repoSource: "gitlab",
      lastReviewedSha: "abc123",
      lastReviewedDiffHash: "diff-hash-1",
      attemptsByStep: { implement: 1, fix_ci: 0, rebase: 0, review: 1, address_comments: 0 },
    });
    const options: HarnessOptions = {
      tasks: [task],
      snapshot: [makeReviewRequest({ kind: "merge_request", needsRebase: true })],
      diffHash: "diff-hash-1",
    };
    const harness = makeHarness(options);

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.rebased, ["12"]);
    assert.deepEqual(harness.diffHashFetches, []);

    options.snapshot = [makeReviewRequest({ kind: "merge_request", headSha: "rebased789" })];
    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 0);
    assert.deepEqual(harness.diffHashFetches, ["12"]);
    assert.equal(task.lastReviewedSha, "rebased789");
    assert.equal(task.lastReviewedDiffHash, "diff-hash-1");

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 0);
    assert.deepEqual(harness.diffHashFetches, ["12"]);
    assert.equal(task.phase, "waiting_approval");
  });

  it("spawns a review when the rewritten head carries a different diff", async () => {
    const task = makeLinkedTask({
      lastReviewedSha: "abc123",
      lastReviewedDiffHash: "diff-hash-1",
      attemptsByStep: { implement: 1, fix_ci: 0, rebase: 0, review: 1, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ headSha: "pushed789" })],
      diffHash: "diff-hash-2",
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.match(harness.created[0].prompt, /Review pull request #12/);
    assert.equal(task.attempts[0].headShaBefore, "pushed789");
    assert.equal(task.attempts[0].diffHashBefore, "diff-hash-2");
    assert.equal(task.lastReviewedSha, "abc123");
  });

  it("reviews the rewritten head when the forge cannot hash its diff", async () => {
    const task = makeLinkedTask({
      lastReviewedSha: "abc123",
      lastReviewedDiffHash: "diff-hash-1",
      attemptsByStep: { implement: 1, fix_ci: 0, rebase: 0, review: 1, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ headSha: "rebased789" })],
      diffHash: null,
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.equal(task.attempts[0].diffHashBefore, null);
    assert.equal(task.error, null);
    assert.equal(task.consecutiveErrors, 0);
  });

  it("does not mark an unhashable diff reviewed just because the last one was unhashable too", async () => {
    const task = makeLinkedTask({
      lastReviewedSha: "abc123",
      lastReviewedDiffHash: null,
      attemptsByStep: { implement: 1, fix_ci: 0, rebase: 0, review: 1, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ headSha: "rebased789" })],
      diffHash: null,
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.equal(task.lastReviewedSha, "abc123");
  });

  it("does not fetch the diff while the head SHA still matches the reviewed one", async () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123", lastReviewedDiffHash: "diff-hash-1" });
    const harness = makeHarness({ tasks: [task], snapshot: [makeReviewRequest()] });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.diffHashFetches, []);
    assert.equal(task.phase, "waiting_approval");
  });

  it("reviews once, then skips the review a later clean rebase would have triggered", async () => {
    const task = makeLinkedTask({ phase: "waiting_ci" });
    const options: HarnessOptions = {
      tasks: [task],
      snapshot: [makeReviewRequest({ headSha: "abc123" })],
      diffHash: "diff-hash-1",
      instanceStatus: { [SPAWNED_NAME]: { finished: true, updatedAt: NOW.toISOString() } },
      codeStatus: { [SPAWNED_NAME]: makeCodeStatus(null) },
    };
    const harness = makeHarness(options);

    await runTaskSchedulerTick(harness.deps);
    assert.equal(harness.created.length, 1);
    assert.equal(task.activeStep, "review");

    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.activeContainerId, null);
    assert.equal(task.lastReviewedSha, "abc123");
    assert.equal(task.lastReviewedDiffHash, "diff-hash-1");

    options.snapshot = [makeReviewRequest({ headSha: "rebased789" })];
    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.equal(task.attemptsByStep.review, 1);
    assert.equal(task.lastReviewedSha, "rebased789");

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.equal(task.phase, "waiting_approval");
  });
});

describe("scheduler: rails", () => {
  it("never evaluates paused tasks", async () => {
    const task = makeActiveTask({ phase: "paused" });
    const harness = makeHarness({ tasks: [task] });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.error, null);
    assert.equal(harness.removed.length, 0);
    assert.equal(harness.created.length, 0);
    assert.equal(harness.broadcasts.length, 0);
  });

  it("spawns implement agents even while the forge is down, since they need no forge data", async () => {
    const task = makeTask();
    const harness = makeHarness({ tasks: [task], listError: new Error("forge is down") });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.equal(task.phase, "agent_running");
    assert.equal(task.error, null);
  });

  it("discards the container instead of resurrecting a task deleted during spawn", async () => {
    const task = makeTask();
    const harness = makeHarness({ tasks: [task] });
    const originalCreate = harness.deps.createContainer;
    harness.deps.createContainer = async (...args) => {
      harness.store.remove(task.id);
      return originalCreate(...args);
    };

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.equal(harness.removed.length, 1);
    assert.deepEqual(harness.store.list(), []);
  });

  it("keeps a pause that landed while the agent container was being created", async () => {
    const task = makeTask();
    const harness = makeHarness({ tasks: [task] });
    const originalCreate = harness.deps.createContainer;
    harness.deps.createContainer = async (...args) => {
      task.phase = "paused";
      harness.store.save(task);
      return originalCreate(...args);
    };

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "paused");
    assert.ok(task.activeContainerId);
    assert.equal(task.attempts.length, 1);
  });

  it("captures the active attempt's log before failing a task on repeated errors", async () => {
    const task = makeActiveTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { finished: true, updatedAt: NOW.toISOString() } },
    });

    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) {
      await runTaskSchedulerTick(harness.deps);
    }

    assert.equal(task.phase, "failed");
    assert.deepEqual(harness.removed, [CONTAINER_ID]);
    assert.equal(harness.store.readAttemptLog(task.id, 1), "captured log tail");
    assert.ok(task.attempts[1].finishedAt);
  });

  it("records snapshot errors and fails the task after repeated failures", async () => {
    const task = makeLinkedTask();
    const harness = makeHarness({ tasks: [task], listError: new Error("forge is down") });

    for (let i = 1; i < MAX_CONSECUTIVE_ERRORS; i++) {
      await runTaskSchedulerTick(harness.deps);
      assert.equal(task.phase, "spawning");
      assert.equal(task.consecutiveErrors, i);
      assert.match(task.error ?? "", /forge is down/);
    }

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /consecutive errors/);

    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.consecutiveErrors, MAX_CONSECUTIVE_ERRORS);
  });

  it("clears the error state once a tick succeeds again", async () => {
    const task = makeLinkedTask({ consecutiveErrors: 2, error: "forge is down", lastReviewedSha: "abc123" });
    const harness = makeHarness({ tasks: [task], snapshot: [makeReviewRequest()] });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.error, null);
    assert.equal(task.consecutiveErrors, 0);
    assert.equal(task.phase, "waiting_approval");
  });

  it("makes one snapshot fetch per repository per tick", async () => {
    let listCalls = 0;
    const taskA = makeLinkedTask({ id: "task-a", lastReviewedSha: "abc123" });
    const taskB = makeLinkedTask({
      id: "task-b",
      lastReviewedSha: "abc123",
      reviewRequest: { id: "13", url: "https://github.com/acme/widgets/pull/13", sourceBranch: "other" },
    });
    const harness = makeHarness({
      tasks: [taskA, taskB],
      snapshot: [makeReviewRequest(), makeReviewRequest({ id: "13", reference: "#13" })],
    });
    const forge = harness.deps.getForge("github");
    const originalList = forge.listReviewRequests;
    forge.listReviewRequests = async (repo) => {
      listCalls += 1;
      return originalList(repo);
    };

    await runTaskSchedulerTick(harness.deps);

    assert.equal(listCalls, 1);
    assert.equal(taskA.phase, "waiting_approval");
    assert.equal(taskB.phase, "waiting_approval");
  });
});
