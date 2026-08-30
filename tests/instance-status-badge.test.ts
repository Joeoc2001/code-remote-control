import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ManagedContainer } from "@crc/shared";
import type { InstanceStatus } from "@crc/container-metadata-types";
import { startClientApp, type ClientAppHarness } from "./helpers/client-app-harness.js";

const UPDATED_AT = "2026-08-30T10:00:00.000Z";

const CASES: Array<{ id: string; status: InstanceStatus; label: string; colour: string }> = [
  { id: "aaaa000000000000", status: { state: "working", updatedAt: UPDATED_AT }, label: "Working", colour: "sky" },
  { id: "bbbb000000000000", status: { state: "waiting", updatedAt: UPDATED_AT }, label: "Waiting", colour: "amber" },
  { id: "cccc000000000000", status: { state: "finished", updatedAt: UPDATED_AT }, label: "Finished", colour: "emerald" },
];

function makeContainer(id: string): ManagedContainer {
  return {
    id,
    name: `crc-${id.slice(0, 4)}`,
    configName: "default",
    repoName: "example/repo",
    status: "running",
    health: { container: "running", claude: "healthy" },
    subdomain: `crc-${id.slice(0, 4)}`,
    createdAt: "2026-08-30T09:00:00.000Z",
  };
}

const stubs: Record<string, unknown> = {
  "/api/containers": CASES.map((entry) => makeContainer(entry.id)),
};
for (const entry of CASES) {
  stubs[`/api/containers/${entry.id}`] = makeContainer(entry.id);
  stubs[`/api/containers/${entry.id}/instance-status`] = entry.status;
  stubs[`/api/containers/${entry.id}/code-status`] = {
    branch: "main",
    commitSha: "abc123",
    orgName: "example",
    repoName: "repo",
    provider: "github",
    currentTaskDescription: "Address issue #98",
    reviewRequest: null,
    pipeline: null,
    warnings: [],
    updatedAt: UPDATED_AT,
  };
}

describe("instance status badge", () => {
  let harness: ClientAppHarness;

  before(async () => {
    harness = await startClientApp(stubs);
  });

  after(async () => {
    await harness.stop();
  });

  async function badgeFor(id: string): Promise<{ text: string; className: string; title: string; color: string }> {
    const page = await harness.browser.newPage();
    try {
      await page.goto(`${harness.origin}/view/${id}`, { waitUntil: "networkidle" });
      const badge = page.locator(`span[title*="20"]`).filter({ hasText: /Working|Waiting|Finished/ }).first();
      await badge.waitFor({ timeout: 10_000 });
      return {
        text: ((await badge.textContent()) ?? "").trim(),
        className: (await badge.getAttribute("class")) ?? "",
        title: (await badge.getAttribute("title")) ?? "",
        color: await badge.evaluate((node) => getComputedStyle(node).color),
      };
    } finally {
      await page.close();
    }
  }

  for (const entry of CASES) {
    test(`renders a ${entry.colour} "${entry.label}" pill for the ${entry.status.state} state`, async () => {
      const badge = await badgeFor(entry.id);

      assert.equal(badge.text, entry.label);
      assert.match(badge.className, new RegExp(`bg-${entry.colour}-500/10`));
      assert.match(badge.className, new RegExp(`text-${entry.colour}-300`));
    });
  }

  test("the three states are styled distinctly rather than sharing a fallback colour", async () => {
    const colors = [];
    for (const entry of CASES) colors.push((await badgeFor(entry.id)).color);

    assert.equal(new Set(colors).size, CASES.length, `expected three distinct colours, got ${colors.join(", ")}`);
    for (const color of colors) assert.notEqual(color, "rgb(0, 0, 0)");
  });

  test("the waiting pill says what it is waiting for and since when", async () => {
    const badge = await badgeFor("bbbb000000000000");

    assert.match(badge.title, /^Waiting for your input since /);
    assert.ok(badge.title.includes(new Date(UPDATED_AT).toLocaleString()));
  });

  test("no unstubbed requests were made", () => {
    assert.deepEqual(harness.unstubbedRequests, []);
  });
});
