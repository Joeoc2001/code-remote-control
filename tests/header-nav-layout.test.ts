import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { startClientApp, type ClientAppHarness } from "./helpers/client-app-harness.js";

const VIEWPORTS = [
  { name: "small phone", width: 320, height: 568 },
  { name: "iPhone 13", width: 390, height: 844 },
  { name: "Pixel 7", width: 412, height: 915 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];

const ROUTES = [
  { path: "/", name: "Containers page" },
  { path: "/tasks", name: "Tasks page" },
  { path: "/tasks/task-1", name: "Task detail page" },
];

const EXPECTED_SEGMENTS = [
  { label: "Containers", href: "/" },
  { label: "Tasks", href: "/tasks" },
];

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface SegmentMeasurement {
  label: string;
  href: string | null;
  box: Box;
  visible: boolean;
  clippedByNav: boolean;
  outsideViewport: boolean;
  hitsSelf: boolean;
  hitDescription: string;
}

interface HeaderMeasurement {
  navBox: Box;
  segments: SegmentMeasurement[];
  actionBoxes: { label: string; box: Box }[];
  documentScrollWidth: number;
  viewportWidth: number;
}

function measureHeader(page: Page): Promise<HeaderMeasurement> {
  return page.evaluate(() => {
    const nav = document.querySelector("header nav");
    if (!nav) throw new Error("no <nav> inside <header>");
    const navRect = nav.getBoundingClientRect();
    const tolerance = 0.5;

    const segments = [...nav.querySelectorAll("a")].map((link) => {
      const rect = link.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const hitTarget = hit ? hit.closest("a, button") ?? hit : null;
      return {
        label: (link.textContent ?? "").trim(),
        href: link.getAttribute("href"),
        box: rect.toJSON() as Box,
        visible: rect.width > 0 && rect.height > 0,
        clippedByNav:
          rect.left < navRect.left - tolerance ||
          rect.right > navRect.right + tolerance ||
          rect.top < navRect.top - tolerance ||
          rect.bottom > navRect.bottom + tolerance,
        outsideViewport:
          rect.left < -tolerance ||
          rect.right > window.innerWidth + tolerance ||
          rect.top < -tolerance ||
          rect.bottom > window.innerHeight + tolerance,
        hitsSelf: hit !== null && (hit === link || link.contains(hit)),
        hitDescription: hitTarget
          ? `<${hitTarget.tagName.toLowerCase()}> "${(hitTarget.textContent ?? "").trim()}"`
          : "nothing (the point lies outside the viewport)",
      };
    });

    const actionBoxes = [...document.querySelectorAll("header button")].map((button) => ({
      label: (button.textContent ?? "").trim(),
      box: button.getBoundingClientRect().toJSON() as Box,
    }));

    return {
      navBox: navRect.toJSON() as Box,
      segments,
      actionBoxes,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe("header nav layout", () => {
  let harness: ClientAppHarness;

  before(async () => {
    harness = await startClientApp();
  });

  after(async () => {
    await harness.stop();
  });

  for (const viewport of VIEWPORTS) {
    for (const route of ROUTES) {
      const where = `${route.name} at ${viewport.name} (${viewport.width}x${viewport.height})`;

      test(`${where} renders every nav segment, unclipped and tappable`, async () => {
        const page = await harness.browser.newPage({
          viewport: { width: viewport.width, height: viewport.height },
          hasTouch: viewport.width < 768,
          isMobile: viewport.width < 768,
        });
        try {
          await page.goto(`${harness.origin}${route.path}`, { waitUntil: "networkidle" });
          await page.locator("header nav").waitFor();
          const measurement = await measureHeader(page);

          assert.deepEqual(
            measurement.segments.map(({ label, href }) => ({ label, href })),
            EXPECTED_SEGMENTS,
            `${where}: header nav does not contain the expected segments`,
          );

          for (const segment of measurement.segments) {
            assert.ok(segment.visible, `${where}: "${segment.label}" has zero size`);
            assert.ok(
              !segment.clippedByNav,
              `${where}: "${segment.label}" (${JSON.stringify(segment.box)}) is clipped by the nav ` +
                `(${JSON.stringify(measurement.navBox)})`,
            );
            assert.ok(
              !segment.outsideViewport,
              `${where}: "${segment.label}" (${JSON.stringify(segment.box)}) lies outside the ` +
                `${viewport.width}x${viewport.height} viewport`,
            );
            assert.ok(
              segment.hitsSelf,
              `${where}: tapping the centre of "${segment.label}" hits ${segment.hitDescription}`,
            );
          }

          for (const action of measurement.actionBoxes) {
            for (const segment of measurement.segments) {
              assert.ok(
                !overlaps(action.box, segment.box),
                `${where}: header action "${action.label}" overlaps nav segment "${segment.label}"`,
              );
            }
          }

          assert.ok(
            measurement.documentScrollWidth <= measurement.viewportWidth + 0.5,
            `${where}: the page scrolls horizontally (content ${measurement.documentScrollWidth}px ` +
              `wide in a ${measurement.viewportWidth}px viewport)`,
          );
        } finally {
          await page.close();
        }
      });
    }
  }

  test("the phone-width nav navigates between Containers and Tasks when tapped at its own coordinates", async () => {
    const page = await harness.browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await page.goto(`${harness.origin}/`, { waitUntil: "networkidle" });

      for (const step of [
        { label: "Tasks", expectedPath: "/tasks" },
        { label: "Containers", expectedPath: "/" },
      ]) {
        await page.locator("header nav").getByRole("link", { name: step.label, exact: true }).waitFor();
        const centre = await page.evaluate((label) => {
          const link = [...document.querySelectorAll("header nav a")].find(
            (candidate) => (candidate.textContent ?? "").trim() === label,
          );
          if (!link) throw new Error(`no "${label}" segment in the header nav`);
          const rect = link.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }, step.label);

        await page.touchscreen.tap(centre.x, centre.y);
        await page.waitForURL((url) => url.pathname === step.expectedPath);
      }
    } finally {
      await page.close();
    }
  });

  test("the active segment is marked for assistive technology", async () => {
    const page = await harness.browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      const currentSegment = async () =>
        page.locator("header nav a[aria-current='page']").evaluate((el) => (el.textContent ?? "").trim());

      await page.goto(`${harness.origin}/`, { waitUntil: "networkidle" });
      assert.equal(await currentSegment(), "Containers");

      await page.goto(`${harness.origin}/tasks`, { waitUntil: "networkidle" });
      assert.equal(await currentSegment(), "Tasks");

      await page.goto(`${harness.origin}/tasks/task-1`, { waitUntil: "networkidle" });
      assert.equal(await currentSegment(), "Tasks");
    } finally {
      await page.close();
    }
  });

  test("every API request the header pages make is stubbed", () => {
    assert.deepEqual(harness.unstubbedRequests, []);
  });
});
