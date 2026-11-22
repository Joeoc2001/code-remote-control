import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RepoWorkItem } from "../types.js";
import { mentionedWorkItems } from "./mentions.js";

function issue(number: number, repo = "acme/widgets"): RepoWorkItem {
  return {
    id: String(number),
    reference: `#${number}`,
    title: `Issue ${number}`,
    url: `https://github.com/${repo}/issues/${number}`,
    body: null,
    kind: "issue",
  };
}

const gitlabWorkItem: RepoWorkItem = {
  id: "gid://gitlab/WorkItem/9001",
  reference: "9001",
  title: "Work item",
  url: "https://gitlab.com/acme/widgets/-/work_items/9001",
  body: null,
  kind: "work_item",
};

function ids(title: string, body: string | null, items: RepoWorkItem[]): string[] {
  return mentionedWorkItems({ title, body }, items).map((item) => item.id);
}

describe("mentionedWorkItems", () => {
  it("matches a #N reference in the body", () => {
    assert.deepEqual(ids("Add widgets", "Closes #12", [issue(12), issue(13)]), ["12"]);
  });

  it("matches a reference that appears only in the title", () => {
    assert.deepEqual(ids("Fix #13: widgets", null, [issue(12), issue(13)]), ["13"]);
  });

  it("matches the work item's URL", () => {
    assert.deepEqual(ids("Add widgets", "See https://github.com/acme/widgets/issues/12 for context", [issue(12)]), ["12"]);
  });

  it("does not match #12 inside #123", () => {
    assert.deepEqual(ids("Add widgets", "Closes #123", [issue(12), issue(123)]), ["123"]);
  });

  it("does not match the URL of issue 12 inside the URL of issue 123", () => {
    assert.deepEqual(ids("Add widgets", "https://github.com/acme/widgets/issues/123", [issue(12)]), []);
  });

  it("ignores cross-repository references", () => {
    assert.deepEqual(ids("Add widgets", "Related to other/repo#12 and word#12", [issue(12)]), []);
  });

  it("ignores another repository's issue URL with the same number", () => {
    assert.deepEqual(ids("Add widgets", "https://github.com/other/repo/issues/12", [issue(12)]), []);
  });

  it("does not treat a numeric HTML entity as a reference", () => {
    assert.deepEqual(ids("Bump it&#39;s version", "it&#39;s a bump", [issue(39)]), []);
  });

  it("matches a GitLab work item without an iid only by URL", () => {
    assert.deepEqual(ids("Work 9001", "Mentions 9001 and #9001", [gitlabWorkItem]), []);
    assert.deepEqual(ids("Work", "https://gitlab.com/acme/widgets/-/work_items/9001", [gitlabWorkItem]), [
      gitlabWorkItem.id,
    ]);
  });

  it("returns every mentioned work item in listing order", () => {
    assert.deepEqual(ids("Fix #13", "Also #12", [issue(12), issue(13), issue(14)]), ["12", "13"]);
  });
});
