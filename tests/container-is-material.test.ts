import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IS_MATERIAL_PATH as SERVER_PATH, parseIsMaterial, readIsMaterialChange } from "../packages/container-metadata-server/src/is-material.js";
import {
  buildCreateIssuePrompt,
  buildFixCiPrompt,
  buildRebasePrompt,
  buildReviewCommentsPrompt,
  buildReviewRequestPrompt,
  buildTaskImplementPrompt,
  IS_MATERIAL_PATH as PROMPT_PATH,
} from "@crc/shared/prompts";

function fileHolding(content: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "crc-is-material-")), "crc-is-material");
  writeFileSync(file, content);
  return file;
}

describe("container metadata server: is_material", () => {
  test("reads the path the prompts tell agents to write to", () => {
    assert.equal(SERVER_PATH, PROMPT_PATH);
    assert.equal(SERVER_PATH, "/run/crc-is-material");
  });

  test("maps true and false, ignoring surrounding whitespace", async () => {
    assert.equal(await readIsMaterialChange(fileHolding("true")), true);
    assert.equal(await readIsMaterialChange(fileHolding("false\n")), false);
    assert.equal(await readIsMaterialChange(fileHolding("  true  \n")), true);
  });

  test("reports a missing file as not reported", async () => {
    const missing = path.join(mkdtempSync(path.join(tmpdir(), "crc-is-material-")), "absent");
    assert.equal(await readIsMaterialChange(missing), null);
  });

  for (const garbage of ["", "yes", "TRUE", "true false", "1"]) {
    test(`fails loudly on ${JSON.stringify(garbage)}`, async () => {
      assert.throws(
        () => parseIsMaterial(garbage),
        new RegExp(`^Error: /run/crc-is-material must hold 'true' or 'false', but holds ${JSON.stringify(JSON.stringify(garbage.trim())).slice(1, -1)}$`),
      );
      await assert.rejects(readIsMaterialChange(fileHolding(garbage)), /must hold 'true' or 'false'/);
    });
  }
});

describe("is_material prompt guidance", () => {
  const item = { kind: "merge_request", reference: "!34", url: "https://gitlab.com/acme/widgets/-/merge_requests/34" } as const;
  const workItem = {
    id: "7",
    reference: "#7",
    title: "Add widgets",
    url: "https://gitlab.com/acme/widgets/-/issues/7",
    body: null,
    kind: "issue",
  } as const;
  const instruction = "write `true` or `false` (and nothing else) to /run/crc-is-material";

  test("is given to every agent that pushes code", () => {
    for (const prompt of [
      buildTaskImplementPrompt(workItem, "gitlab"),
      buildRebasePrompt(item),
      buildFixCiPrompt(item),
      buildReviewCommentsPrompt(item),
    ]) {
      assert.ok(prompt.includes(instruction), prompt);
      assert.ok(prompt.includes("substance of the merge request in a way a reviewer who already approved it"), prompt);
      assert.ok(prompt.includes("If unsure, write `true`. The task is incomplete until that file holds `true` or `false`."), prompt);
    }
  });

  test("is not given to agents that never push code", () => {
    for (const prompt of [
      buildReviewRequestPrompt(item, "threads"),
      buildReviewRequestPrompt(item, "comment"),
      buildCreateIssuePrompt("Add widgets", "gitlab"),
    ]) {
      assert.ok(!prompt.includes("crc-is-material"), prompt);
    }
  });
});
