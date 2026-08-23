import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashDiffText } from "./diff-hash.js";

const DIFF = `diff --git a/src/widget.ts b/src/widget.ts
index 1111111..2222222 100644
--- a/src/widget.ts
+++ b/src/widget.ts
@@ -1,3 +1,4 @@
 context
+added
 context
`;

describe("hashDiffText", () => {
  it("hashes identical diffs identically, whatever commits produced them", () => {
    assert.equal(hashDiffText(DIFF), hashDiffText(`${DIFF}`));
  });

  it("changes when a single character of the diff changes", () => {
    assert.notEqual(hashDiffText(DIFF), hashDiffText(DIFF.replace("+added", "+addedd")));
  });
});
