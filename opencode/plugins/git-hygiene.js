const reminderFingerprintBySession = new Map();
const pipelineWatchInFlightBySession = new Map();
const watchedHeadBySession = new Map();
const messageCounterBySession = new Map();

const githubCheckBuckets = new Set(["pass", "fail", "pending", "cancel", "skipping"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseString(value) {
  return typeof value === "string" ? value : null;
}

function parseNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseGithubPrView(payload) {
  if (!isRecord(payload)) return null;

  const number = parseNumber(payload.number);
  const url = parseString(payload.url);
  const title = parseString(payload.title);
  const state = parseString(payload.state);
  if (number === null || !url || !title || !state) return null;

  return {
    number,
    url,
    title,
    state,
  };
}

function parseGithubPrCheck(payload) {
  if (!isRecord(payload)) return null;

  const bucket = parseString(payload.bucket);
  const name = parseString(payload.name);
  const state = parseString(payload.state);
  const link = parseString(payload.link);
  if (!bucket || !githubCheckBuckets.has(bucket) || !name || !state || !link) return null;

  return {
    bucket,
    name,
    state,
    link,
  };
}

function parseGithubPrChecks(payload) {
  if (!Array.isArray(payload)) return null;

  const checks = [];
  for (const item of payload) {
    const parsed = parseGithubPrCheck(item);
    if (!parsed) return null;
    checks.push(parsed);
  }

  return checks;
}

function parseGitLabMergeRequest(payload) {
  if (!isRecord(payload)) return null;

  const webUrl = parseString(payload.web_url);
  if (!webUrl) return null;

  return {
    webUrl,
  };
}

function parseGitLabPipeline(payload) {
  if (!isRecord(payload)) return null;

  const status = parseString(payload.status);
  const sha = parseString(payload.sha);
  const webUrl = parseString(payload.web_url);
  if (!status || !sha) return null;

  return {
    status,
    sha,
    webUrl,
  };
}

function parseGitLabMergeRequestPayload(payload) {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const mr = parseGitLabMergeRequest(item);
      if (mr) return mr;
    }
    return null;
  }

  return parseGitLabMergeRequest(payload);
}

function parseGitWorktreeFlag(output) {
  const value = output.trim();
  if (value === "true") return { isInsideWorkTree: true };
  if (value === "false") return { isInsideWorkTree: false };
  return null;
}

function parseGitUpstream(output) {
  const value = output.trim();
  return {
    upstream: value.length > 0 ? value : null,
  };
}

function parseGitCount(output) {
  const value = Number.parseInt(output.trim(), 10);
  if (!Number.isFinite(value) || value < 0) return null;

  return {
    count: value,
  };
}

function parseGitRef(output) {
  const value = output.trim();
  if (value.length === 0) return null;

  return {
    value,
  };
}

async function runGithubPrView($, branch) {
  const raw = await $`gh pr view ${branch} --json number,url,title,state`.nothrow().text();
  return parseGithubPrView(tryParseJson(raw));
}

async function runGithubPrChecks($, branch) {
  const raw = await $`gh pr checks ${branch} --json bucket,name,state,link`.nothrow().text();
  return parseGithubPrChecks(tryParseJson(raw));
}

async function runGithubPrChecksWatch($, branch, intervalSeconds) {
  await $`gh pr checks ${branch} --watch --interval ${intervalSeconds}`.nothrow();
  return {
    done: true,
  };
}

async function runGitLabMrView($, branch) {
  const encodedBranch = encodeURIComponent(branch);
  const raw = await $`glab api projects/:id/merge_requests?state=opened&source_branch=${encodedBranch}&per_page=1`.nothrow().text();
  return parseGitLabMergeRequestPayload(tryParseJson(raw));
}

async function runGitLabCiStatus($, branch, headSha) {
  const encodedBranch = encodeURIComponent(branch);
  const encodedSha = encodeURIComponent(headSha);
  const raw = await $`glab api projects/:id/pipelines?ref=${encodedBranch}&sha=${encodedSha}&per_page=1`.nothrow().text();
  return parseGitLabPipelinePayload(tryParseJson(raw));
}

async function runGitLabCiStatusWatch($, branch) {
  await $`glab ci status --branch ${branch} --live`.nothrow();
  return {
    done: true,
  };
}

async function runGitRevParseInsideWorktree($) {
  const raw = await $`git rev-parse --is-inside-work-tree`.nothrow().text();
  return parseGitWorktreeFlag(raw);
}

async function runGitStatusPorcelain($) {
  const raw = await $`git status --porcelain`.text();
  return {
    hasUncommittedChanges: raw.trim().length > 0,
  };
}

async function runGitUpstreamRef($) {
  const raw = await $`git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`.nothrow().text();
  return parseGitUpstream(raw);
}

async function runGitAheadCount($, upstream) {
  const raw = await $`git rev-list --count ${upstream}..HEAD`.text();
  return parseGitCount(raw);
}

async function runGitUnpushedFromHead($) {
  const raw = await $`git log --not --remotes --max-count=1 --format=%H HEAD`.nothrow().text();
  return {
    hasUnpushedCommits: raw.trim().length > 0,
  };
}

async function runGitCurrentBranch($) {
  const raw = await $`git rev-parse --abbrev-ref HEAD`.nothrow().text();
  const parsed = parseGitRef(raw);
  if (!parsed) return null;

  return {
    branch: parsed.value,
  };
}

async function runGitHeadSha($) {
  const raw = await $`git rev-parse HEAD`.nothrow().text();
  const parsed = parseGitRef(raw);
  if (!parsed) return null;

  return {
    headSha: parsed.value,
  };
}

async function sendSessionPrompt(client, sessionID, text, noReply) {
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      noReply,
      parts: [{ type: "text", text }],
    },
  });
}

function getEventSessionID(event) {
  const properties = event?.properties;
  if (!properties || typeof properties !== "object") return null;
  if (typeof properties.sessionID === "string" && properties.sessionID.length > 0) return properties.sessionID;
  if (typeof properties.sessionId === "string" && properties.sessionId.length > 0) return properties.sessionId;
  return null;
}

function getMessageCounter(sessionID) {
  return messageCounterBySession.get(sessionID) || 0;
}

function bumpMessageCounter(sessionID) {
  messageCounterBySession.set(sessionID, getMessageCounter(sessionID) + 1);
}

function getGithubChecksSummary(checks) {
  const summary = {
    pass: 0,
    fail: 0,
    pending: 0,
    cancel: 0,
    skipping: 0,
  };

  for (const check of checks) {
    const bucket = check?.bucket;
    if (bucket in summary) {
      summary[bucket] += 1;
    }
  }

  const successful = summary.fail === 0 && summary.cancel === 0 && summary.pending === 0;
  return { summary, successful };
}

function getGitLabPipelineSummary(pipeline) {
  const status = pipeline?.status || "unknown";
  const successful = status === "success" || status === "passed";
  return { status, successful };
}

function pickGitLabPipeline(payload) {
  if (!payload) return null;

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const pipeline = parseGitLabPipeline(item);
      if (pipeline) return pipeline;
    }
    return null;
  }

  if (!isRecord(payload)) return null;

  const direct = parseGitLabPipeline(payload);
  if (direct) return direct;

  if (Array.isArray(payload.pipelines)) {
    for (const item of payload.pipelines) {
      const pipeline = parseGitLabPipeline(item);
      if (pipeline) return pipeline;
    }
    return null;
  }

  if (payload.pipeline) {
    return parseGitLabPipeline(payload.pipeline);
  }

  return null;
}

function parseGitLabPipelinePayload(payload) {
  return pickGitLabPipeline(payload);
}

async function maybeWatchGithubPipeline({ client, $, sessionID, branch, headSha }) {
  const pr = await runGithubPrView($, branch);
  if (!pr || pr.state !== "OPEN") return false;

  const checks = await runGithubPrChecks($, branch);
  if (!checks || checks.length === 0) return false;

  await sendSessionPrompt(
    client,
    sessionID,
    `All local changes are committed and pushed. Waiting for PR checks to finish for ${pr.url}.`,
    true,
  );

  const messageCounterAtWatchStart = getMessageCounter(sessionID);

  await runGithubPrChecksWatch($, branch, 10);

  const finalChecks = await runGithubPrChecks($, branch);
  if (!finalChecks || finalChecks.length === 0) return false;

  const { summary, successful } = getGithubChecksSummary(finalChecks);

  let compacted = false;
  if (successful && getMessageCounter(sessionID) === messageCounterAtWatchStart) {
    await client.session.summarize({
      path: { id: sessionID },
      body: {},
    });
    compacted = true;
  }

  const finalMessage = successful
    ? compacted
      ? `PR checks finished successfully for ${pr.url} (pass: ${summary.pass}, skipped: ${summary.skipping}). Session compacted because no new messages were sent while CI was running.`
      : `PR checks finished successfully for ${pr.url} (pass: ${summary.pass}, skipped: ${summary.skipping}). Skipped compaction because new messages were sent while CI was running.`
    : `PR checks finished with failures for ${pr.url} (fail: ${summary.fail}, cancel: ${summary.cancel}, pending: ${summary.pending}). Please investigate the failing checks, fix the issues, then commit and push the changes.`;

  await sendSessionPrompt(client, sessionID, finalMessage, successful);
  watchedHeadBySession.set(sessionID, headSha);
  return true;
}

async function maybeWatchGitLabPipeline({ client, $, sessionID, branch, headSha }) {
  const mr = await runGitLabMrView($, branch);
  if (!mr) return false;

  const pipeline = await runGitLabCiStatus($, branch, headSha);
  if (!pipeline || pipeline.sha !== headSha) return false;

  await sendSessionPrompt(
    client,
    sessionID,
    `All local changes are committed and pushed. Waiting for MR pipeline to finish for ${mr.webUrl}.`,
    true,
  );

  const messageCounterAtWatchStart = getMessageCounter(sessionID);

  await runGitLabCiStatusWatch($, branch);

  const finalPipeline = await runGitLabCiStatus($, branch, headSha);
  if (!finalPipeline) return false;

  const { status, successful } = getGitLabPipelineSummary(finalPipeline);

  let compacted = false;
  if (successful && getMessageCounter(sessionID) === messageCounterAtWatchStart) {
    await client.session.summarize({
      path: { id: sessionID },
      body: {},
    });
    compacted = true;
  }

  const finalMessage = successful
    ? compacted
      ? `MR pipeline finished successfully for ${mr.webUrl} (status: ${status}). Session compacted because no new messages were sent while CI was running.`
      : `MR pipeline finished successfully for ${mr.webUrl} (status: ${status}). Skipped compaction because new messages were sent while CI was running.`
    : `MR pipeline finished with status '${status}' for ${mr.webUrl}. Please investigate the pipeline failure, fix the issues, then commit and push the changes.`;

  await sendSessionPrompt(client, sessionID, finalMessage, successful);
  watchedHeadBySession.set(sessionID, headSha);
  return true;
}

async function watchAssociatedPipeline({ client, $, sessionID, branch, headSha }) {
  if (branch === "HEAD") return;

  const watchedHead = watchedHeadBySession.get(sessionID);
  if (watchedHead === headSha) return;

  const githubWatched = await maybeWatchGithubPipeline({ client, $, sessionID, branch, headSha });
  if (githubWatched) return;

  await maybeWatchGitLabPipeline({ client, $, sessionID, branch, headSha });
}

async function getGitState($) {
  const worktree = await runGitRevParseInsideWorktree($);
  if (!worktree || !worktree.isInsideWorkTree) return null;

  const uncommitted = await runGitStatusPorcelain($);
  const hasUncommittedChanges = uncommitted.hasUncommittedChanges;

  const upstreamRef = await runGitUpstreamRef($);
  const upstream = upstreamRef.upstream || "";
  let hasUnpushedCommits = false;
  let aheadCount = 0;

  if (upstream.length > 0) {
    const ahead = await runGitAheadCount($, upstream);
    if (!ahead) return null;
    aheadCount = ahead.count;
    hasUnpushedCommits = aheadCount > 0;
  } else {
    const unpushed = await runGitUnpushedFromHead($);
    hasUnpushedCommits = unpushed.hasUnpushedCommits;
  }

  const branchRef = await runGitCurrentBranch($);
  const head = await runGitHeadSha($);
  if (!branchRef || !head) return null;

  return {
    hasUncommittedChanges,
    hasUnpushedCommits,
    upstream,
    aheadCount,
    branch: branchRef.branch,
    headSha: head.headSha,
  };
}

export const GitHygienePlugin = async ({ client, $ }) => {
  return {
    event: async ({ event }) => {
      const sessionID = getEventSessionID(event);
      if (sessionID && event.type.startsWith("message.")) {
        bumpMessageCounter(sessionID);
      }

      if (event.type !== "session.idle") return;
      if (!sessionID) return;

      const gitState = await getGitState($);
      if (!gitState) return;

      if (!gitState.hasUncommittedChanges && !gitState.hasUnpushedCommits) {
        reminderFingerprintBySession.delete(sessionID);

        if (!pipelineWatchInFlightBySession.has(sessionID)) {
          const watchPromise = watchAssociatedPipeline({
            client,
            $,
            sessionID,
            branch: gitState.branch,
            headSha: gitState.headSha,
          })
            .catch(() => { })
            .finally(() => {
              pipelineWatchInFlightBySession.delete(sessionID);
            });

          pipelineWatchInFlightBySession.set(sessionID, watchPromise);
        }

        return;
      }

      const fingerprint = `${gitState.hasUncommittedChanges}:${gitState.hasUnpushedCommits}:${gitState.upstream}:${gitState.aheadCount}`;
      if (reminderFingerprintBySession.get(sessionID) === fingerprint) return;

      reminderFingerprintBySession.set(sessionID, fingerprint);

      const reminder = gitState.hasUncommittedChanges && gitState.hasUnpushedCommits
        ? "You have uncommitted and unpushed local changes; commit your outstanding workspace changes, push your local commits to remote, then open a PR or MR."
        : gitState.hasUncommittedChanges
          ? "You have uncommitted local changes; commit your outstanding workspace changes, then push to remote and open a PR or MR."
          : "You have unpushed local commits; push your local commits to remote, then open a PR or MR.";

      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: false,
          parts: [{ type: "text", text: reminder }],
        },
      });
    },
  };
};

export const GitHygieneCliWrappers = Object.freeze({
  runGithubPrView,
  runGithubPrChecks,
  runGithubPrChecksWatch,
  runGitLabMrView,
  runGitLabCiStatus,
  runGitLabCiStatusWatch,
  runGitRevParseInsideWorktree,
  runGitStatusPorcelain,
  runGitUpstreamRef,
  runGitAheadCount,
  runGitUnpushedFromHead,
  runGitCurrentBranch,
  runGitHeadSha,
});
