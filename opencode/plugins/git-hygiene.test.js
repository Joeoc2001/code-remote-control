import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { GitHygieneCliWrappers } from "./git-hygiene.js";

function shellQuote(value) {
  const text = String(value);
  if (text.length === 0) return "''";
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function createCommandRunner(env, binDir) {
  return (strings, ...values) => {
    let command = "";
    for (let index = 0; index < strings.length; index += 1) {
      command += strings[index];
      if (index < values.length) command += shellQuote(values[index]);
    }

    const resolvedCommand = command
      .replace(/^git\b/, shellQuote(path.join(binDir, "git")))
      .replace(/^gh\b/, shellQuote(path.join(binDir, "gh")))
      .replace(/^glab\b/, shellQuote(path.join(binDir, "glab")));

    let allowFailure = false;
    const run = () =>
      new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", resolvedCommand], { env });
        const stdoutChunks = [];
        const stderrChunks = [];

        child.stdout.on("data", (chunk) => {
          stdoutChunks.push(chunk);
        });

        child.stderr.on("data", (chunk) => {
          stderrChunks.push(chunk);
        });

        child.on("error", reject);
        child.on("close", (code) => {
          const result = {
            code,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
          };

          if (code !== 0 && !allowFailure) {
            reject(new Error(`Command failed: ${resolvedCommand}\n${result.stderr}`));
            return;
          }

          resolve(result);
        });
      });

    return {
      nothrow() {
        allowFailure = true;
        return this;
      },
      async text() {
        const result = await run();
        return result.stdout;
      },
      then(resolve, reject) {
        return run().then(resolve, reject);
      },
    };
  };
}

async function setupFakeCliBin() {
  const root = await mkdtemp(path.join(tmpdir(), "git-hygiene-test-"));
  const binDir = path.join(root, "bin");
  await mkdir(binDir);

  const gitScript = `#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" == "rev-parse" && "$2" == "--is-inside-work-tree" ]]; then
  printf '%s\n' "\${TEST_GIT_WORKTREE_FLAG:-true}"
  exit 0
fi

if [[ "$1" == "status" && "$2" == "--porcelain" ]]; then
  printf '%s' "\${TEST_GIT_STATUS_PORCELAIN:-}"
  exit 0
fi

if [[ "$1" == "rev-parse" && "$2" == "--abbrev-ref" && "$3" == "--symbolic-full-name" ]]; then
  printf '%s\n' "\${TEST_GIT_UPSTREAM:-origin/main}"
  exit 0
fi

if [[ "$1" == "rev-list" && "$2" == "--count" ]]; then
  printf '%s\n' "\${TEST_GIT_AHEAD_COUNT:-2}"
  exit 0
fi

if [[ "$1" == "log" && "$2" == "--not" && "$3" == "--remotes" ]]; then
  printf '%s\n' "\${TEST_GIT_UNPUSHED_SHA:-}"
  exit 0
fi

if [[ "$1" == "rev-parse" && "$2" == "--abbrev-ref" && "$3" == "HEAD" ]]; then
  printf '%s\n' "\${TEST_GIT_BRANCH:-feature/test}"
  exit 0
fi

if [[ "$1" == "rev-parse" && "$2" == "HEAD" ]]; then
  printf '%s\n' "\${TEST_GIT_HEAD_SHA:-abc123}"
  exit 0
fi

printf 'unexpected git command: %s\n' "$*" >&2
exit 99
`;

  const ghScript = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "pr" ]]; then
  printf 'unexpected gh command: %s\n' "$*" >&2
  exit 99
fi

if [[ "$2" == "view" ]]; then
  printf '%s\n' "\${TEST_GH_PR_VIEW_JSON}"
  exit 0
fi

if [[ "$2" == "checks" ]]; then
  if [[ "$*" == *"--watch"* ]]; then
    exit 0
  fi
  printf '%s\n' "\${TEST_GH_PR_CHECKS_JSON}"
  exit 0
fi

printf 'unexpected gh command: %s\n' "$*" >&2
exit 99
`;

  const glabScript = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "api" ]]; then
  if [[ "$2" == *"/merge_requests"* ]]; then
    printf '%s\n' "\${TEST_GLAB_MR_JSON}"
    exit 0
  fi
  if [[ "$2" == *"/pipelines"* ]]; then
    printf '%s\n' "\${TEST_GLAB_PIPELINES_JSON}"
    exit 0
  fi
fi

if [[ "$1" == "ci" && "$2" == "status" ]]; then
  if [[ "$*" == *"--live"* ]]; then
    exit 0
  fi
fi

printf 'unexpected glab command: %s\n' "$*" >&2
exit 99
`;

  const gitPath = path.join(binDir, "git");
  const ghPath = path.join(binDir, "gh");
  const glabPath = path.join(binDir, "glab");

  await writeFile(gitPath, gitScript);
  await writeFile(ghPath, ghScript);
  await writeFile(glabPath, glabScript);
  await chmod(gitPath, 0o755);
  await chmod(ghPath, 0o755);
  await chmod(glabPath, 0o755);

  return { root, binDir };
}

test("git/github/gitlab wrappers invoke local CLI and parse outputs", async () => {
  const { root, binDir } = await setupFakeCliBin();

  try {
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ""}`,
      TEST_GIT_WORKTREE_FLAG: "true",
      TEST_GIT_STATUS_PORCELAIN: " M opencode/plugins/git-hygiene.js\n",
      TEST_GIT_UPSTREAM: "origin/main",
      TEST_GIT_AHEAD_COUNT: "3",
      TEST_GIT_UNPUSHED_SHA: "9a8b7c6d5e4f",
      TEST_GIT_BRANCH: "feature/git-hygiene-tests",
      TEST_GIT_HEAD_SHA: "0f1e2d3c4b5a",
      TEST_GH_PR_VIEW_JSON: JSON.stringify({
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        title: "Add git hygiene tests",
        state: "OPEN",
      }),
      TEST_GH_PR_CHECKS_JSON: JSON.stringify([
        {
          bucket: "pass",
          name: "build",
          state: "SUCCESS",
          link: "https://github.com/acme/repo/actions/runs/100",
        },
      ]),
      TEST_GLAB_MR_JSON: JSON.stringify([
        {
          web_url: "https://gitlab.example.com/acme/repo/-/merge_requests/8",
        },
      ]),
      TEST_GLAB_PIPELINES_JSON: JSON.stringify([
        {
          status: "success",
          sha: "0f1e2d3c4b5a",
          web_url: "https://gitlab.example.com/acme/repo/-/pipelines/1000",
        },
      ]),
    };

    const $ = createCommandRunner(env, binDir);

    assert.deepEqual(await GitHygieneCliWrappers.runGitRevParseInsideWorktree($), {
      isInsideWorkTree: true,
    });
    assert.deepEqual(await GitHygieneCliWrappers.runGitStatusPorcelain($), {
      hasUncommittedChanges: true,
    });
    assert.deepEqual(await GitHygieneCliWrappers.runGitUpstreamRef($), {
      upstream: "origin/main",
    });
    assert.deepEqual(await GitHygieneCliWrappers.runGitAheadCount($, "origin/main"), {
      count: 3,
    });
    assert.deepEqual(await GitHygieneCliWrappers.runGitUnpushedFromHead($), {
      hasUnpushedCommits: true,
    });
    assert.deepEqual(await GitHygieneCliWrappers.runGitCurrentBranch($), {
      branch: "feature/git-hygiene-tests",
    });
    assert.deepEqual(await GitHygieneCliWrappers.runGitHeadSha($), {
      headSha: "0f1e2d3c4b5a",
    });

    assert.deepEqual(await GitHygieneCliWrappers.runGithubPrView($, "feature/git-hygiene-tests"), {
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      title: "Add git hygiene tests",
      state: "OPEN",
    });
    assert.deepEqual(await GitHygieneCliWrappers.runGithubPrChecks($, "feature/git-hygiene-tests"), [
      {
        bucket: "pass",
        name: "build",
        state: "SUCCESS",
        link: "https://github.com/acme/repo/actions/runs/100",
      },
    ]);
    assert.deepEqual(await GitHygieneCliWrappers.runGithubPrChecksWatch($, "feature/git-hygiene-tests", 1), {
      done: true,
    });

    assert.deepEqual(await GitHygieneCliWrappers.runGitLabMrView($, "feature/git-hygiene-tests"), {
      webUrl: "https://gitlab.example.com/acme/repo/-/merge_requests/8",
    });
    assert.deepEqual(await GitHygieneCliWrappers.runGitLabCiStatus($, "feature/git-hygiene-tests", "0f1e2d3c4b5a"), {
      status: "success",
      sha: "0f1e2d3c4b5a",
      webUrl: "https://gitlab.example.com/acme/repo/-/pipelines/1000",
    });
    assert.deepEqual(await GitHygieneCliWrappers.runGitLabCiStatusWatch($, "feature/git-hygiene-tests"), {
      done: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
