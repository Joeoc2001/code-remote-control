import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page, Route } from "playwright";
import type { CreateQuickPromptRequest, LaunchQuickPromptRequest, QuickPrompt, RepoSource } from "@crc/shared";
import { startClientApp, type ClientAppHarness } from "./helpers/client-app-harness.js";
import { makeTask } from "./helpers/task-fixture.js";

interface QuickPromptBackend {
  promptsByRepo: Map<string, QuickPrompt[]>;
  requests: string[];
  launches: Array<{ id: string; body: LaunchQuickPromptRequest }>;
  fromTextRequests: number;
}

function makePrompt(key: string, text: string, overrides: Partial<QuickPrompt> = {}): QuickPrompt {
  const separator = key.indexOf(":");
  return {
    id: randomUUID(),
    repoSource: key.slice(0, separator) as RepoSource,
    repoFullName: key.slice(separator + 1),
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
    perpetual: false,
    configByStep: null,
    reviewRequestIds: [],
    lastLaunchedAt: null,
    error: null,
    ...overrides,
  };
}

async function installQuickPromptBackend(
  page: Page,
  initial: Record<string, Array<string | Partial<QuickPrompt>>> = {},
): Promise<QuickPromptBackend> {
  const backend: QuickPromptBackend = {
    promptsByRepo: new Map(
      Object.entries(initial).map(([key, entries]) => [
        key,
        entries.map((entry) =>
          typeof entry === "string" ? makePrompt(key, entry) : makePrompt(key, entry.text ?? "", entry),
        ),
      ]),
    ),
    requests: [],
    launches: [],
    fromTextRequests: 0,
  };

  const json = (route: Route, status: number, body?: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: body === undefined ? "" : JSON.stringify(body) });

  await page.route("**/api/quick-prompts**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    backend.requests.push(`${request.method()} ${url.pathname}${url.search}`);

    const launchMatch = /^\/api\/quick-prompts\/([^/]+)\/tasks$/.exec(url.pathname);
    if (request.method() === "POST" && launchMatch) {
      const id = decodeURIComponent(launchMatch[1]);
      const body = request.postDataJSON() as LaunchQuickPromptRequest;
      backend.launches.push({ id, body });
      const prompt = [...backend.promptsByRepo.values()].flat().find((candidate) => candidate.id === id);
      await json(route, 201, {
        ...makeTask("quick", "spawning", "2026-02-01T00:00:00.000Z"),
        workItem: null,
        sourceText: prompt?.text ?? null,
        quickPromptId: id,
      });
      return;
    }

    if (request.method() === "POST") {
      const body = request.postDataJSON() as CreateQuickPromptRequest;
      const key = `${body.repoSource}:${body.repoFullName}`;
      const prompts = backend.promptsByRepo.get(key) ?? [];
      if (prompts.some((prompt) => prompt.text === body.text.trim())) {
        await json(route, 409, { error: "This quick-prompt already exists for the repository" });
        return;
      }
      const prompt = makePrompt(key, body.text.trim(), { createdAt: new Date().toISOString() });
      backend.promptsByRepo.set(key, [...prompts, prompt]);
      await json(route, 201, prompt);
      return;
    }

    if (request.method() === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const entry = [...backend.promptsByRepo.entries()].find(([, prompts]) => prompts.some((p) => p.id === id));
      if (!entry) {
        await json(route, 404, { error: "not found" });
        return;
      }
      backend.promptsByRepo.set(entry[0], entry[1].filter((prompt) => prompt.id !== id));
      await route.fulfill({ status: 204 });
      return;
    }

    const key = `${url.searchParams.get("repoSource")}:${url.searchParams.get("repoFullName")}`;
    await json(route, 200, backend.promptsByRepo.get(key) ?? []);
  });

  await page.route("**/api/tasks/from-text", async (route) => {
    backend.fromTextRequests += 1;
    await route.fulfill({ status: 500, body: "quick-prompts must launch through /api/quick-prompts/:id/tasks" });
  });

  return backend;
}

describe("New Task modal quick-prompts", () => {
  let harness: ClientAppHarness;

  before(async () => {
    harness = await startClientApp({
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

  async function openModal(
    initial: Record<string, Array<string | Partial<QuickPrompt>>> = {},
  ): Promise<{ page: Page; backend: QuickPromptBackend }> {
    const page = await harness.browser.newPage();
    const backend = await installQuickPromptBackend(page, initial);
    await page.goto(`${harness.origin}/tasks`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "New Task" }).click();
    await page.getByRole("button", { name: "From quick-prompt" }).waitFor({ timeout: 10_000 });
    return { page, backend };
  }

  function createButton(page: Page) {
    return page.getByRole("button", { name: "Create Task", exact: true });
  }

  async function promptTexts(page: Page): Promise<string[]> {
    return (await page.getByRole("radiogroup", { name: "Quick-prompts" }).locator("label").allTextContents()).map(
      (text) => text.trim(),
    );
  }

  test("offers three modes and asks for a repository before showing quick-prompts", async () => {
    const { page, backend } = await openModal();
    try {
      const tabs = await page.locator("button", { hasText: /^From / }).allTextContents();
      assert.deepEqual(tabs, ["From work items", "From pasted text", "From quick-prompt"]);

      await page.getByRole("button", { name: "From quick-prompt" }).click();
      await page.getByText("Select a repository first.").waitFor();
      assert.equal(await createButton(page).isDisabled(), true);
      assert.deepEqual(backend.requests, []);
    } finally {
      await page.close();
    }
  });

  test("saves a quick-prompt and launches a task linked to it", async () => {
    const { page, backend } = await openModal();
    try {
      await page.getByRole("button", { name: "From quick-prompt" }).click();
      await page.getByRole("button", { name: /example\/repo/ }).click();
      await page.getByText("No quick-prompts saved for this repository yet.").waitFor();
      assert.equal(await createButton(page).isDisabled(), true);

      await page.getByLabel("New quick-prompt").fill("  Bump all dependencies  ");
      await page.getByRole("button", { name: "Save prompt" }).click();

      const radio = page.getByRole("radio", { name: "Bump all dependencies" });
      await radio.waitFor();
      assert.equal(await radio.isChecked(), true);
      assert.equal(await page.getByLabel("New quick-prompt").inputValue(), "");
      assert.deepEqual(backend.requests, [
        "GET /api/quick-prompts?repoFullName=example%2Frepo&repoSource=github",
        "POST /api/quick-prompts",
      ]);

      await page.getByRole("button", { name: "▸ Customise per step" }).click();
      await page.getByRole("combobox", { name: "Create issue" }).waitFor();

      await createButton(page).click();
      await page.getByRole("heading", { name: "New Task" }).waitFor({ state: "detached" });

      const promptId = backend.promptsByRepo.get("github:example/repo")![0].id;
      assert.deepEqual(backend.launches, [{ id: promptId, body: { configName: "default", configByStep: {} } }]);
      assert.equal(backend.fromTextRequests, 0);
      await page.getByRole("link", { name: "Quick-prompt", exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });

  test("selects among saved quick-prompts and removes them", async () => {
    const { page, backend } = await openModal({ "github:example/repo": ["First prompt", "Second prompt"] });
    try {
      await page.getByRole("button", { name: "From quick-prompt" }).click();
      await page.getByRole("button", { name: /example\/repo/ }).click();
      await page.getByRole("radio", { name: "First prompt" }).waitFor();
      assert.deepEqual(await promptTexts(page), ["First prompt", "Second prompt"]);
      assert.equal(await createButton(page).isDisabled(), true);

      await page.getByRole("radio", { name: "Second prompt" }).check();
      assert.equal(await createButton(page).isEnabled(), true);

      const secondId = backend.promptsByRepo.get("github:example/repo")![1].id;
      await page.getByRole("button", { name: "Remove quick-prompt" }).nth(1).click();
      await page.getByRole("radio", { name: "Second prompt" }).waitFor({ state: "detached" });

      assert.deepEqual(await promptTexts(page), ["First prompt"]);
      assert.equal(await createButton(page).isDisabled(), true);
      assert.ok(
        backend.requests.includes(`DELETE /api/quick-prompts/${secondId}`),
        backend.requests.join("\n"),
      );
      assert.deepEqual(
        backend.promptsByRepo.get("github:example/repo")!.map((prompt) => prompt.text),
        ["First prompt"],
      );
    } finally {
      await page.close();
    }
  });

  test("shows only the selected repository's quick-prompts", async () => {
    const { page } = await openModal({
      "github:example/repo": ["Repo prompt"],
      "github:example/other": ["Other prompt"],
    });
    try {
      await page.getByRole("button", { name: "From quick-prompt" }).click();
      await page.getByRole("button", { name: /example\/repo/ }).click();
      await page.getByRole("radio", { name: "Repo prompt" }).check();

      await page.getByRole("button", { name: /example\/other/ }).click();
      await page.getByRole("radio", { name: "Other prompt" }).waitFor();
      assert.deepEqual(await promptTexts(page), ["Other prompt"]);
      assert.equal(await page.getByRole("radio", { name: "Other prompt" }).isChecked(), false);
      assert.equal(await createButton(page).isDisabled(), true);
    } finally {
      await page.close();
    }
  });

  test("saves pasted text as a quick-prompt and reports duplicates", async () => {
    const { page, backend } = await openModal({ "github:example/repo": ["Already saved"] });
    try {
      await page.getByRole("button", { name: /example\/repo/ }).click();
      await page.getByRole("button", { name: "From pasted text" }).click();
      await page.getByPlaceholder("Describe the feature or fix...").fill("Add dark mode");
      await page.getByRole("button", { name: "Save as quick-prompt" }).click();
      await page.getByRole("button", { name: "Saved as quick-prompt" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Saved as quick-prompt" }).isDisabled(), true);

      await page.getByPlaceholder("Describe the feature or fix...").fill("Already saved");
      await page.getByRole("button", { name: "Save as quick-prompt" }).click();
      await page.getByText("This quick-prompt already exists for the repository").waitFor();

      await page.getByRole("button", { name: "From quick-prompt" }).click();
      await page.getByRole("radio", { name: "Add dark mode" }).waitFor();
      assert.deepEqual(await promptTexts(page), ["Already saved", "Add dark mode"]);
      assert.deepEqual(backend.launches, []);
    } finally {
      await page.close();
    }
  });

  test("marks perpetual quick-prompts in the list", async () => {
    const { page } = await openModal({
      "github:example/repo": [{ text: "Forever prompt", perpetual: true }, "One-off prompt"],
    });
    try {
      await page.getByRole("button", { name: "From quick-prompt" }).click();
      await page.getByRole("button", { name: /example\/repo/ }).click();
      await page.getByRole("radio", { name: "Forever prompt" }).waitFor();

      const rows = page.getByRole("radiogroup", { name: "Quick-prompts" }).locator(":scope > div");
      assert.equal(await rows.count(), 2);
      assert.equal(await rows.nth(0).getByText("Perpetual", { exact: true }).count(), 1);
      assert.equal(await rows.nth(1).getByText("Perpetual", { exact: true }).count(), 0);
      assert.deepEqual(await promptTexts(page), ["Forever prompt", "One-off prompt"]);
    } finally {
      await page.close();
    }
  });
});
