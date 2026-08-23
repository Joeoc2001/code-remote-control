import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isMissingBody, isPlaceholderBody, PLACEHOLDER_BODY_MARKERS } from "@crc/shared/bodies";
import {
  FORGE_BODY_PROMPT_SUFFIX,
  buildFixCiPrompt,
  buildIssuePrompt,
  buildRebasePrompt,
  buildReviewCommentsPrompt,
  buildReviewRequestPrompt,
  buildTaskImplementPrompt,
} from "@crc/shared/prompts";
import type { RepoReviewRequest, RepoWorkItem } from "@crc/shared";
import { buildClaudeHooks } from "../packages/server/src/docker.js";
import {
  AGENT_MEMORY_PATH,
  HOOK_GUIDANCE_PATH,
  agentMemory,
  hookGuidanceModule,
} from "../scripts/generate-agent-guidance.js";
import harness from "./helpers/session-harness.js";

const require = createRequire(import.meta.url);
const { findForgeBodyViolation, denialReason } = require("../claude/hooks/forge-body.js") as {
  findForgeBodyViolation: (command: string) => { program: string; flag: string; value: string } | null;
  denialReason: (violation: { program: string; flag: string; value: string }) => string;
};

const repoRoot = path.join(import.meta.dirname, "..");
const HOOK_PATH = path.join(repoRoot, "claude", "hooks", "forge-body.js");

const workItem: RepoWorkItem = {
  id: "7",
  reference: "#7",
  title: "Add widgets",
  url: "https://github.com/acme/widgets/issues/7",
  body: null,
  kind: "issue",
};

const mergeRequest: Pick<RepoReviewRequest, "kind" | "reference" | "url"> = {
  kind: "merge_request",
  reference: "!34",
  url: "https://gitlab.com/acme/widgets/-/merge_requests/34",
};

describe("forge body guidance in the agent prompts", () => {
  test("every prompt that can reach a forge carries the guidance", () => {
    const prompts = {
      issue: buildIssuePrompt(workItem),
      implement: buildTaskImplementPrompt(workItem),
      review: buildReviewRequestPrompt(mergeRequest),
      address_comments: buildReviewCommentsPrompt(mergeRequest),
      rebase: buildRebasePrompt(mergeRequest),
      fix_ci: buildFixCiPrompt(mergeRequest),
    };

    for (const [name, prompt] of Object.entries(prompts)) {
      assert.ok(prompt.includes(FORGE_BODY_PROMPT_SUFFIX), `${name} prompt lacks the body guidance`);
    }
  });

  test("the guidance forbids the stdin markers and names a working alternative per CLI", () => {
    assert.match(FORGE_BODY_PROMPT_SUFFIX, /never pass `@-` or `-`/);
    assert.match(FORGE_BODY_PROMPT_SUFFIX, /--body-file body\.md/);
    assert.match(FORGE_BODY_PROMPT_SUFFIX, /--description "\$\(cat body\.md\)"/);
    assert.match(FORGE_BODY_PROMPT_SUFFIX, /-F 'description=@body\.md'/);
  });

  test("prompts keep their own instruction ahead of the guidance", () => {
    assert.match(buildReviewRequestPrompt(mergeRequest), /^Review merge request !34 /);
    assert.match(buildFixCiPrompt(mergeRequest), /^Investigate the failing CI /);
  });
});

describe("every copy of the guidance is generated from the one source", () => {
  test("the checked-in agent memory and hook guidance are what the generator emits", () => {
    assert.equal(
      readFileSync(AGENT_MEMORY_PATH, "utf-8"),
      agentMemory(),
      "claude/agent-memory.md is stale — run `npm run generate:agent-guidance`",
    );
    assert.equal(
      readFileSync(HOOK_GUIDANCE_PATH, "utf-8"),
      hookGuidanceModule(),
      "claude/hooks/forge-body-guidance.js is stale — run `npm run generate:agent-guidance`",
    );
  });

  test("the hook's denial quotes the same guidance the prompts carry", () => {
    const reason = denialReason({ program: "glab", flag: "-m", value: "@-" });
    assert.ok(reason.includes(FORGE_BODY_PROMPT_SUFFIX));
    assert.match(reason, /^Blocked: `glab -m @-`/);
  });

  test("the README points at the memory file instead of restating it", () => {
    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf-8");
    assert.match(readme, /claude\/agent-memory\.md/);
    assert.ok(!readme.includes("--body-file body.md"), "README restates guidance it should point at");
  });
});

describe("the env image installs the guidance and the hook that enforces it", () => {
  const dockerfile = readFileSync(path.join(repoRoot, "docker", "Dockerfile.env"), "utf-8");

  test("the memory file is copied to the path Claude Code reads as user memory", () => {
    assert.match(dockerfile, /^COPY claude\/agent-memory\.md \/root\/\.claude\/CLAUDE\.md$/m);
  });

  test("the container settings run the hook before every Bash command", () => {
    assert.deepEqual(buildClaudeHooks().PreToolUse, [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "node /opt/crc/claude-hooks/forge-body.js" }],
      },
    ]);
  });

  test("the checked-in settings template documents the hooks the server installs", () => {
    const template = JSON.parse(readFileSync(path.join(repoRoot, "claude", "settings.template.json"), "utf-8")) as {
      hooks: unknown;
    };
    assert.deepEqual(template.hooks, buildClaudeHooks());
  });
});

describe("the hook blocks a stdin marker handed to a flag that posts it verbatim", () => {
  const blocked = [
    "gh pr create --title Widgets --body @-",
    "gh pr comment 12 --body '@-'",
    "gh pr review 12 --body -",
    "gh pr create --body=@-",
    "glab mr create --description @-",
    'glab mr note 12 -m "@-"',
    "glab mr update 12 --description=@-",
    "glab mr note 12 -m@-",
    "glab mr note 12 -m @-",
    "/usr/bin/glab mr note 12 -m -",
  ];

  for (const command of blocked) {
    test(`blocks ${command}`, () => {
      assert.notEqual(findForgeBodyViolation(command), null);
    });
  }

  const allowed = [
    "gh pr create --title Widgets --body-file body.md",
    "gh pr create --title Widgets --body-file -",
    "cat body.md | gh pr create --title Widgets --body-file -",
    "gh api repos/acme/widgets/issues/7/comments -F body=@-",
    "glab api projects/1/merge_requests/12 -X PUT -F 'description=@body.md'",
    'glab mr note 12 -m "$(cat body.md)"',
    'gh pr create --body "- one\\n- two"',
    "curl -d @- https://example.com",
    "git commit -m -",
  ];

  for (const command of allowed) {
    test(`allows ${command.replace(/\n/g, "\\n")}`, () => {
      assert.equal(findForgeBodyViolation(command), null);
    });
  }

  test("names the offending flag and value so the agent can fix it", () => {
    assert.deepEqual(findForgeBodyViolation("glab mr note 12 -m @-"), {
      program: "glab",
      flag: "-m",
      value: "@-",
    });
  });

  test("denies the Bash tool call end to end", () => {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "glab mr create --description @-" },
    });
    const stdout = execFileSync("node", [HOOK_PATH], { input: payload, encoding: "utf-8" });
    const output = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes(FORGE_BODY_PROMPT_SUFFIX));
  });

  test("stays out of the way of an innocent Bash call and of other tools", () => {
    const clean = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh pr create --title Widgets --body-file body.md" },
    });
    assert.equal(execFileSync("node", [HOOK_PATH], { input: clean, encoding: "utf-8" }), "");

    const otherTool = JSON.stringify({ tool_name: "Write", tool_input: { file_path: "-", content: "@-" } });
    assert.equal(execFileSync("node", [HOOK_PATH], { input: otherTool, encoding: "utf-8" }), "");
  });
});

describe("placeholder body detection", () => {
  test("recognises the stdin markers, with or without surrounding whitespace", () => {
    for (const marker of PLACEHOLDER_BODY_MARKERS) {
      assert.equal(isPlaceholderBody(marker), true, marker);
      assert.equal(isPlaceholderBody(` ${marker}\n`), true, marker);
    }
  });

  test("leaves real bodies alone", () => {
    assert.equal(isPlaceholderBody("Fixes #7"), false);
    assert.equal(isPlaceholderBody("- one\n- two"), false);
    assert.equal(isPlaceholderBody("@-@"), false);
    assert.equal(isPlaceholderBody("pass `@-` only to `gh api -F body=@-`"), false);
    assert.equal(isPlaceholderBody(null), false);
  });

  test("an absent or blank body counts as missing, a real one does not", () => {
    assert.equal(isMissingBody(null), true);
    assert.equal(isMissingBody(""), true);
    assert.equal(isMissingBody(" \n\t"), true);
    assert.equal(isMissingBody("Fixes #7"), false);
  });
});

describe("the guidance survives the trip into a container session", () => {
  test("tmux hands the implement prompt to claude verbatim, shell metacharacters and all", async () => {
    const prompt = buildTaskImplementPrompt(workItem);
    assert.match(prompt, /\$\(cat body\.md\)/);

    const result = await harness.startSessionWithRealTmux({
      transcriptFiles: [],
      initialPrompt: prompt,
    });

    assert.deepEqual(result.claudeArgv, [prompt]);
  });
});
