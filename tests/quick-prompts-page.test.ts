import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import type { CreateQuickPromptRequest, QuickPrompt, Task, TaskStep } from "@crc/shared";
import { startClientApp, type ClientAppHarness } from "./helpers/client-app-harness.js";
import { makeTask } from "./helpers/task-fixture.js";

const ALL_DEFAULT: Record<TaskStep, string> = {
  create_issue: "default",
  implement: "default",
  fix_ci: "default",
  rebase: "default",
  review: "default",
  address_comments: "default",
};

function makePrompt(id: string, overrides: Partial<QuickPrompt> = {}): QuickPrompt {
  return {
    id,
    repoSource: "github",
    repoFullName: "example/repo",
    text: `Prompt ${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    perpetual: false,
    configByStep: null,
    reviewRequestIds: [],
    lastLaunchedAt: null,
    error: null,
    ...overrides,
  };
}

function makeInstance(id: string, quickPromptId: string, phase: Task["phase"], createdAt: string): Task {
  return {
    ...makeTask(id, phase, createdAt),
    workItem: null,
    sourceText: `Instance ${id}`,
    quickPromptId,
  };
}

interface Backend {
  prompts: QuickPrompt[];
  requests: Array<{ method: string; path: string; body: unknown }>;
}

async function installBackend(page: Page, prompts: QuickPrompt[], tasks: Task[]): Promise<Backend> {
  const backend: Backend = { prompts: [...prompts], requests: [] };
  const json = (route: Route, status: number, body?: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: body === undefined ? "" : JSON.stringify(body) });

  await page.route("**/api/tasks", (route) => json(route, 200, tasks));

  await page.route("**/api/quick-prompts**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === "GET" || method === "DELETE" ? undefined : request.postDataJSON();
    backend.requests.push({ method, path: `${url.pathname}${url.search}`, body });

    const [, , , rawId, sub] = url.pathname.split("/");
    const id = rawId ? decodeURIComponent(rawId) : null;
    const prompt = backend.prompts.find((candidate) => candidate.id === id);

    if (method === "GET") {
      await json(route, 200, backend.prompts);
      return;
    }
    if (method === "POST" && id === null) {
      const { repoSource, repoFullName, text } = body as CreateQuickPromptRequest;
      const created = makePrompt(`new-${backend.prompts.length}`, { repoSource, repoFullName, text: text.trim() });
      backend.prompts.push(created);
      await json(route, 201, created);
      return;
    }
    if (!prompt) {
      await json(route, 404, { error: "Quick-prompt not found" });
      return;
    }
    if (method === "PATCH") {
      const patch = body as { perpetual?: boolean; configName?: string };
      if (patch.perpetual && patch.configName === "big") {
        await json(route, 400, { error: "Configuration 'big' for step 'review' not found" });
        return;
      }
      const updated: QuickPrompt = {
        ...prompt,
        perpetual: patch.perpetual ?? prompt.perpetual,
        configByStep: patch.configName
          ? (Object.fromEntries(Object.keys(ALL_DEFAULT).map((step) => [step, patch.configName])) as Record<
              TaskStep,
              string
            >)
          : prompt.configByStep,
      };
      backend.prompts = backend.prompts.map((candidate) => (candidate.id === prompt.id ? updated : candidate));
      await json(route, 200, updated);
      return;
    }
    if (method === "POST" && sub === "tasks") {
      await json(route, 201, makeInstance(`launched-${prompt.id}`, prompt.id, "spawning", "2026-03-01T00:00:00.000Z"));
      return;
    }
    if (method === "DELETE") {
      backend.prompts = backend.prompts.filter((candidate) => candidate.id !== prompt.id);
      await route.fulfill({ status: 204 });
      return;
    }
    await json(route, 500, { error: `unhandled ${method} ${url.pathname}` });
  });

  return backend;
}

describe("Quick-prompts page", () => {
  let harness: ClientAppHarness;

  before(async () => {
    harness = await startClientApp({
      "/api/configs": { configurations: [{ name: "default" }, { name: "big" }] },
      "/api/github/repos": {
        repos: [
          { fullName: "example/repo", description: null },
          { fullName: "example/other", description: null },
        ],
      },
    });
  });

  after(async () => {
    await harness.stop();
  });

  async function open(prompts: QuickPrompt[], tasks: Task[] = []): Promise<{ page: Page; backend: Backend }> {
    const page = await harness.browser.newPage();
    const backend = await installBackend(page, prompts, tasks);
    await page.goto(`${harness.origin}/quick-prompts`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Code Remote Control" }).waitFor({ timeout: 10_000 });
    return { page, backend };
  }

  function row(page: Page, text: string) {
    return page.getByRole("article", { name: text, exact: true });
  }

  test("lists every repository's quick-prompts grouped by repository with their state", async () => {
    const { page } = await open(
      [
        makePrompt("a", {
          text: "Bump dependencies",
          perpetual: true,
          configByStep: { ...ALL_DEFAULT, review: "big" },
          lastLaunchedAt: "2026-02-01T00:00:00.000Z",
        }),
        makePrompt("b", { text: "Waiting prompt", perpetual: true, configByStep: ALL_DEFAULT, reviewRequestIds: ["12"] }),
        makePrompt("c", {
          text: "Other repo prompt",
          repoFullName: "example/other",
          error: "Configuration 'retired' for step 'review' not found",
        }),
      ],
      [
        makeInstance("old", "a", "merged", "2026-01-01T00:00:00.000Z"),
        makeInstance("new", "a", "failed", "2026-02-01T00:00:00.000Z"),
      ],
    );
    try {
      await row(page, "Bump dependencies").waitFor();
      assert.deepEqual(await page.locator("main section h2").allTextContents(), ["GHexample/other", "GHexample/repo"]);
      assert.deepEqual(
        await page.getByRole("region", { name: "example/repo" }).getByRole("article").evaluateAll((els) =>
          els.map((el) => el.getAttribute("aria-label")),
        ),
        ["Bump dependencies", "Waiting prompt"],
      );

      const first = row(page, "Bump dependencies");
      assert.equal(await first.getByRole("switch", { name: "Perpetual" }).isChecked(), true);
      assert.equal(await first.getByTestId("stored-config").textContent(), "default (Review: big)");
      const lastTask = first.getByRole("link", { name: "Instance new" });
      assert.equal(await lastTask.getAttribute("href"), "/tasks/new");
      await first.getByText("Failed", { exact: true }).waitFor();
      await first.getByText("Blocked: the last task failed — resume or delete it to continue").waitFor();
      assert.equal(await first.getByText("Never", { exact: true }).count(), 0);

      const waiting = row(page, "Waiting prompt");
      await waiting.getByText("Waiting for open PR/MR #12 to close").waitFor();
      assert.equal(await waiting.getByText("None", { exact: true }).count(), 1);

      const other = row(page, "Other repo prompt");
      assert.equal(await other.getByRole("switch", { name: "Perpetual" }).isChecked(), false);
      assert.equal(await other.getByTestId("stored-config").textContent(), "No configuration stored yet");
      await other.getByText("Configuration 'retired' for step 'review' not found").waitFor();
      assert.equal(await other.getByText("Never", { exact: true }).count(), 1);
    } finally {
      await page.close();
    }
  });

  test("blocks on an older unfinished instance even when the newest one merged", async () => {
    const { page } = await open(
      [makePrompt("a", { text: "Older failure", perpetual: true, configByStep: ALL_DEFAULT })],
      [
        makeInstance("older", "a", "failed", "2026-01-01T00:00:00.000Z"),
        makeInstance("newer", "a", "merged", "2026-02-01T00:00:00.000Z"),
      ],
    );
    try {
      const prompt = row(page, "Older failure");
      await prompt.getByText("Blocked: the last task failed — resume or delete it to continue").waitFor();
      assert.equal(await prompt.getByText("Launching on the next scheduler tick").count(), 0);
      assert.equal(await prompt.getByRole("link", { name: "Instance newer" }).getAttribute("href"), "/tasks/newer");
      assert.equal(await prompt.getByRole("link", { name: "Blocking task" }).getAttribute("href"), "/tasks/older");
    } finally {
      await page.close();
    }
  });

  test("toggles perpetual on with the chosen configuration and off again", async () => {
    const { page, backend } = await open([makePrompt("a", { text: "Toggle me" })]);
    try {
      const prompt = row(page, "Toggle me");
      const toggle = prompt.getByRole("switch", { name: "Perpetual" });

      await toggle.click();
      await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[role=switch]")?.checked === true);
      await prompt.getByText("Launching on the next scheduler tick").waitFor();
      assert.equal(await prompt.getByTestId("stored-config").textContent(), "default");

      await toggle.click();
      await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[role=switch]")?.checked === false);

      assert.deepEqual(
        backend.requests.filter((r) => r.method === "PATCH"),
        [
          { method: "PATCH", path: "/api/quick-prompts/a", body: { perpetual: true, configName: "default", configByStep: {} } },
          { method: "PATCH", path: "/api/quick-prompts/a", body: { perpetual: false } },
        ],
      );
    } finally {
      await page.close();
    }
  });

  test("shows the server's error when perpetual cannot be turned on", async () => {
    const { page } = await open([makePrompt("a", { text: "Bad config", configByStep: { ...ALL_DEFAULT, create_issue: "big" } })]);
    try {
      const prompt = row(page, "Bad config");
      await prompt.getByRole("switch", { name: "Perpetual" }).click();
      await prompt.getByRole("alert").getByText("Configuration 'big' for step 'review' not found").waitFor();
      assert.equal(await prompt.getByRole("switch", { name: "Perpetual" }).isChecked(), false);
    } finally {
      await page.close();
    }
  });

  test("edits the stored configuration", async () => {
    const { page, backend } = await open([makePrompt("a", { text: "Configure me", configByStep: ALL_DEFAULT })]);
    try {
      const prompt = row(page, "Configure me");
      await prompt.getByText("Edit configuration").click();
      await prompt.getByRole("combobox", { name: "Configuration" }).selectOption("big");
      await prompt.getByRole("button", { name: "Save configuration" }).click();
      await page.waitForFunction(
        () => document.querySelector("[data-testid=stored-config]")?.textContent === "big",
      );
      assert.deepEqual(backend.requests.filter((r) => r.method === "PATCH").map((r) => r.body), [
        { configName: "big", configByStep: {} },
      ]);
    } finally {
      await page.close();
    }
  });

  test("keeps per-step overrides that arrive from the event stream when saving the configuration", async () => {
    const stored = makePrompt("a", { text: "Overridden elsewhere", configByStep: ALL_DEFAULT });
    const { page, backend } = await open([stored]);
    try {
      const prompt = row(page, "Overridden elsewhere");
      await prompt.getByText("Edit configuration").click();
      assert.equal(await prompt.getByRole("combobox", { name: "Review" }).count(), 0);

      harness.sendEvent("quick-prompt-updated", { ...stored, configByStep: { ...ALL_DEFAULT, review: "big" } });
      await prompt.getByTestId("stored-config").filter({ hasText: "default (Review: big)" }).waitFor();
      assert.equal(await prompt.getByRole("combobox", { name: "Review" }).inputValue(), "big");

      await Promise.all([
        page.waitForResponse((response) => response.request().method() === "PATCH"),
        prompt.getByRole("button", { name: "Save configuration" }).click(),
      ]);
      assert.deepEqual(backend.requests.filter((r) => r.method === "PATCH").map((r) => r.body), [
        { configName: "default", configByStep: { review: "big" } },
      ]);
    } finally {
      await page.close();
    }
  });

  test("launches an instance now and shows it as the last task", async () => {
    const { page, backend } = await open([makePrompt("a", { text: "Launch me" })], [
      makeInstance("older", "a", "merged", "2026-01-01T00:00:00.000Z"),
    ]);
    try {
      const prompt = row(page, "Launch me");
      await prompt.getByRole("link", { name: "Instance older" }).waitFor();
      await prompt.getByRole("button", { name: "Launch now" }).click();
      await prompt.getByRole("link", { name: "Instance launched-a" }).waitFor();
      assert.deepEqual(backend.requests.filter((r) => r.method === "POST"), [
        { method: "POST", path: "/api/quick-prompts/a/tasks", body: { configName: "default", configByStep: {} } },
      ]);
    } finally {
      await page.close();
    }
  });

  test("deletes a quick-prompt after confirmation", async () => {
    const { page, backend } = await open([makePrompt("a", { text: "Delete me" }), makePrompt("b", { text: "Keep me" })]);
    try {
      page.on("dialog", (dialog) => void dialog.accept());
      await row(page, "Delete me").getByRole("button", { name: "Delete" }).click();
      await row(page, "Delete me").waitFor({ state: "detached" });
      await row(page, "Keep me").waitFor();
      assert.ok(backend.requests.some((r) => r.method === "DELETE" && r.path === "/api/quick-prompts/a"));
    } finally {
      await page.close();
    }
  });

  test("filters by repository and saves a new quick-prompt for the selected one", async () => {
    const { page, backend } = await open([
      makePrompt("a", { text: "Repo prompt" }),
      makePrompt("b", { text: "Other prompt", repoFullName: "example/other" }),
    ]);
    try {
      await page.getByRole("button", { name: /example\/other/ }).click();
      await row(page, "Repo prompt").waitFor({ state: "detached" });
      await row(page, "Other prompt").waitFor();

      await page.getByLabel("New quick-prompt").fill("  Brand new  ");
      await page.getByRole("button", { name: "Save prompt" }).click();
      await row(page, "Brand new").waitFor();
      assert.deepEqual(backend.requests.filter((r) => r.method === "POST").map((r) => r.body), [
        { repoFullName: "example/other", repoSource: "github", text: "Brand new" },
      ]);

      await page.getByRole("button", { name: "Show all repositories" }).click();
      await row(page, "Repo prompt").waitFor();
    } finally {
      await page.close();
    }
  });

  test("follows live quick-prompt and task updates from the event stream", async () => {
    const prompt = makePrompt("live", { text: "Live prompt" });
    const { page } = await open([prompt, makePrompt("gone", { text: "Gone soon" })]);
    try {
      await row(page, "Live prompt").waitFor();

      harness.sendEvent("quick-prompt-updated", { ...prompt, perpetual: true, configByStep: ALL_DEFAULT, error: "Live error" });
      await row(page, "Live prompt").getByText("Live error").waitFor();
      assert.equal(await row(page, "Live prompt").getByRole("switch", { name: "Perpetual" }).isChecked(), true);

      harness.sendEvent("task-updated", makeInstance("relaunched", "live", "agent_running", "2026-04-01T00:00:00.000Z"));
      await row(page, "Live prompt").getByRole("link", { name: "Instance relaunched" }).waitFor();
      await row(page, "Live prompt").getByText("Relaunches once the current task has merged and its issue is closed").waitFor();

      harness.sendEvent("quick-prompt-updated", makePrompt("fresh", { text: "Fresh prompt", repoFullName: "example/other" }));
      await row(page, "Fresh prompt").waitFor();

      harness.sendEvent("quick-prompt-removed", { id: "gone" });
      await row(page, "Gone soon").waitFor({ state: "detached" });
    } finally {
      await page.close();
    }
  });

  test("every API request the page makes is stubbed", () => {
    assert.deepEqual(harness.unstubbedRequests, []);
  });
});
