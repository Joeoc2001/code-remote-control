import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { GitHygieneCliWrappers } from "./git-hygiene.js";

function shellQuote(value) {
  const text = String(value);
  if (text.length === 0) return "''";
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function createCommandRunner(env, cwd) {
  return (strings, ...values) => {
    let command = "";
    for (let index = 0; index < strings.length; index += 1) {
      command += strings[index];
      if (index < values.length) command += shellQuote(values[index]);
    }

    let allowFailure = false;

    const run = () =>
      new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", command], { cwd, env });
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
            reject(new Error(`Command failed: ${command}\n${result.stderr}`));
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

async function runShell(command, { cwd, env, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], { cwd, env });
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

      if (!allowFailure && code !== 0) {
        reject(new Error(`Command failed: ${command}\n${result.stderr}`));
        return;
      }

      resolve(result);
    });
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeGithubPrView(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (typeof payload.number !== "number") return null;
  if (typeof payload.url !== "string" || payload.url.length === 0) return null;
  if (typeof payload.title !== "string" || payload.title.length === 0) return null;
  if (typeof payload.state !== "string" || payload.state.length === 0) return null;
  return {
    number: payload.number,
    url: payload.url,
    title: payload.title,
    state: payload.state,
  };
}

function normalizeGithubPrChecks(payload) {
  if (!Array.isArray(payload)) return null;
  const validBuckets = new Set(["pass", "fail", "pending", "cancel", "skipping"]);
  const checks = [];
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (typeof item.bucket !== "string" || !validBuckets.has(item.bucket)) return null;
    if (typeof item.name !== "string" || item.name.length === 0) return null;
    if (typeof item.state !== "string" || item.state.length === 0) return null;
    if (typeof item.link !== "string" || item.link.length === 0) return null;
    checks.push({
      bucket: item.bucket,
      name: item.name,
      state: item.state,
      link: item.link,
    });
  }
  return checks;
}

function normalizeGitLabMergeRequest(payload) {
  const candidate = Array.isArray(payload) ? payload[0] : payload;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  if (typeof candidate.web_url !== "string" || candidate.web_url.length === 0) return null;
  return {
    webUrl: candidate.web_url,
  };
}

function normalizeGitLabPipeline(payload) {
  const pick = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (typeof value.status !== "string" || value.status.length === 0) return null;
    if (typeof value.sha !== "string" || value.sha.length === 0) return null;
    const webUrl = typeof value.web_url === "string" ? value.web_url : undefined;
    return {
      status: value.status,
      sha: value.sha,
      webUrl,
    };
  };

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const parsed = pick(item);
      if (parsed) return parsed;
    }
    return null;
  }

  const direct = pick(payload);
  if (direct) return direct;

  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.pipelines)) {
      for (const item of payload.pipelines) {
        const parsed = pick(item);
        if (parsed) return parsed;
      }
    }
    if (payload.pipeline) return pick(payload.pipeline);
  }

  return null;
}

test("git wrappers match local git CLI behavior", async () => {
  const cwd = process.cwd();
  const env = { ...process.env };
  const $ = createCommandRunner(env, cwd);

  const inside = (await runShell("git rev-parse --is-inside-work-tree", { cwd, env })).stdout.trim();
  assert.deepEqual(await GitHygieneCliWrappers.runGitRevParseInsideWorktree($), inside === "true" ? { isInsideWorkTree: true } : null);

  const porcelain = (await runShell("git status --porcelain", { cwd, env })).stdout;
  assert.deepEqual(await GitHygieneCliWrappers.runGitStatusPorcelain($), {
    hasUncommittedChanges: porcelain.trim().length > 0,
  });

  const upstreamRaw = (await runShell("git rev-parse --abbrev-ref --symbolic-full-name @{upstream}", {
    cwd,
    env,
    allowFailure: true,
  })).stdout.trim();
  const upstream = upstreamRaw.length > 0 ? upstreamRaw : null;
  assert.deepEqual(await GitHygieneCliWrappers.runGitUpstreamRef($), { upstream });

  if (upstream) {
    const aheadRaw = (await runShell(`git rev-list --count ${shellQuote(upstream)}..HEAD`, { cwd, env })).stdout.trim();
    assert.deepEqual(await GitHygieneCliWrappers.runGitAheadCount($, upstream), {
      count: Number.parseInt(aheadRaw, 10),
    });
  }

  const unpushedRaw = (await runShell("git log --not --remotes --max-count=1 --format=%H HEAD", {
    cwd,
    env,
    allowFailure: true,
  })).stdout;
  assert.deepEqual(await GitHygieneCliWrappers.runGitUnpushedFromHead($), {
    hasUnpushedCommits: unpushedRaw.trim().length > 0,
  });

  const branchRaw = (await runShell("git rev-parse --abbrev-ref HEAD", { cwd, env, allowFailure: true })).stdout.trim();
  assert.deepEqual(await GitHygieneCliWrappers.runGitCurrentBranch($), branchRaw.length > 0 ? { branch: branchRaw } : null);

  const headRaw = (await runShell("git rev-parse HEAD", { cwd, env, allowFailure: true })).stdout.trim();
  assert.deepEqual(await GitHygieneCliWrappers.runGitHeadSha($), headRaw.length > 0 ? { headSha: headRaw } : null);
});

test("github wrappers match local gh CLI behavior", async (t) => {
  const cwd = process.cwd();
  const env = { ...process.env };
  const hasGh = (await runShell("command -v gh", { cwd, env, allowFailure: true })).code === 0;
  if (!hasGh) {
    t.skip("gh CLI not installed");
    return;
  }

  const $ = createCommandRunner(env, cwd);
  const branch = (await runShell("git rev-parse --abbrev-ref HEAD", { cwd, env })).stdout.trim();

  const prViewRaw = await runShell(`gh pr view ${shellQuote(branch)} --json number,url,title,state`, {
    cwd,
    env,
    allowFailure: true,
  });
  assert.deepEqual(await GitHygieneCliWrappers.runGithubPrView($, branch), normalizeGithubPrView(parseJson(prViewRaw.stdout)));

  const checksRaw = await runShell(`gh pr checks ${shellQuote(branch)} --json bucket,name,state,link`, {
    cwd,
    env,
    allowFailure: true,
  });
  assert.deepEqual(await GitHygieneCliWrappers.runGithubPrChecks($, branch), normalizeGithubPrChecks(parseJson(checksRaw.stdout)));

  assert.deepEqual(await GitHygieneCliWrappers.runGithubPrChecksWatch($, "__opencode_missing_branch__", 1), {
    done: true,
  });
});

test("gitlab wrappers match local glab CLI behavior", async (t) => {
  const cwd = process.cwd();
  const env = { ...process.env };
  const hasGlab = (await runShell("command -v glab", { cwd, env, allowFailure: true })).code === 0;
  if (!hasGlab) {
    t.skip("glab CLI not installed");
    return;
  }

  const $ = createCommandRunner(env, cwd);
  const branch = (await runShell("git rev-parse --abbrev-ref HEAD", { cwd, env })).stdout.trim();
  const head = (await runShell("git rev-parse HEAD", { cwd, env })).stdout.trim();
  const encodedBranch = encodeURIComponent(branch);
  const encodedHead = encodeURIComponent(head);

  const mrRaw = await runShell(
    `glab api projects/:id/merge_requests?state=opened\&source_branch=${shellQuote(encodedBranch)}\&per_page=1`,
    { cwd, env, allowFailure: true },
  );
  assert.deepEqual(await GitHygieneCliWrappers.runGitLabMrView($, branch), normalizeGitLabMergeRequest(parseJson(mrRaw.stdout)));

  const pipelineRaw = await runShell(
    `glab api projects/:id/pipelines?ref=${shellQuote(encodedBranch)}\&sha=${shellQuote(encodedHead)}\&per_page=1`,
    { cwd, env, allowFailure: true },
  );
  assert.deepEqual(
    await GitHygieneCliWrappers.runGitLabCiStatus($, branch, head),
    normalizeGitLabPipeline(parseJson(pipelineRaw.stdout)),
  );

  assert.deepEqual(await GitHygieneCliWrappers.runGitLabCiStatusWatch($, "__opencode_missing_branch__"), {
    done: true,
  });
});
