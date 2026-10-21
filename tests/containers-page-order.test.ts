import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { InstanceState } from "../packages/client/src/types.js";
import { startClientApp, type ClientAppHarness } from "./helpers/client-app-harness.js";
import { makeContainer } from "./helpers/container-fixture.js";

const CONTAINERS = [
  makeContainer("a", "2026-01-01T00:00:00.000Z"),
  makeContainer("b", "2026-01-02T00:00:00.000Z"),
  makeContainer("c", "2026-01-03T00:00:00.000Z", "exited"),
  makeContainer("d", "2026-01-04T00:00:00.000Z"),
  makeContainer("e", "2026-01-05T00:00:00.000Z"),
  makeContainer("f", "2026-01-06T00:00:00.000Z"),
  makeContainer("g", "2026-01-07T00:00:00.000Z"),
];

const INITIAL_STATES: Record<string, InstanceState> = {
  a: "waiting",
  b: "working",
  d: "finished",
  e: "awaiting-background",
  f: "waiting",
  g: "working",
};

function instanceStatus(state: InstanceState) {
  return { state, updatedAt: null };
}

function stubs(): Record<string, unknown> {
  const result: Record<string, unknown> = { "/api/containers": CONTAINERS };
  for (const container of CONTAINERS) {
    result[`/api/containers/${container.id}/code-status`] = {
      branch: "main",
      commitSha: "0000000",
      orgName: null,
      repoName: null,
      currentTaskDescription: null,
      reviewRequest: null,
    };
  }
  for (const [id, state] of Object.entries(INITIAL_STATES)) {
    result[`/api/containers/${id}/instance-status`] = instanceStatus(state);
  }
  return result;
}

describe("containers page order", () => {
  let harness: ClientAppHarness;

  before(async () => {
    harness = await startClientApp(stubs());
  });

  after(async () => {
    await harness.stop();
  });

  async function cardTitles(page: Page): Promise<string[]> {
    return (await page.locator("article h3").allTextContents()).map((text) => text.trim());
  }

  async function waitForOrder(page: Page, expected: string[]): Promise<void> {
    await page
      .waitForFunction(
        (titles) =>
          JSON.stringify([...document.querySelectorAll("article h3")].map((h) => h.textContent?.trim())) ===
          JSON.stringify(titles),
        expected,
        { timeout: 10_000 },
      )
      .catch(() => undefined);
    assert.deepEqual(await cardTitles(page), expected);
  }

  test("lists waiting, then finished, then busy, then status-less containers, newest first within each", async () => {
    const page = await harness.browser.newPage();
    try {
      await page.goto(`${harness.origin}/`, { waitUntil: "domcontentloaded" });

      await waitForOrder(page, ["f", "a", "d", "g", "e", "b", "c"]);
    } finally {
      await page.close();
    }
  });

  test("moves a container to the top when its instance status changes to waiting", async () => {
    const page = await harness.browser.newPage();
    try {
      await page.goto(`${harness.origin}/`, { waitUntil: "domcontentloaded" });
      await waitForOrder(page, ["f", "a", "d", "g", "e", "b", "c"]);

      harness.setStub("/api/containers/b/instance-status", instanceStatus("waiting"));
      harness.sendEvent("container-updated", CONTAINERS[1]);
      await waitForOrder(page, ["f", "b", "a", "d", "g", "e", "c"]);

      harness.setStub("/api/containers/f/instance-status", instanceStatus("working"));
      harness.sendEvent("container-updated", CONTAINERS[5]);
      await waitForOrder(page, ["b", "a", "d", "g", "f", "e", "c"]);
    } finally {
      await page.close();
      harness.setStub("/api/containers/b/instance-status", instanceStatus("working"));
      harness.setStub("/api/containers/f/instance-status", instanceStatus("waiting"));
    }
  });

  test("no unstubbed requests were made", () => {
    assert.deepEqual(harness.unstubbedRequests, []);
  });
});
