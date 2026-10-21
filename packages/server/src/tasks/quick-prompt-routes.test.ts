import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createQuickPromptsRouter } from "./quick-prompt-routes.js";
import { QuickPromptStore } from "./quick-prompt-store.js";
import { TaskStore } from "./store.js";
import type { QuickPrompt, ResolvedConfigFile, Task, TaskPhase, TaskStep } from "../types.js";

const NOW = new Date("2026-08-20T12:00:00.000Z");

const CONFIG_FILE: ResolvedConfigFile = {
  root_domain: "example.com",
  git: { email: "bot@example.com", username: "bot" },
  configurations: [
    { name: "default", oauth: { accessToken: "token" } },
    { name: "big", oauth: { accessToken: "token" } },
  ],
};

function allSteps(configName: string, overrides: Partial<Record<TaskStep, string>> = {}): Record<TaskStep, string> {
  return {
    create_issue: configName,
    implement: configName,
    fix_ci: configName,
    rebase: configName,
    review: configName,
    address_comments: configName,
    ...overrides,
  };
}

describe("quick-prompt routes", () => {
  let server: Server;
  let origin: string;
  let store: QuickPromptStore;
  let tasks: TaskStore;
  let configFile: ResolvedConfigFile;
  const promptBroadcasts: QuickPrompt[] = [];
  const removedBroadcasts: string[] = [];
  const taskBroadcasts: Task[] = [];

  before(async () => {
    store = new QuickPromptStore(mkdtempSync(join(tmpdir(), "crc-quick-prompt-routes-")));
    tasks = new TaskStore(mkdtempSync(join(tmpdir(), "crc-quick-prompt-routes-tasks-")));
    const app = express();
    app.use(express.json());
    app.use(
      createQuickPromptsRouter({
        quickPrompts: store,
        tasks,
        loadConfigurations: async () => configFile,
        broadcastQuickPromptUpdated: (prompt) => promptBroadcasts.push(prompt),
        broadcastQuickPromptRemoved: (id) => removedBroadcasts.push(id),
        broadcastTaskUpdated: (task) => taskBroadcasts.push(task),
        now: () => NOW,
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no port");
    origin = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    configFile = CONFIG_FILE;
    promptBroadcasts.length = 0;
    removedBroadcasts.length = 0;
    taskBroadcasts.length = 0;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  function query(repoSource: string, repoFullName: string): string {
    return new URLSearchParams({ repoSource, repoFullName }).toString();
  }

  function list(repoSource: string, repoFullName: string): Promise<Response> {
    return fetch(`${origin}/api/quick-prompts?${query(repoSource, repoFullName)}`);
  }

  function send(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function create(body: unknown): Promise<Response> {
    return send("POST", "/api/quick-prompts", body);
  }

  function update(id: string, body: unknown): Promise<Response> {
    return send("PATCH", `/api/quick-prompts/${encodeURIComponent(id)}`, body);
  }

  function launch(id: string, body: unknown): Promise<Response> {
    return send("POST", `/api/quick-prompts/${encodeURIComponent(id)}/tasks`, body);
  }

  function remove(id: string): Promise<Response> {
    return send("DELETE", `/api/quick-prompts/${encodeURIComponent(id)}`);
  }

  async function errorOf(res: Response): Promise<string> {
    return ((await res.json()) as { error: string }).error;
  }

  function saveInstance(prompt: QuickPrompt, phase: TaskPhase): Task {
    const task: Task = {
      id: `instance-${prompt.id}-${phase}`,
      repoFullName: prompt.repoFullName,
      repoSource: prompt.repoSource,
      workItem: null,
      sourceText: prompt.text,
      quickPromptId: prompt.id,
      createdIssueUrl: null,
      configByStep: allSteps("default"),
      phase,
      reviewRequest: null,
      lastReviewedSha: null,
      lastReviewedDiffHash: null,
      activeContainerId: null,
      activeStep: null,
      attemptsByStep: { create_issue: 0, implement: 0, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
      attempts: [],
      completedStages: [],
      stageStartedAt: NOW.toISOString(),
      mergedAt: null,
      consecutiveErrors: 0,
      error: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    tasks.save(task);
    return task;
  }

  it("creates, lists and deletes quick-prompts for a repository, broadcasting each change", async () => {
    const created = await create({ repoSource: "github", repoFullName: "owner/routes", text: "  Bump deps \n" });
    assert.equal(created.status, 201);
    const prompt = (await created.json()) as QuickPrompt;
    assert.equal(prompt.text, "Bump deps");
    assert.equal(prompt.repoSource, "github");
    assert.equal(prompt.repoFullName, "owner/routes");
    assert.equal(prompt.perpetual, false);
    assert.deepEqual(promptBroadcasts, [prompt]);

    const listed = await list("github", "owner/routes");
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), [prompt]);
    assert.deepEqual(await (await list("gitlab", "owner/routes")).json(), []);

    const deleted = await remove(prompt.id);
    assert.equal(deleted.status, 204);
    assert.deepEqual(removedBroadcasts, [prompt.id]);
    assert.deepEqual(await (await list("github", "owner/routes")).json(), []);
  });

  it("lists every repository's quick-prompts when no repository is given", async () => {
    const github = store.add("github", "owner/all-a", "A prompt");
    const gitlab = store.add("gitlab", "group/sub/all-b", "B prompt");

    const res = await fetch(`${origin}/api/quick-prompts`);
    assert.equal(res.status, 200);
    const all = (await res.json()) as QuickPrompt[];
    assert.deepEqual(
      all.filter((prompt) => prompt.id === github.id || prompt.id === gitlab.id),
      [github, gitlab],
    );
    assert.deepEqual(all, store.listAll());
  });

  it("rejects duplicate text for the same repository with 409 but allows it elsewhere", async () => {
    assert.equal((await create({ repoSource: "github", repoFullName: "owner/dupes", text: "Same" })).status, 201);

    const duplicate = await create({ repoSource: "github", repoFullName: "owner/dupes", text: " Same " });
    assert.equal(duplicate.status, 409);
    assert.match(await errorOf(duplicate), /already exists/);

    assert.equal((await create({ repoSource: "gitlab", repoFullName: "owner/dupes", text: "Same" })).status, 201);
    assert.equal(store.list("github", "owner/dupes").length, 1);
  });

  it("rejects empty or missing text", async () => {
    for (const text of ["", "   \n", undefined, 42]) {
      const res = await create({ repoSource: "github", repoFullName: "owner/empty", text });
      assert.equal(res.status, 400, `text ${JSON.stringify(text)}`);
    }
    assert.deepEqual(store.list("github", "owner/empty"), []);
  });

  it("validates the repository when listing one repository or creating", async () => {
    const cases = [
      { repoSource: "bitbucket", repoFullName: "owner/repo", error: /repoSource must be/ },
      { repoSource: "github", repoFullName: "not-a-repo", error: /owner\/repo format/ },
      { repoSource: "github", repoFullName: "", error: /repoFullName is required/ },
    ];
    for (const { repoSource, repoFullName, error } of cases) {
      for (const res of [await list(repoSource, repoFullName), await create({ repoSource, repoFullName, text: "Prompt" })]) {
        assert.equal(res.status, 400, `${res.url} ${repoSource}:${repoFullName}`);
        assert.match(await errorOf(res), error);
      }
    }
  });

  it("returns 404 for an unknown quick-prompt on every per-prompt endpoint", async () => {
    const before = store.listAll();
    assert.equal((await remove("unknown")).status, 404);
    assert.equal((await update("unknown", { perpetual: false })).status, 404);
    assert.equal((await launch("unknown", { configName: "default" })).status, 404);
    assert.deepEqual(store.listAll(), before);
    assert.deepEqual(removedBroadcasts, []);
  });

  describe("PATCH /api/quick-prompts/:id", () => {
    it("turns perpetual on with a configuration, then off again, persisting both", async () => {
      const prompt = store.add("github", "owner/patch", "Keep the docs fresh");
      store.update(prompt.id, { error: "stale error" });

      const on = await update(prompt.id, { perpetual: true, configName: "default", configByStep: { implement: "big" } });
      assert.equal(on.status, 200);
      const turnedOn = (await on.json()) as QuickPrompt;
      assert.equal(turnedOn.perpetual, true);
      assert.deepEqual(turnedOn.configByStep, allSteps("default", { implement: "big" }));
      assert.equal(turnedOn.error, null);
      assert.deepEqual(store.get(prompt.id), turnedOn);
      assert.deepEqual(promptBroadcasts, [turnedOn]);

      const off = await update(prompt.id, { perpetual: false });
      assert.equal(off.status, 200);
      const turnedOff = (await off.json()) as QuickPrompt;
      assert.equal(turnedOff.perpetual, false);
      assert.deepEqual(turnedOff.configByStep, allSteps("default", { implement: "big" }));
      assert.deepEqual(store.get(prompt.id), turnedOff);
    });

    it("changes the stored configuration alone, or patches single steps of it", async () => {
      const prompt = store.add("github", "owner/patch-config", "Prompt");

      const noStoredConfig = await update(prompt.id, { configByStep: { review: "big" } });
      assert.equal(noStoredConfig.status, 400);
      assert.match(await errorOf(noStoredConfig), /configName is required/);

      const setConfig = await update(prompt.id, { configName: "big" });
      assert.equal(setConfig.status, 200);
      assert.deepEqual(((await setConfig.json()) as QuickPrompt).configByStep, allSteps("big"));
      assert.equal(store.get(prompt.id)?.perpetual, false);

      const patchStep = await update(prompt.id, { configByStep: { review: "default" } });
      assert.equal(patchStep.status, 200);
      assert.deepEqual(store.get(prompt.id)?.configByStep, allSteps("big", { review: "default" }));
    });

    it("refuses to make a prompt perpetual without a configuration", async () => {
      const prompt = store.add("github", "owner/patch-noconfig", "Prompt");
      const res = await update(prompt.id, { perpetual: true });
      assert.equal(res.status, 400);
      assert.match(await errorOf(res), /configName is required to make a quick-prompt perpetual/);
      assert.equal(store.get(prompt.id)?.perpetual, false);
    });

    it("refuses to make a prompt perpetual when its stored configuration no longer exists", async () => {
      const prompt = store.add("github", "owner/patch-gone", "Prompt");
      store.update(prompt.id, { configByStep: allSteps("default", { fix_ci: "retired" }) });
      const res = await update(prompt.id, { perpetual: true });
      assert.equal(res.status, 400);
      assert.match(await errorOf(res), /Configuration 'retired' for step 'fix_ci' not found/);
      assert.equal(store.get(prompt.id)?.perpetual, false);
    });

    it("validates the request body", async () => {
      const prompt = store.add("github", "owner/patch-validate", "Prompt");
      const cases: Array<{ body: unknown; error: RegExp }> = [
        { body: {}, error: /Provide perpetual, configName or configByStep/ },
        { body: { perpetual: "yes", configName: "default" }, error: /perpetual must be a boolean/ },
        { body: { perpetual: true, configName: "missing" }, error: /Configuration 'missing' not found/ },
        { body: { configName: "default", configByStep: { bogus: "default" } }, error: /Unknown task step 'bogus'/ },
        { body: { configName: "default", configByStep: { review: "missing" } }, error: /'missing' for step 'review'/ },
        { body: { configName: "default", configByStep: ["default"] }, error: /configByStep must be an object/ },
      ];
      for (const { body, error } of cases) {
        const res = await update(prompt.id, body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.match(await errorOf(res), error);
      }
      assert.deepEqual(store.get(prompt.id), prompt);
      assert.deepEqual(promptBroadcasts, []);
    });
  });

  describe("POST /api/quick-prompts/:id/tasks", () => {
    it("launches a task linked to the quick-prompt and stores the configuration on the prompt", async () => {
      const prompt = store.add("gitlab", "group/sub/launch", "Refresh the changelog");

      const res = await launch(prompt.id, { configName: "default", configByStep: { implement: "big" } });
      assert.equal(res.status, 201);
      const task = (await res.json()) as Task;

      assert.equal(task.quickPromptId, prompt.id);
      assert.equal(task.sourceText, "Refresh the changelog");
      assert.equal(task.workItem, null);
      assert.equal(task.repoSource, "gitlab");
      assert.equal(task.repoFullName, "group/sub/launch");
      assert.equal(task.phase, "spawning");
      assert.deepEqual(task.configByStep, allSteps("default", { implement: "big" }));
      assert.equal(task.createdAt, NOW.toISOString());
      assert.deepEqual(tasks.get(task.id)?.quickPromptId, prompt.id);
      assert.deepEqual(taskBroadcasts.map((t) => t.id), [task.id]);

      const stored = store.get(prompt.id);
      assert.deepEqual(stored?.configByStep, allSteps("default", { implement: "big" }));
      assert.equal(stored?.lastLaunchedAt, NOW.toISOString());
      assert.equal(stored?.perpetual, false);
      assert.deepEqual(promptBroadcasts, [stored]);
    });

    it("lets a non-perpetual prompt launch while another instance is still running", async () => {
      const prompt = store.add("github", "owner/launch-many", "Prompt");
      saveInstance(prompt, "agent_running");
      assert.equal((await launch(prompt.id, { configName: "default" })).status, 201);
    });

    it("refuses a second instance of a perpetual prompt until the last one has merged", async () => {
      const prompt = store.add("github", "owner/launch-perpetual", "Prompt");
      store.update(prompt.id, { perpetual: true, configByStep: allSteps("default") });

      for (const phase of ["agent_running", "checking_closure", "paused", "failed"] as const) {
        const instance = saveInstance(prompt, phase);
        const res = await launch(prompt.id, { configName: "default" });
        assert.equal(res.status, 409, phase);
        assert.match(await errorOf(res), new RegExp(`unfinished task \\(${instance.id}, ${phase}\\)`));
        tasks.remove(instance.id);
      }

      saveInstance(prompt, "merged");
      assert.equal((await launch(prompt.id, { configName: "default" })).status, 201);
    });

    it("validates the configuration", async () => {
      const prompt = store.add("github", "owner/launch-validate", "Prompt");
      for (const body of [{}, { configName: "missing" }, { configName: "default", configByStep: { review: "missing" } }]) {
        const res = await launch(prompt.id, body);
        assert.equal(res.status, 400, JSON.stringify(body));
      }
      assert.equal(tasks.list().filter((task) => task.quickPromptId === prompt.id).length, 0);
      assert.deepEqual(store.get(prompt.id), prompt);
    });
  });
});
