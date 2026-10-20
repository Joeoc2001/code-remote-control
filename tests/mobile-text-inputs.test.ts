import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";
import type { ManagedContainer } from "@crc/shared";
import { startClientApp, type ClientAppHarness } from "./helpers/client-app-harness.js";
import { makeTask } from "./helpers/task-fixture.js";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const PROSE_HINTS = {
  autocorrect: "on",
  autocapitalize: "sentences",
  spellcheck: "true",
  autocomplete: "on",
  inputmode: "text",
  enterkeyhint: "enter",
};

const SEARCH_HINTS = {
  type: "search",
  autocorrect: "off",
  autocapitalize: "none",
  spellcheck: "false",
  autocomplete: "off",
  enterkeyhint: "search",
};

const RUNNING_TASK = makeTask("1", "agent_running", "2026-01-01T00:00:00.000Z");

function stoppedContainer(updatedName: string): ManagedContainer {
  return {
    id: "container-1",
    name: `crc-${updatedName}`,
    configName: "default",
    repoName: "example/repo",
    status: "exited",
    health: { container: "stopped", claude: "unknown" },
    subdomain: "container-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

async function openPage(browser: Browser, url: string, viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(() => {
    const counts = { added: 0, removed: 0 };
    (window as unknown as { keydownListenerChurn: typeof counts }).keydownListenerChurn = counts;
    const add = document.addEventListener;
    const remove = document.removeEventListener;
    document.addEventListener = function (this: Document, ...args: Parameters<Document["addEventListener"]>) {
      if (args[0] === "keydown") counts.added += 1;
      return add.apply(this, args);
    };
    document.removeEventListener = function (this: Document, ...args: Parameters<Document["removeEventListener"]>) {
      if (args[0] === "keydown") counts.removed += 1;
      return remove.apply(this, args);
    };
  });
  await page.goto(url, { waitUntil: "networkidle" });
  return page;
}

function keydownListenerChurn(page: Page): Promise<{ added: number; removed: number }> {
  return page.evaluate(() => ({ ...(window as unknown as { keydownListenerChurn: { added: number; removed: number } }).keydownListenerChurn }));
}

async function attributes(page: Page, selector: string, names: string[]): Promise<Record<string, string | null>> {
  const element = page.locator(selector);
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await element.getAttribute(name)])));
}

function fontSizePx(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
}

async function openTaskPastedText(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New Task" }).click();
  await page.getByRole("button", { name: "GH example/repo" }).click();
  await page.getByRole("button", { name: "From pasted text" }).click();
  await page.locator("textarea").waitFor();
}

async function openSpawnManyPastedText(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New Container" }).click();
  await page.getByRole("button", { name: "GH example/repo" }).click();
  await page.getByRole("button", { name: "Spawn Many" }).click();
  await page.getByRole("button", { name: "Pasted Text" }).click();
  await page.locator("textarea").waitFor();
}

const SURFACES = [
  { name: "New Task 'From pasted text'", path: "/tasks", open: openTaskPastedText },
  { name: "New Container spawn-many 'Pasted Text'", path: "/", open: openSpawnManyPastedText },
];

describe("mobile text inputs", () => {
  let harness: ClientAppHarness;

  before(async () => {
    harness = await startClientApp({
      "/api/tasks": [RUNNING_TASK],
      "/api/github/repos": { repos: [{ fullName: "example/repo", description: null }] },
    });
  });

  after(async () => {
    await harness.stop();
  });

  for (const surface of SURFACES) {
    describe(surface.name, () => {
      test("the textarea asks the keyboard for predictive prose input", async () => {
        const page = await openPage(harness.browser, `${harness.origin}${surface.path}`, PHONE);
        try {
          await surface.open(page);
          assert.deepEqual(await attributes(page, "textarea", Object.keys(PROSE_HINTS)), PROSE_HINTS);
        } finally {
          await page.close();
        }
      });

      test("the repo search input asks the keyboard not to correct repo slugs", async () => {
        const page = await openPage(harness.browser, `${harness.origin}${surface.path}`, PHONE);
        try {
          await surface.open(page);
          assert.deepEqual(
            await attributes(page, "input[placeholder='Search repositories...']", Object.keys(SEARCH_HINTS)),
            SEARCH_HINTS,
          );
        } finally {
          await page.close();
        }
      });

      test("text fields are at least 16px on phones so iOS does not zoom on focus, and 14px on desktop", async () => {
        for (const [viewport, expected] of [[PHONE, 16], [DESKTOP, 14]] as const) {
          const page = await openPage(harness.browser, `${harness.origin}${surface.path}`, viewport);
          try {
            await surface.open(page);
            assert.equal(await fontSizePx(page, "textarea"), expected, `textarea at ${viewport.width}px`);
            assert.equal(
              await fontSizePx(page, "input[placeholder='Search repositories...']"),
              expected,
              `repo search at ${viewport.width}px`,
            );
          } finally {
            await page.close();
          }
        }
      });
    });
  }

  test("task-updated events do not churn the open New Task modal's keydown listener or disturb typing", async () => {
    const page = await openPage(harness.browser, `${harness.origin}/tasks`, PHONE);
    try {
      await openTaskPastedText(page);
      const textarea = page.locator("textarea");
      await textarea.click();
      await textarea.pressSequentially("Fix the bug");
      const before = await keydownListenerChurn(page);

      for (let i = 0; i < 5; i++) {
        const updatedAt = `2026-01-01T00:00:0${i + 1}.000Z`;
        harness.sendEvent("task-updated", { ...RUNNING_TASK, updatedAt, workItem: { ...RUNNING_TASK.workItem, title: `Update ${i}` } });
        await page.getByText(`#1 Update ${i}`).waitFor();
      }

      assert.deepEqual(await keydownListenerChurn(page), before);
      await textarea.pressSequentially(" now");
      assert.equal(await textarea.inputValue(), "Fix the bug now");
      assert.equal(await textarea.evaluate((element) => element === document.activeElement), true);
    } finally {
      await page.close();
    }
  });

  test("container-updated events do not churn the open New Container modal's keydown listener or disturb typing", async () => {
    const page = await openPage(harness.browser, `${harness.origin}/`, PHONE);
    try {
      await openSpawnManyPastedText(page);
      const textarea = page.locator("textarea");
      await textarea.click();
      await textarea.pressSequentially("First prompt");
      const before = await keydownListenerChurn(page);

      for (let i = 0; i < 5; i++) {
        harness.sendEvent("container-updated", stoppedContainer(`update-${i}`));
        await page.getByText(`update-${i}`, { exact: true }).waitFor();
      }

      assert.deepEqual(await keydownListenerChurn(page), before);
      await textarea.pressSequentially(" and more");
      assert.equal(await textarea.inputValue(), "First prompt and more");
      assert.equal(await textarea.evaluate((element) => element === document.activeElement), true);
    } finally {
      await page.close();
    }
  });

  test("no unstubbed requests were made", () => {
    assert.deepEqual(harness.unstubbedRequests, []);
  });
});
