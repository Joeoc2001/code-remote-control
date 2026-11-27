import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { startClientApp, type ClientAppHarness } from "./helpers/client-app-harness.js";
import { makeContainer } from "./helpers/container-fixture.js";

const CLAUDE_CONTAINER = makeContainer("a", "2026-01-01T00:00:00.000Z");
const ANTIGRAVITY_CONTAINER = { ...makeContainer("b", "2026-01-02T00:00:00.000Z"), agent: "antigravity" as const };
const CONFIGS = { configurations: [{ name: "default", agent: "claude" }, { name: "gemini", agent: "antigravity" }] };

function stubs(): Record<string, unknown> {
  const result: Record<string, unknown> = {
    "/api/containers": [CLAUDE_CONTAINER, ANTIGRAVITY_CONTAINER],
    "/api/configs": CONFIGS,
  };
  for (const container of [CLAUDE_CONTAINER, ANTIGRAVITY_CONTAINER]) {
    result[`/api/containers/${container.id}`] = container;
    result[`/api/containers/${container.id}/code-status`] = {
      branch: "main",
      commitSha: "0000000",
      headSha: "0000000",
      orgName: null,
      repoName: null,
      provider: "github",
      currentTaskDescription: null,
      createdIssueUrl: null,
      isMaterialChange: null,
      reviewRequest: null,
      pipeline: null,
      warnings: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    result[`/api/containers/${container.id}/instance-status`] = { state: "working", updatedAt: null, lastActivityAt: null };
  }
  return result;
}

describe("agent shown in the UI", () => {
  let harness: ClientAppHarness;
  let page: Page;

  before(async () => {
    harness = await startClientApp(stubs());
    page = await harness.browser.newPage();
  });

  after(async () => {
    await harness.stop();
  });

  test("each container card names the agent its container runs", async () => {
    await page.goto(`${harness.origin}/`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("container-agent").nth(1).waitFor({ timeout: 10_000 });

    const agents = await page.getByTestId("container-agent").allTextContents();

    assert.deepEqual([...agents].sort(), ["Antigravity", "Claude Code"]);
  });

  test("the health and status copy no longer assumes the agent is Claude", async () => {
    await page.goto(`${harness.origin}/`, { waitUntil: "domcontentloaded" });
    await page.locator('[title="The agent is working"]').nth(1).waitFor({ timeout: 10_000 });

    const body = await page.locator("body").innerText();
    const titles = await page.locator("[title]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")));

    assert.match(body, /Running · waiting for the agent/);
    assert.ok(titles.includes("The agent is working"));
    assert.doesNotMatch(body, /Claude(?! Code)/);
    assert.ok(!titles.some((title) => /Claude/.test(title ?? "")));
  });

  test("the new-container configuration picker shows which agent each configuration uses", async () => {
    await page.goto(`${harness.origin}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "New Container" }).click();
    await page.locator("option", { hasText: "default" }).first().waitFor({ state: "attached", timeout: 10_000 });

    const options = await page.locator("select option").evaluateAll((nodes) =>
      nodes.map((node) => ({ value: (node as HTMLOptionElement).value, text: node.textContent })),
    );

    assert.deepEqual(options, [
      { value: "default", text: "default · Claude Code" },
      { value: "gemini", text: "gemini · Antigravity" },
    ]);
  });

  test("the new-task configuration picker shows which agent each configuration uses", async () => {
    await page.goto(`${harness.origin}/tasks`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "New Task" }).click();
    await page.locator("option", { hasText: "default" }).first().waitFor({ state: "attached", timeout: 10_000 });

    const options = await page.locator("select").first().locator("option").allTextContents();

    assert.deepEqual(options, ["default · Claude Code", "gemini · Antigravity"]);
  });

  test("the container page names the agent next to its configuration", async () => {
    await page.goto(`${harness.origin}/view/${ANTIGRAVITY_CONTAINER.id}`, { waitUntil: "domcontentloaded" });

    await page.getByRole("button", { name: /Show metadata/ }).click();
    await page.getByText("Agent:").waitFor({ timeout: 10_000 });
    assert.match(await page.locator("body").innerText(), /Agent:\s*Antigravity/);
  });

  test("no request went unstubbed", () => {
    assert.deepEqual(harness.unstubbedRequests, []);
  });
});
