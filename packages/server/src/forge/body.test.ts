import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isStdinPlaceholderBody } from "./body.js";

describe("isStdinPlaceholderBody", () => {
  it("flags the stdin placeholders agents misapply to porcelain commands", () => {
    assert.equal(isStdinPlaceholderBody("@-"), true);
    assert.equal(isStdinPlaceholderBody("@"), true);
    assert.equal(isStdinPlaceholderBody("-"), true);
  });

  it("flags a placeholder posted with surrounding whitespace", () => {
    assert.equal(isStdinPlaceholderBody(" @- "), true);
    assert.equal(isStdinPlaceholderBody("@-\n"), true);
  });

  it("leaves real bodies alone, including ones that merely contain a placeholder", () => {
    assert.equal(isStdinPlaceholderBody("Adds widgets"), false);
    assert.equal(isStdinPlaceholderBody("Pass the body with `@-` only to `gh api`"), false);
    assert.equal(isStdinPlaceholderBody("- Adds widgets\n- Adds gadgets"), false);
    assert.equal(isStdinPlaceholderBody("@reviewer please look"), false);
  });

  it("does not treat an empty body as a placeholder", () => {
    assert.equal(isStdinPlaceholderBody(""), false);
    assert.equal(isStdinPlaceholderBody("   "), false);
  });
});
