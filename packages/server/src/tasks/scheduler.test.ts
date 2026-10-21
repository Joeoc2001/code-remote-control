import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerCodeStatus, InstanceStatus } from "@crc/container-metadata-types";
import type {
  ManagedContainer,
  RepoReviewRequest,
  RepoWorkItem,
  ResolvedConfigFile,
  Task,
  TaskAttempt,
  TaskContainer,
  TaskSpawn,
} from "../types.js";
import type { Forge } from "../forge/index.js";
import { TaskStore } from "./store.js";
import { NIT_THREAD_REVIEW_LIMIT, REVIEW_CYCLE_CAP } from "./decide.js";
import {
  ATTEMPT_TIMEOUT_MS,
  CLOSURE_GRACE_MS,
  MAX_CONSECUTIVE_ERRORS,
  MAX_STAGES,
  runTaskSchedulerTick,
  type SchedulerDeps,
} from "./scheduler.js";
import { DISCARDED_CONTAINER_ERROR, resumeTask } from "./resume.js";
import { makeAttempt, makeLinkedTask, makeReviewRequest, makeTask, makeTextTask } from "../testing/fixtures.js";

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
  createdIssueUrl: string | null = null,
): ContainerCodeStatus {
  return {
    branch: "feature",
    commitSha: "abc123",
    orgName: "acme",
    repoName: "widgets",
    provider: "github",
    currentTaskDescription: null,
    createdIssueUrl,
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
  taskContainers?: TaskContainer[];
  snapshot?: RepoReviewRequest[];
  workItems?: RepoWorkItem[];
  listError?: Error;
  getContainerError?: Error;
  getReviewRequest?: (repoFullName: string, id: string) => Promise<RepoReviewRequest>;
  diffHash?: string | null;
  workItemsError?: Error;
  instanceStatus?: Record<string, InstanceStatus>;
  codeStatus?: Record<string, ContainerCodeStatus>;
  now?: Date;
}

function makeHarness(options: HarnessOptions) {
  const store = new TaskStore(mkdtempSync(join(tmpdir(), "crc-scheduler-")));
  for (const task of options.tasks) store.save(task);

  const created: Array<{ configName: string; repoFullName: string; prompt: string; spawn: TaskSpawn }> = [];
  const removed: string[] = [];
  const rebased: string[] = [];
  const diffHashFetches: string[] = [];
  const merged: string[] = [];
  const broadcasts: Task[] = [];
  const containers = new Map(
    [...(options.containers ?? []), ...(options.taskContainers ?? []).map((tc) => tc.container)].map((c) => [c.id, c]),
  );
  let nextContainer = 0;

  const forge: Forge = {
    listWorkItems: async () => {
      if (options.workItemsError) throw options.workItemsError;
      return options.workItems ?? [];
    },
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
      created.push({ configName: config.name, repoFullName, prompt: opts.initialPrompt, spawn: opts.task });
      const container = makeContainer(id, `crc-spawned-${id}`);
      containers.set(id, container);
      return container;
    },
    listTaskContainers: async () =>
      (options.taskContainers ?? []).filter((tc) => containers.has(tc.container.id)),
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
    attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 1, rebase: 0, review: 0, address_comments: 0 },
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
    assert.deepEqual(harness.created[0].spawn, {
      taskId: task.id,
      step: "implement",
      headShaBefore: null,
      diffHashBefore: null,
    });
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

  it("tells the first review agent to leave nits as resolvable threads", async () => {
    const task = makeLinkedTask({ phase: "waiting_ci" });
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ headSha: "def456" })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.activeStep, "review");
    const prompt = harness.created[0].prompt;
    assert.match(prompt, /also for each nit or minor suggestion/);
    assert.match(prompt, /unresolved thread blocks the merge automation/);
    assert.doesNotMatch(prompt, /Only open resolvable discussion threads/);
  });

  function reviewedTask(attempts: TaskAttempt[]): Task {
    const attemptsByStep = { create_issue: 0, implement: 0, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 };
    for (const attempt of attempts) attemptsByStep[attempt.step] += 1;
    return makeLinkedTask({ phase: "waiting_ci", lastReviewedSha: "abc123", attempts, attemptsByStep });
  }

  function reviewCycles(count: number, between: TaskAttempt[] = []): TaskAttempt[] {
    const attempts = [makeAttempt({ step: "implement" })];
    for (let i = 0; i < count; i++) {
      attempts.push(makeAttempt({ step: "review" }), makeAttempt({ step: "address_comments" }), ...between);
    }
    return attempts;
  }

  async function reviewPromptFor(task: Task): Promise<string> {
    const harness = makeHarness({ tasks: [task], snapshot: [makeReviewRequest({ headSha: "def456" })] });
    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.activeStep, "review");
    assert.equal(harness.created.length, 1);
    return harness.created[0].prompt;
  }

  it("keeps asking for nit threads while under the nit-thread review limit", async () => {
    const prompt = await reviewPromptFor(reviewedTask(reviewCycles(NIT_THREAD_REVIEW_LIMIT - 1)));
    assert.match(prompt, /also for each nit or minor suggestion/);
  });

  it("moves nits into a plain comment once the PR/MR has had the nit-thread review limit of reviews", async () => {
    const prompt = await reviewPromptFor(reviewedTask(reviewCycles(NIT_THREAD_REVIEW_LIMIT)));
    assert.match(prompt, /Only open resolvable discussion threads/);
    assert.match(prompt, /open threads for the must-fix items only/);
    assert.match(prompt, /single plain comment/);
    assert.doesNotMatch(prompt, /also for each nit or minor suggestion/);
  });

  it("does not reset the review count after interleaved rebases", async () => {
    const prompt = await reviewPromptFor(
      reviewedTask(reviewCycles(NIT_THREAD_REVIEW_LIMIT, [makeAttempt({ step: "rebase" })])),
    );
    assert.match(prompt, /Only open resolvable discussion threads/);
  });

  it("does not count errored review attempts", async () => {
    const attempts = reviewCycles(NIT_THREAD_REVIEW_LIMIT - 1);
    attempts.push(makeAttempt({ step: "review", error: "Agent container exited unexpectedly" }));
    const prompt = await reviewPromptFor(reviewedTask(attempts));
    assert.match(prompt, /also for each nit or minor suggestion/);
  });

  it("counts reviews only since the last resume", async () => {
    const task = reviewedTask(reviewCycles(NIT_THREAD_REVIEW_LIMIT));
    task.attemptsByStep = { create_issue: 0, implement: 0, fix_ci: 0, rebase: 0, review: 0, address_comments: 1 };
    const prompt = await reviewPromptFor(task);
    assert.match(prompt, /also for each nit or minor suggestion/);
  });

  it("tells the rebase agent to resolve conflicts and then fold in any review nits", async () => {
    const task = makeLinkedTask({ phase: "waiting_ci" });
    const harness = makeHarness({
      tasks: [task],
      snapshot: [makeReviewRequest({ hasConflicts: true })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.equal(task.activeStep, "rebase");
    const prompt = harness.created[0].prompt;
    assert.match(prompt, /^Rebase pull request #12 at https:\/\/github\.com\/acme\/widgets\/pull\/12 onto the main branch/);
    assert.match(prompt, /resolving any merge conflicts, and force-push the rebased branch/);
    assert.match(prompt, /if previous review left any nits or minor non-blocking suggestions on the pull request, address them too in separate commits on top of the rebase/);
    assert.match(prompt, /if no such suggestions were given, or a suggestion is contentious or would expand the scope of the change, leave it alone/);
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
        create_issue: 0,
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
        create_issue: "default",
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
      instanceStatus: { [CONTAINER_NAME]: { state: "working", updatedAt: RECENT_START } },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 0);
    assert.equal(harness.removed.length, 0);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(task.phase, "agent_running");
  });

  it("leaves an agent that is waiting on the user alone", async () => {
    const task = makeActiveTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "waiting", updatedAt: RECENT_START } },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.removed.length, 0);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(task.phase, "agent_running");
  });

  it("leaves an agent waiting on its background agents alone", async () => {
    const task = makeActiveTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "awaiting-background", updatedAt: NOW.toISOString() } },
    });

    await runTaskSchedulerTick(harness.deps);
    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.removed.length, 0);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(task.phase, "agent_running");
    assert.equal(task.attempts[1].finishedAt, null);
  });

  it("waits for a second consecutive finished tick before tearing the container down", async () => {
    const task = makeActiveTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
      codeStatus: { [CONTAINER_NAME]: makeCodeStatus(null) },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.removed.length, 0);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.deepEqual(task.attempts[1].finishedObservation, {
      headSha: "abc123",
      observedAt: NOW.toISOString(),
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [CONTAINER_ID]);
    assert.equal(task.activeContainerId, null);
  });

  it("restarts the confirmation when the agent goes back to work between ticks", async () => {
    const task = makeActiveTask();
    const options: HarnessOptions = {
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
      codeStatus: { [CONTAINER_NAME]: makeCodeStatus(null) },
    };
    const harness = makeHarness(options);

    await runTaskSchedulerTick(harness.deps);
    assert.ok(task.attempts[1].finishedObservation);

    options.instanceStatus = { [CONTAINER_NAME]: { state: "working", updatedAt: NOW.toISOString() } };
    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.attempts[1].finishedObservation, null);
    assert.equal(harness.removed.length, 0);

    options.instanceStatus = { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } };
    await runTaskSchedulerTick(harness.deps);
    assert.equal(harness.removed.length, 0);

    await runTaskSchedulerTick(harness.deps);
    assert.deepEqual(harness.removed, [CONTAINER_ID]);
  });

  it("restarts the confirmation when the head moves between finished ticks", async () => {
    const task = makeActiveTask();
    const options: HarnessOptions = {
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
      codeStatus: { [CONTAINER_NAME]: makeCodeStatus(null) },
    };
    const harness = makeHarness(options);

    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.attempts[1].finishedObservation?.headSha, "abc123");

    options.codeStatus = { [CONTAINER_NAME]: { ...makeCodeStatus(null), commitSha: "pushed456" } };
    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.removed.length, 0);
    assert.equal(task.attempts[1].finishedObservation?.headSha, "pushed456");

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [CONTAINER_ID]);
  });

  it("tears down a finished agent, captures the PR link and log tail, and settles for a tick", async () => {
    const task = makeActiveTask({ reviewRequest: null });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
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
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 0, rebase: 0, review: 1, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
      codeStatus: { [CONTAINER_NAME]: makeCodeStatus(null) },
    });

    await runTaskSchedulerTick(harness.deps);
    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.lastReviewedSha, "def456");
    assert.equal(task.lastReviewedDiffHash, "diff-hash-1");
  });

  it("times out a wedged attempt by failing the task but holding its container", async () => {
    const startedAt = new Date(NOW.getTime() - ATTEMPT_TIMEOUT_MS - 60_000).toISOString();
    const task = makeActiveTask({
      attempts: [makeAttempt({ step: "fix_ci", containerId: CONTAINER_ID, startedAt })],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 1, rebase: 0, review: 0, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "working", updatedAt: startedAt } },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, []);
    assert.equal(task.phase, "failed");
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(task.activeStep, "fix_ci");
    assert.equal(task.attempts[0].finishedAt, null);
    assert.match(task.attempts[0].error ?? "", /timed out after 120 minutes; its container was kept/);
    assert.match(task.error ?? "", /timed out after 120 minutes; its container was kept/);
    assert.equal(harness.store.readAttemptLog(task.id, 0), "captured log tail");
    assert.equal(harness.created.length, 0);

    const broadcastsBefore = harness.broadcasts.length;
    await runTaskSchedulerTick(harness.deps);
    assert.deepEqual(harness.removed, []);
    assert.equal(harness.created.length, 0);
    assert.equal(harness.broadcasts.length, broadcastsBefore);
    assert.equal(harness.store.get(task.id)?.phase, "failed");
  });

  it("still records a PR/MR the agent opened right before timing out", async () => {
    const startedAt = new Date(NOW.getTime() - ATTEMPT_TIMEOUT_MS - 60_000).toISOString();
    const task = makeActiveTask({
      reviewRequest: null,
      activeStep: "implement",
      attempts: [makeAttempt({ step: "implement", containerId: CONTAINER_ID, startedAt })],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "working", updatedAt: startedAt } },
      codeStatus: {
        [CONTAINER_NAME]: makeCodeStatus({
          id: "12",
          url: "https://github.com/acme/widgets/pull/12",
          sourceBranch: "feature",
        }),
      },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "failed");
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(task.reviewRequest?.id, "12");
    assert.deepEqual(harness.removed, []);
  });

  it("never times out an attempt whose agent is waiting on the user", async () => {
    const startedAt = new Date(NOW.getTime() - ATTEMPT_TIMEOUT_MS - 60_000).toISOString();
    const task = makeActiveTask({
      attempts: [makeAttempt({ step: "fix_ci", containerId: CONTAINER_ID, startedAt })],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 1, rebase: 0, review: 0, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "waiting", updatedAt: startedAt } },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.removed.length, 0);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(task.phase, "agent_running");
    assert.equal(task.attempts[0].finishedAt, null);
  });

  it("restarts the timeout clock when the agent resumes working after waiting", async () => {
    const startedAt = new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString();
    const resumedAt = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    const task = makeActiveTask({
      attempts: [makeAttempt({ step: "fix_ci", containerId: CONTAINER_ID, startedAt })],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 1, rebase: 0, review: 0, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "working", updatedAt: resumedAt } },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.removed.length, 0);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(task.phase, "agent_running");
    assert.equal(task.attempts[0].finishedAt, null);
  });

  it("times out an attempt once the restarted clock expires", async () => {
    const startedAt = new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString();
    const resumedAt = new Date(NOW.getTime() - ATTEMPT_TIMEOUT_MS - 60_000).toISOString();
    const task = makeActiveTask({
      attempts: [makeAttempt({ step: "fix_ci", containerId: CONTAINER_ID, startedAt })],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 1, rebase: 0, review: 0, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "working", updatedAt: resumedAt } },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, []);
    assert.equal(task.phase, "failed");
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.match(task.attempts[0].error ?? "", /timed out/);
  });

  it("times out an attempt whose metadata server is unreachable", async () => {
    const startedAt = new Date(NOW.getTime() - ATTEMPT_TIMEOUT_MS - 60_000).toISOString();
    const task = makeActiveTask({
      attempts: [makeAttempt({ step: "fix_ci", containerId: CONTAINER_ID, startedAt })],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 1, rebase: 0, review: 0, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, []);
    assert.equal(task.phase, "failed");
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.match(task.attempts[0].error ?? "", /timed out/);
  });

  it("times out an attempt that never wrote a status file", async () => {
    const startedAt = new Date(NOW.getTime() - ATTEMPT_TIMEOUT_MS - 60_000).toISOString();
    const task = makeActiveTask({
      attempts: [makeAttempt({ step: "fix_ci", containerId: CONTAINER_ID, startedAt })],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 1, rebase: 0, review: 0, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "working", updatedAt: null } },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, []);
    assert.equal(task.phase, "failed");
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.match(task.attempts[0].error ?? "", /timed out/);
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

  it("fails a task whose implement agent finished without opening a PR/MR, holding its container", async () => {
    const task = makeActiveTask({
      reviewRequest: null,
      activeStep: "implement",
      attempts: [makeAttempt({ step: "implement", containerId: CONTAINER_ID, startedAt: RECENT_START })],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
      codeStatus: { [CONTAINER_NAME]: makeCodeStatus(null) },
    });

    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.phase, "agent_running");
    assert.deepEqual(harness.removed, []);

    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /finished without opening a PR\/MR; its container was kept/);
    assert.equal(task.reviewRequest, null);
    assert.deepEqual(harness.removed, []);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(task.activeStep, "implement");
    assert.equal(task.attempts[0].finishedAt, null);
    assert.match(task.attempts[0].error ?? "", /without opening a PR\/MR/);
    assert.equal(harness.store.readAttemptLog(task.id, 0), "captured log tail");
    assert.equal(harness.created.length, 0);

    await runTaskSchedulerTick(harness.deps);
    assert.deepEqual(harness.removed, []);
    assert.equal(harness.created.length, 0);
  });

  it("still tears down a finished agent for a step without a container-side deliverable", async () => {
    const task = makeActiveTask({
      activeStep: "review",
      attempts: [makeAttempt({ step: "review", containerId: CONTAINER_ID, startedAt: RECENT_START, headShaBefore: "abc123", diffHashBefore: "diff-hash-1" })],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 0, rebase: 0, review: 1, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
      codeStatus: { [CONTAINER_NAME]: makeCodeStatus(null) },
      snapshot: [makeReviewRequest({ ciState: "pending" })],
    });

    await runTaskSchedulerTick(harness.deps);
    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [CONTAINER_ID]);
    assert.equal(task.activeContainerId, null);
    assert.equal(task.attempts[0].error, null);
    assert.ok(task.attempts[0].finishedAt);
    assert.equal(task.phase, "agent_running");
  });
});

describe("scheduler: resuming a held attempt", () => {
  function makeHeldImplementTask(startedAt = RECENT_START): Task {
    return makeActiveTask({
      phase: "failed",
      error: "Implement agent finished without opening a PR/MR; its container was kept",
      reviewRequest: null,
      activeStep: "implement",
      attempts: [
        makeAttempt({
          step: "implement",
          containerId: CONTAINER_ID,
          startedAt,
          finishedObservation: { headSha: "abc123", observedAt: NOW.toISOString() },
          error: "Implement agent finished without opening a PR/MR; its container was kept",
        }),
      ],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
    });
  }

  it("re-monitors the kept container on retry and advances once the agent has opened a PR/MR", async () => {
    const task = makeHeldImplementTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
      codeStatus: {
        [CONTAINER_NAME]: {
          ...makeCodeStatus({ id: "12", url: "https://github.com/acme/widgets/pull/12", sourceBranch: "feature" }),
          commitSha: "def456",
        },
      },
      snapshot: [makeReviewRequest({ ciState: "failed" })],
    });

    await resumeTask(harness.deps, task, false);
    harness.store.save(task);

    assert.equal(task.phase, "agent_running");
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(task.error, null);
    assert.equal(task.attempts[0].error, null);
    assert.equal(task.attemptsByStep.implement, 0);
    assert.deepEqual(harness.removed, []);

    await runTaskSchedulerTick(harness.deps);
    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [CONTAINER_ID]);
    assert.equal(task.reviewRequest?.id, "12");
    assert.equal(task.activeContainerId, null);
    assert.ok(task.attempts[0].finishedAt);
    assert.equal(task.attempts[0].error, null);
    assert.equal(task.phase, "agent_running");

    await runTaskSchedulerTick(harness.deps);
    assert.equal(harness.created.length, 1);
    assert.equal(harness.created[0].spawn.step, "fix_ci");
  });

  it("holds the container again on the next tick when a retried agent still has no PR/MR", async () => {
    const task = makeHeldImplementTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
      codeStatus: { [CONTAINER_NAME]: makeCodeStatus(null) },
    });

    await resumeTask(harness.deps, task, false);
    harness.store.save(task);
    assert.equal(task.phase, "agent_running");

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /without opening a PR\/MR; its container was kept/);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.deepEqual(harness.removed, []);
    assert.equal(harness.created.length, 0);
  });

  it("advances a retried finished agent even when it last changed state longer ago than the timeout", async () => {
    const startedAt = new Date(NOW.getTime() - 5 * 60 * 60_000).toISOString();
    const finishedAt = new Date(NOW.getTime() - ATTEMPT_TIMEOUT_MS - 60_000).toISOString();
    const task = makeHeldImplementTask(startedAt);
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: finishedAt } },
      codeStatus: {
        [CONTAINER_NAME]: {
          ...makeCodeStatus({ id: "12", url: "https://github.com/acme/widgets/pull/12", sourceBranch: "feature" }),
          commitSha: "def456",
        },
      },
      snapshot: [makeReviewRequest({ ciState: "failed" })],
    });

    await resumeTask(harness.deps, task, false);
    harness.store.save(task);
    await runTaskSchedulerTick(harness.deps);
    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [CONTAINER_ID]);
    assert.equal(task.reviewRequest?.id, "12");
    assert.equal(task.activeContainerId, null);
    assert.ok(task.attempts[0].finishedAt);
    assert.equal(task.attempts[0].error, null);
    assert.equal(task.phase, "agent_running");

    await runTaskSchedulerTick(harness.deps);
    assert.equal(harness.created.length, 1);
    assert.equal(harness.created[0].spawn.step, "fix_ci");
  });

  it("reports the missing deliverable, not a timeout, when a stale finished agent is retried unchanged", async () => {
    const startedAt = new Date(NOW.getTime() - 5 * 60 * 60_000).toISOString();
    const finishedAt = new Date(NOW.getTime() - ATTEMPT_TIMEOUT_MS - 60_000).toISOString();
    const task = makeHeldImplementTask(startedAt);
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: finishedAt } },
      codeStatus: { [CONTAINER_NAME]: makeCodeStatus(null) },
    });

    await resumeTask(harness.deps, task, false);
    harness.store.save(task);
    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /without opening a PR\/MR; its container was kept/);
    assert.doesNotMatch(task.error ?? "", /timed out/);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.deepEqual(harness.removed, []);
    assert.equal(harness.created.length, 0);
  });

  it("holds a timed-out container again when it is retried without the agent changing state", async () => {
    const startedAt = new Date(NOW.getTime() - ATTEMPT_TIMEOUT_MS - 60_000).toISOString();
    const task = makeActiveTask({
      phase: "failed",
      error: "Attempt timed out",
      attempts: [makeAttempt({ step: "fix_ci", containerId: CONTAINER_ID, startedAt, error: "Attempt timed out" })],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 1, rebase: 0, review: 0, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "working", updatedAt: startedAt } },
    });

    await resumeTask(harness.deps, task, false);
    harness.store.save(task);
    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /timed out/);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.deepEqual(harness.removed, []);
  });

  it("keeps watching a retried timed-out agent once prompting it has restarted the clock", async () => {
    const startedAt = new Date(NOW.getTime() - ATTEMPT_TIMEOUT_MS - 60_000).toISOString();
    const task = makeActiveTask({
      phase: "failed",
      error: "Attempt timed out",
      attempts: [makeAttempt({ step: "fix_ci", containerId: CONTAINER_ID, startedAt, error: "Attempt timed out" })],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 1, rebase: 0, review: 0, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "working", updatedAt: NOW.toISOString() } },
    });

    await resumeTask(harness.deps, task, false);
    harness.store.save(task);
    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "agent_running");
    assert.equal(task.attempts[0].error, null);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.deepEqual(harness.removed, []);
  });

  it("removes the kept container on discard, closes the attempt, and spawns a fresh agent next tick", async () => {
    const task = makeHeldImplementTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
    });

    await resumeTask(harness.deps, task, true);
    harness.store.save(task);

    assert.deepEqual(harness.removed, [CONTAINER_ID]);
    assert.equal(task.phase, "spawning");
    assert.equal(task.activeContainerId, null);
    assert.equal(task.activeStep, null);
    assert.equal(task.error, null);
    assert.equal(task.attempts[0].finishedAt, NOW.toISOString());
    assert.match(task.attempts[0].error ?? "", /without opening a PR\/MR/);
    assert.equal(task.attemptsByStep.implement, 0);

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.equal(harness.created[0].spawn.step, "implement");
    assert.equal(task.attempts.length, 2);
    assert.equal(task.phase, "agent_running");
  });

  it("records why a paused agent's container went away when it is discarded on resume", async () => {
    const task = makeActiveTask({ phase: "paused" });
    const harness = makeHarness({ tasks: [task], containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)] });

    await resumeTask(harness.deps, task, true);

    assert.deepEqual(harness.removed, [CONTAINER_ID]);
    assert.equal(task.phase, "spawning");
    assert.equal(task.attempts[1].error, DISCARDED_CONTAINER_ERROR);
    assert.equal(task.attemptsByStep.fix_ci, 1);
  });

  it("refuses to discard when the task has no container", async () => {
    const task = makeLinkedTask({ phase: "failed", error: "boom" });
    const harness = makeHarness({ tasks: [task] });

    await assert.rejects(resumeTask(harness.deps, task, true), /no agent container to discard/);
    assert.equal(task.phase, "failed");
  });

  it("refuses to resume a task that is neither failed nor paused", async () => {
    const task = makeLinkedTask({ phase: "waiting_ci" });
    const harness = makeHarness({ tasks: [task] });

    await assert.rejects(resumeTask(harness.deps, task, false), /Cannot resume task/);
  });
});

describe("scheduler: text tasks", () => {
  const ISSUE_URL = "https://github.com/acme/widgets/issues/42";
  const createdIssue: RepoWorkItem = {
    id: "42",
    reference: "#42",
    title: "Add a widget dashboard",
    url: ISSUE_URL,
    body: "Findings and plan",
    kind: "issue",
  };

  function makeActiveCreateIssueTask(): Task {
    return makeTextTask({
      phase: "agent_running",
      activeContainerId: CONTAINER_ID,
      activeStep: "create_issue",
      attemptsByStep: { create_issue: 1, implement: 0, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
      attempts: [makeAttempt({ step: "create_issue", containerId: CONTAINER_ID, startedAt: RECENT_START })],
    });
  }

  it("spawns a create_issue agent whose prompt carries the pasted text", async () => {
    const task = makeTextTask();
    const harness = makeHarness({ tasks: [task] });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.match(harness.created[0].prompt, /Explore the codebase and open an issue/);
    assert.match(harness.created[0].prompt, /Add a widget dashboard with usage charts/);
    assert.match(harness.created[0].prompt, /\/run\/crc-created-issue-url/);
    assert.match(harness.created[0].prompt, /gh issue create --body-file body\.md/);
    assert.equal(task.phase, "agent_running");
    assert.equal(task.activeStep, "create_issue");
    assert.equal(task.attemptsByStep.create_issue, 1);
  });

  it("captures the reported issue URL, adopts the work item, and moves on to implement", async () => {
    const task = makeActiveCreateIssueTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
      codeStatus: { [CONTAINER_NAME]: makeCodeStatus(null, ISSUE_URL) },
      workItems: [createdIssue],
    });

    await runTaskSchedulerTick(harness.deps);
    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [CONTAINER_ID]);
    assert.equal(task.createdIssueUrl, ISSUE_URL);
    assert.equal(task.attempts[0].error, null);
    assert.equal(harness.created.length, 0);

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(task.workItem, createdIssue);
    assert.equal(task.activeStep, "implement");
    assert.match(harness.created[0].prompt, /#42/);
    assert.match(harness.created[0].prompt, /open a pull\/merge request/);
  });

  it("fails a text task whose create_issue agent finished without reporting a URL, holding its container", async () => {
    const task = makeActiveCreateIssueTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
      codeStatus: { [CONTAINER_NAME]: makeCodeStatus(null) },
    });

    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.phase, "agent_running");

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 0);
    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /finished without reporting a created issue URL; its container was kept/);
    assert.deepEqual(harness.removed, []);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(task.attempts[0].finishedAt, null);
    assert.equal(harness.store.readAttemptLog(task.id, 0), "captured log tail");
  });

  it("does not link a PR/MR that a create_issue agent happened to open", async () => {
    const task = makeActiveCreateIssueTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
      codeStatus: {
        [CONTAINER_NAME]: makeCodeStatus(
          { id: "12", url: "https://github.com/acme/widgets/pull/12", sourceBranch: "feature" },
          ISSUE_URL,
        ),
      },
    });

    await runTaskSchedulerTick(harness.deps);
    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [CONTAINER_ID]);
    assert.equal(task.createdIssueUrl, ISSUE_URL);
    assert.equal(task.reviewRequest, null);
  });

  it("matches the reported issue URL regardless of scheme, host casing, and trailing slashes", async () => {
    const task = makeTextTask({
      createdIssueUrl: "http://GitHub.com/acme/widgets/issues/42/",
      attemptsByStep: { create_issue: 1, implement: 0, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
      attempts: [
        makeAttempt({ step: "create_issue", startedAt: RECENT_START, finishedAt: NOW.toISOString() }),
      ],
    });
    const harness = makeHarness({ tasks: [task], workItems: [createdIssue] });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(task.workItem, createdIssue);
    assert.equal(task.activeStep, "implement");
  });

  it("fails when the reported issue URL is not a URL at all", async () => {
    const task = makeTextTask({
      createdIssueUrl: "issue 42",
      attemptsByStep: { create_issue: 1, implement: 0, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
      attempts: [
        makeAttempt({ step: "create_issue", startedAt: RECENT_START, finishedAt: NOW.toISOString() }),
      ],
    });
    const harness = makeHarness({ tasks: [task], workItems: [createdIssue] });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 0);
    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /reported 'issue 42', which is not a URL/);
  });

  it("fails when the reported issue is not among the repository's open work items", async () => {
    const task = makeTextTask({
      createdIssueUrl: ISSUE_URL,
      attemptsByStep: { create_issue: 1, implement: 0, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
      attempts: [
        makeAttempt({ step: "create_issue", startedAt: RECENT_START, finishedAt: NOW.toISOString() }),
      ],
    });
    const harness = makeHarness({ tasks: [task], workItems: [] });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 0);
    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /not among the repository's open work items/);
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
    assert.equal(task.phase, "checking_closure");
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
    assert.equal(task.phase, "checking_closure");
    assert.equal(task.mergedAt, NOW.toISOString());
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
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 0, rebase: 0, review: 1, address_comments: 0 },
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
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 0, rebase: 0, review: 1, address_comments: 0 },
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
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 0, rebase: 0, review: 1, address_comments: 0 },
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
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 0, rebase: 0, review: 1, address_comments: 0 },
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
      instanceStatus: { [SPAWNED_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
      codeStatus: { [SPAWNED_NAME]: makeCodeStatus(null) },
    };
    const harness = makeHarness(options);

    await runTaskSchedulerTick(harness.deps);
    assert.equal(harness.created.length, 1);
    assert.equal(task.activeStep, "review");

    await runTaskSchedulerTick(harness.deps);
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

describe("scheduler: recovering agent containers after a restart", () => {
  const ORPHAN_ID = "0a0a0a0a0a0a0a0a";
  const ORPHAN_NAME = "crc-orphan-0a0a0a";

  function makeTaskContainer(spawn: TaskSpawn | null, status = "running"): TaskContainer {
    return { container: makeContainer(ORPHAN_ID, ORPHAN_NAME, status), spawn };
  }

  it("adopts a running container whose spawn was never recorded and keeps watching it", async () => {
    const task = makeLinkedTask({ phase: "spawning" });
    const harness = makeHarness({
      tasks: [task],
      taskContainers: [
        makeTaskContainer({ taskId: task.id, step: "review", headShaBefore: "abc123", diffHashBefore: "diff-hash-1" }),
      ],
      snapshot: [makeReviewRequest()],
      instanceStatus: { [ORPHAN_NAME]: { state: "working", updatedAt: NOW.toISOString() } },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 0);
    assert.equal(harness.removed.length, 0);
    assert.equal(task.phase, "agent_running");
    assert.equal(task.activeContainerId, ORPHAN_ID);
    assert.equal(task.activeStep, "review");
    assert.equal(task.attemptsByStep.review, 1);
    assert.equal(task.attempts.length, 1);
    assert.deepEqual(task.attempts[0], {
      step: "review",
      containerId: ORPHAN_ID,
      headShaBefore: "abc123",
      diffHashBefore: "diff-hash-1",
      startedAt: RECENT_START,
      finishedAt: null,
      finishedObservation: null,
      error: null,
    });
    assert.equal(harness.store.list()[0].activeContainerId, ORPHAN_ID);
  });

  it("adopts an exited container so the attempt is counted, then tears it down as usual", async () => {
    const task = makeTask();
    const harness = makeHarness({
      tasks: [task],
      taskContainers: [
        makeTaskContainer({ taskId: task.id, step: "implement", headShaBefore: null, diffHashBefore: null }, "exited"),
      ],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [ORPHAN_ID]);
    assert.equal(task.attempts[0].containerId, ORPHAN_ID);
    assert.match(task.attempts[0].error ?? "", /stopped unexpectedly/);
    assert.equal(harness.store.readAttemptLog(task.id, 0), "captured log tail");
    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /did not open a PR\/MR/);
    assert.equal(harness.created.length, 0);
  });

  it("removes a container that never started instead of adopting it, so the attempt is not counted", async () => {
    const task = makeTask();
    const harness = makeHarness({
      tasks: [task],
      taskContainers: [
        makeTaskContainer({ taskId: task.id, step: "implement", headShaBefore: null, diffHashBefore: null }, "created"),
      ],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [ORPHAN_ID]);
    assert.equal(harness.created.length, 1);
    assert.equal(task.attempts.length, 1);
    assert.notEqual(task.attempts[0].containerId, ORPHAN_ID);
    assert.equal(task.attemptsByStep.implement, 1);
    assert.equal(task.phase, "agent_running");
  });

  it("removes a container whose task label is unreadable", async () => {
    const task = makeTask();
    const harness = makeHarness({
      tasks: [task],
      taskContainers: [makeTaskContainer(null)],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [ORPHAN_ID]);
    assert.equal(harness.created.length, 1);
    assert.notEqual(task.attempts[0].containerId, ORPHAN_ID);
  });

  it("keeps an adopted container's task paused", async () => {
    const task = makeTask({ phase: "paused" });
    const harness = makeHarness({
      tasks: [task],
      taskContainers: [makeTaskContainer({ taskId: task.id, step: "implement", headShaBefore: null, diffHashBefore: null })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "paused");
    assert.equal(task.activeContainerId, ORPHAN_ID);
    assert.equal(harness.removed.length, 0);
  });

  it("leaves a tracked active container alone", async () => {
    const task = makeActiveTask();
    const harness = makeHarness({
      tasks: [task],
      taskContainers: [
        {
          container: makeContainer(CONTAINER_ID, CONTAINER_NAME),
          spawn: { taskId: task.id, step: "fix_ci", headShaBefore: null, diffHashBefore: null },
        },
      ],
      instanceStatus: { [CONTAINER_NAME]: { state: "working", updatedAt: NOW.toISOString() } },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.attempts.length, 2);
    assert.equal(harness.removed.length, 0);
    assert.equal(harness.broadcasts.length, 0);
  });

  it("keeps a held container across a restart while its failed task still points at it", async () => {
    const task = makeActiveTask({
      phase: "failed",
      error: "Attempt timed out; its container was kept",
      attempts: [
        makeAttempt({ step: "fix_ci", containerId: CONTAINER_ID, startedAt: RECENT_START, error: "Attempt timed out" }),
      ],
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 1, rebase: 0, review: 0, address_comments: 0 },
    });
    const harness = makeHarness({
      tasks: [task],
      taskContainers: [
        {
          container: makeContainer(CONTAINER_ID, CONTAINER_NAME),
          spawn: { taskId: task.id, step: "fix_ci", headShaBefore: null, diffHashBefore: null },
        },
      ],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, []);
    assert.equal(task.phase, "failed");
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(harness.broadcasts.length, 0);
  });

  it("removes a container whose task was deleted", async () => {
    const harness = makeHarness({
      tasks: [],
      taskContainers: [makeTaskContainer({ taskId: "gone", step: "implement", headShaBefore: null, diffHashBefore: null })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [ORPHAN_ID]);
  });

  it("removes a container left behind by an attempt that already finished", async () => {
    const task = makeLinkedTask({
      phase: "waiting_ci",
      attempts: [makeAttempt({ containerId: ORPHAN_ID, finishedAt: RECENT_START })],
    });
    const harness = makeHarness({
      tasks: [task],
      taskContainers: [makeTaskContainer({ taskId: task.id, step: "implement", headShaBefore: null, diffHashBefore: null })],
      snapshot: [makeReviewRequest({ ciState: "running" })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [ORPHAN_ID]);
    assert.equal(task.attempts.length, 1);
    assert.equal(task.activeContainerId, null);
  });

  it("removes a container belonging to a task that already runs another agent", async () => {
    const task = makeActiveTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      taskContainers: [makeTaskContainer({ taskId: task.id, step: "fix_ci", headShaBefore: null, diffHashBefore: null })],
      instanceStatus: { [CONTAINER_NAME]: { state: "working", updatedAt: NOW.toISOString() } },
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [ORPHAN_ID]);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(task.attempts.length, 2);
  });

  it("removes a container belonging to a finished task", async () => {
    const task = makeLinkedTask({ phase: "merged" });
    const harness = makeHarness({
      tasks: [task],
      taskContainers: [makeTaskContainer({ taskId: task.id, step: "review", headShaBefore: null, diffHashBefore: null })],
    });

    await runTaskSchedulerTick(harness.deps);

    assert.deepEqual(harness.removed, [ORPHAN_ID]);
    assert.equal(task.attempts.length, 0);
    assert.equal(task.phase, "merged");
  });

  it("keeps scheduling when an orphaned container cannot be removed", async () => {
    const task = makeTask();
    const harness = makeHarness({
      tasks: [task],
      taskContainers: [makeTaskContainer({ taskId: "gone", step: "implement", headShaBefore: null, diffHashBefore: null })],
    });
    harness.deps.removeContainer = async () => {
      throw new Error("docker is having a moment");
    };

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.equal(task.phase, "agent_running");
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

  it("captures the active attempt's log and holds its container when failing a task on repeated errors", async () => {
    const task = makeActiveTask();
    const harness = makeHarness({
      tasks: [task],
      containers: [makeContainer(CONTAINER_ID, CONTAINER_NAME)],
      instanceStatus: { [CONTAINER_NAME]: { state: "finished", updatedAt: NOW.toISOString() } },
    });

    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS - 1; i++) {
      await runTaskSchedulerTick(harness.deps);
    }
    assert.equal(task.phase, "agent_running");
    assert.equal(task.consecutiveErrors, MAX_CONSECUTIVE_ERRORS - 1);

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /Failed after 5 consecutive errors.*No code status stubbed.*its container was kept/);
    assert.deepEqual(harness.removed, []);
    assert.equal(task.activeContainerId, CONTAINER_ID);
    assert.equal(harness.store.readAttemptLog(task.id, 1), "captured log tail");
    assert.equal(task.attempts[1].finishedAt, null);
    assert.match(task.attempts[1].error ?? "", /consecutive errors/);

    await runTaskSchedulerTick(harness.deps);
    assert.deepEqual(harness.removed, []);
    assert.equal(task.consecutiveErrors, MAX_CONSECUTIVE_ERRORS);
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

describe("scheduler: multi-stage tasks", () => {
  const MERGED_AT = "2026-08-20T11:55:00.000Z";
  const AFTER_GRACE = new Date(Date.parse(MERGED_AT) + CLOSURE_GRACE_MS);
  const WITHIN_GRACE = new Date(Date.parse(MERGED_AT) + CLOSURE_GRACE_MS - 1);

  function openIssue(overrides: Partial<RepoWorkItem> = {}): RepoWorkItem {
    return {
      id: "7",
      reference: "#7",
      title: "Add widgets",
      url: "https://github.com/acme/widgets/issues/7",
      body: "Remaining: the widget export",
      kind: "issue",
      ...overrides,
    };
  }

  function makeCheckingTask(overrides: Partial<Task> = {}): Task {
    return makeLinkedTask({
      phase: "checking_closure",
      mergedAt: MERGED_AT,
      lastReviewedSha: "abc123",
      lastReviewedDiffHash: "diff-hash-1",
      attemptsByStep: { create_issue: 0, implement: 1, fix_ci: 3, rebase: 0, review: 1, address_comments: 0 },
      attempts: [
        makeAttempt({ step: "implement", containerId: "1000000000000000", finishedAt: "2026-08-20T10:30:00.000Z" }),
        makeAttempt({ step: "fix_ci", containerId: "2000000000000000", finishedAt: "2026-08-20T10:40:00.000Z" }),
        makeAttempt({ step: "fix_ci", containerId: "3000000000000000", finishedAt: "2026-08-20T10:50:00.000Z" }),
        makeAttempt({ step: "fix_ci", containerId: "4000000000000000", finishedAt: "2026-08-20T11:00:00.000Z" }),
        makeAttempt({ step: "review", containerId: "5000000000000000", finishedAt: "2026-08-20T11:10:00.000Z" }),
      ],
      consecutiveErrors: 1,
      error: "transient",
      ...overrides,
    });
  }

  it("moves a merged task to checking_closure, then to merged once its issue is closed", async () => {
    const task = makeLinkedTask({ lastReviewedSha: "abc123" });
    const options: HarnessOptions = {
      tasks: [task],
      snapshot: [makeReviewRequest({ approvedByHuman: true })],
      workItems: [openIssue()],
    };
    const harness = makeHarness(options);

    await runTaskSchedulerTick(harness.deps);
    assert.deepEqual(harness.merged, ["12"]);
    assert.equal(task.phase, "checking_closure");
    assert.equal(task.mergedAt, NOW.toISOString());

    options.workItems = [];
    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "merged");
    assert.deepEqual(harness.merged, ["12"]);
    assert.equal(harness.created.length, 0);
    assert.deepEqual(task.completedStages, []);
    assert.equal(harness.store.get(task.id)?.phase, "merged");
  });

  it("finishes a task whose issue closed even while still inside the grace period", async () => {
    const task = makeCheckingTask();
    const harness = makeHarness({ tasks: [task], workItems: [openIssue({ id: "8", url: "https://github.com/acme/widgets/issues/8" })], now: WITHIN_GRACE });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "merged");
    assert.equal(task.error, null);
    assert.equal(task.consecutiveErrors, 0);
  });

  it("waits without starting a stage while the issue is still open inside the grace period", async () => {
    const task = makeCheckingTask({ consecutiveErrors: 0, error: null });
    const harness = makeHarness({ tasks: [task], workItems: [openIssue()], now: WITHIN_GRACE });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "checking_closure");
    assert.equal(task.mergedAt, MERGED_AT);
    assert.deepEqual(task.completedStages, []);
    assert.equal(harness.created.length, 0);
    assert.equal(harness.broadcasts.length, 0);
  });

  it("starts a new stage with reset limits once the grace period passes with the issue still open", async () => {
    const task = makeCheckingTask();
    const harness = makeHarness({ tasks: [task], workItems: [openIssue()], now: AFTER_GRACE });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "spawning");
    assert.deepEqual(task.completedStages, [
      {
        reviewRequest: { id: "12", url: "https://github.com/acme/widgets/pull/12", sourceBranch: "feature" },
        startedAt: "2026-08-20T10:00:00.000Z",
        mergedAt: MERGED_AT,
        firstAttemptIndex: 0,
        attemptCount: 5,
      },
    ]);
    assert.equal(task.reviewRequest, null);
    assert.equal(task.lastReviewedSha, null);
    assert.equal(task.lastReviewedDiffHash, null);
    assert.equal(task.mergedAt, null);
    assert.equal(task.stageStartedAt, AFTER_GRACE.toISOString());
    assert.deepEqual(task.attemptsByStep, { create_issue: 0, implement: 0, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 });
    assert.equal(task.consecutiveErrors, 0);
    assert.equal(task.error, null);
    assert.equal(task.workItem?.body, "Remaining: the widget export");
    assert.equal(task.attempts.length, 5);
    assert.equal(harness.created.length, 0);
    assert.deepEqual(harness.store.get(task.id)?.completedStages, task.completedStages);

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.equal(harness.created[0].spawn.step, "implement");
    assert.match(harness.created[0].prompt, /Address issue #7/);
    assert.match(
      harness.created[0].prompt,
      /Earlier pull\/merge requests for this issue \(https:\/\/github\.com\/acme\/widgets\/pull\/12\) have already been merged but did not close it/,
    );
    assert.match(harness.created[0].prompt, /`Closes #7`/);
    assert.equal(task.phase, "agent_running");
    assert.equal(task.attempts.length, 6);
    assert.equal(task.attemptsByStep.implement, 1);
  });

  it("lets a new stage spawn fix_ci again after the previous stage used up its cap", async () => {
    const task = makeCheckingTask();
    const options: HarnessOptions = { tasks: [task], workItems: [openIssue()], now: AFTER_GRACE };
    const harness = makeHarness(options);
    await runTaskSchedulerTick(harness.deps);

    task.attempts.push(makeAttempt({ step: "implement", containerId: "6000000000000000", finishedAt: AFTER_GRACE.toISOString() }));
    task.attemptsByStep.implement = 1;
    task.reviewRequest = { id: "13", url: "https://github.com/acme/widgets/pull/13", sourceBranch: "stage-2" };
    options.snapshot = [makeReviewRequest({ id: "13", reference: "#13", ciState: "failed" })];

    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.equal(harness.created[0].spawn.step, "fix_ci");
    assert.match(harness.created[0].prompt, /#13/);
    assert.equal(task.phase, "agent_running");
  });

  it("follows the same path when the PR/MR was merged outside the app", async () => {
    const task = makeLinkedTask();
    const options: HarnessOptions = {
      tasks: [task],
      snapshot: [],
      getReviewRequest: async () => makeReviewRequest({ state: "merged" }),
      workItems: [openIssue()],
    };
    const harness = makeHarness(options);

    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.phase, "checking_closure");
    assert.equal(task.mergedAt, NOW.toISOString());

    options.now = new Date(NOW.getTime() + CLOSURE_GRACE_MS);
    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "spawning");
    assert.equal(task.completedStages.length, 1);
    assert.equal(task.completedStages[0].mergedAt, NOW.toISOString());
    assert.deepEqual(harness.merged, []);
  });

  it("skips create_issue in the second stage of a text task", async () => {
    const task = makeCheckingTask({
      sourceText: "Add a widget dashboard",
      createdIssueUrl: "https://github.com/acme/widgets/issues/7",
      attemptsByStep: { create_issue: 1, implement: 1, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
      attempts: [
        makeAttempt({ step: "create_issue", containerId: "1000000000000000", finishedAt: "2026-08-20T10:10:00.000Z" }),
        makeAttempt({ step: "implement", containerId: "2000000000000000", finishedAt: "2026-08-20T10:30:00.000Z" }),
      ],
    });
    const options: HarnessOptions = { tasks: [task], workItems: [openIssue()], now: AFTER_GRACE };
    const harness = makeHarness(options);

    await runTaskSchedulerTick(harness.deps);
    await runTaskSchedulerTick(harness.deps);

    assert.equal(harness.created.length, 1);
    assert.equal(harness.created[0].spawn.step, "implement");
    assert.equal(task.completedStages[0].attemptCount, 2);
  });

  it("records the attempt slice of each stage after the first", async () => {
    const task = makeCheckingTask({
      completedStages: [
        {
          reviewRequest: { id: "11", url: "https://github.com/acme/widgets/pull/11", sourceBranch: "first" },
          startedAt: "2026-08-20T08:00:00.000Z",
          mergedAt: "2026-08-20T09:00:00.000Z",
          firstAttemptIndex: 0,
          attemptCount: 2,
        },
      ],
      stageStartedAt: "2026-08-20T09:02:00.000Z",
    });
    const harness = makeHarness({ tasks: [task], workItems: [openIssue()], now: AFTER_GRACE });

    await runTaskSchedulerTick(harness.deps);
    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.completedStages.length, 2);
    assert.deepEqual(task.completedStages[1], {
      reviewRequest: { id: "12", url: "https://github.com/acme/widgets/pull/12", sourceBranch: "feature" },
      startedAt: "2026-08-20T09:02:00.000Z",
      mergedAt: MERGED_AT,
      firstAttemptIndex: 2,
      attemptCount: 3,
    });
    assert.match(
      harness.created[0].prompt,
      /\(https:\/\/github\.com\/acme\/widgets\/pull\/11, https:\/\/github\.com\/acme\/widgets\/pull\/12\)/,
    );
  });

  it("fails instead of starting another stage once the stage cap is reached", async () => {
    const earlierStages = Array.from({ length: MAX_STAGES - 1 }, (_, index) => ({
      reviewRequest: { id: `${index}`, url: `https://github.com/acme/widgets/pull/${index}`, sourceBranch: "b" },
      startedAt: "2026-08-20T08:00:00.000Z",
      mergedAt: "2026-08-20T09:00:00.000Z",
      firstAttemptIndex: 0,
      attemptCount: 0,
    }));
    const task = makeCheckingTask({ completedStages: earlierStages });
    const options: HarnessOptions = { tasks: [task], workItems: [openIssue()], now: AFTER_GRACE };
    const harness = makeHarness(options);

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", new RegExp(`#7 is still open after ${MAX_STAGES} merged stages`));
    assert.match(task.error ?? "", /close it by hand before resuming/);
    assert.equal(task.completedStages.length, MAX_STAGES - 1);
    assert.equal(harness.created.length, 0);

    await resumeTask({ removeContainer: async () => {}, now: () => AFTER_GRACE }, task, false);
    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /still open after/);

    await resumeTask({ removeContainer: async () => {}, now: () => AFTER_GRACE }, task, false);
    assert.equal(task.phase, "checking_closure");
    options.workItems = [];
    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.phase, "merged");
  });

  it("starts the last allowed stage when one below the cap", async () => {
    const earlierStages = Array.from({ length: MAX_STAGES - 2 }, (_, index) => ({
      reviewRequest: { id: `${index}`, url: `https://github.com/acme/widgets/pull/${index}`, sourceBranch: "b" },
      startedAt: "2026-08-20T08:00:00.000Z",
      mergedAt: "2026-08-20T09:00:00.000Z",
      firstAttemptIndex: 0,
      attemptCount: 0,
    }));
    const task = makeCheckingTask({ completedStages: earlierStages });
    const harness = makeHarness({ tasks: [task], workItems: [openIssue()], now: AFTER_GRACE });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "spawning");
    assert.equal(task.completedStages.length, MAX_STAGES - 1);
  });

  it("records a forge error during the closure check as a task error and keeps checking", async () => {
    const task = makeCheckingTask({ consecutiveErrors: 0, error: null });
    const options: HarnessOptions = { tasks: [task], workItemsError: new Error("forge is down"), now: AFTER_GRACE };
    const harness = makeHarness(options);

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "checking_closure");
    assert.equal(task.consecutiveErrors, 1);
    assert.match(task.error ?? "", /forge is down/);

    options.workItemsError = undefined;
    options.workItems = [];
    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "merged");
    assert.equal(task.error, null);
    assert.equal(task.consecutiveErrors, 0);
  });

  it("fails the task after repeated forge errors during the closure check", async () => {
    const task = makeCheckingTask({ consecutiveErrors: 0, error: null });
    const harness = makeHarness({ tasks: [task], workItemsError: new Error("forge is down"), now: AFTER_GRACE });

    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) {
      await runTaskSchedulerTick(harness.deps);
    }

    assert.equal(task.phase, "failed");
    assert.match(task.error ?? "", /consecutive errors.*forge is down/);
  });

  it("does not check closure for a paused task, and resumes it into checking_closure", async () => {
    const task = makeCheckingTask({ phase: "paused" });
    const options: HarnessOptions = { tasks: [task], workItems: [openIssue()], now: AFTER_GRACE };
    const harness = makeHarness(options);

    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.phase, "paused");
    assert.deepEqual(task.completedStages, []);

    await resumeTask({ removeContainer: async () => {}, now: () => AFTER_GRACE }, task, false);
    assert.equal(task.phase, "checking_closure");
    assert.equal(task.mergedAt, MERGED_AT);

    await runTaskSchedulerTick(harness.deps);
    assert.equal(task.phase, "spawning");
    assert.equal(task.completedStages.length, 1);
  });

  it("matches the issue URL regardless of scheme, host casing, and trailing slashes", async () => {
    const task = makeCheckingTask();
    const harness = makeHarness({
      tasks: [task],
      workItems: [openIssue({ url: "http://GitHub.com/acme/widgets/issues/7/" })],
      now: AFTER_GRACE,
    });

    await runTaskSchedulerTick(harness.deps);

    assert.equal(task.phase, "spawning");
    assert.equal(task.workItem?.url, "http://GitHub.com/acme/widgets/issues/7/");
  });
});
