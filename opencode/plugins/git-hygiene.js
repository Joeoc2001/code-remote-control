const reminderFingerprintBySession = new Map();
const pipelineWatchInFlightBySession = new Map();
const watchedHeadBySession = new Map();
const messageCounterBySession = new Map();

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
    return payload.find((item) => item && typeof item === "object" && typeof item.status === "string") || null;
  }

  if (typeof payload !== "object") return null;
  if (typeof payload.status === "string") return payload;

  if (Array.isArray(payload.pipelines)) {
    return payload.pipelines.find((item) => item && typeof item === "object" && typeof item.status === "string") || null;
  }

  if (payload.pipeline && typeof payload.pipeline === "object" && typeof payload.pipeline.status === "string") {
    return payload.pipeline;
  }

  return null;
}

async function maybeWatchGithubPipeline({ client, $, sessionID, branch, headSha }) {
  const prRaw = await $`gh pr view ${branch} --json number,url,title,state`.nothrow().text();
  const pr = tryParseJson(prRaw);
  if (!pr || pr.state !== "OPEN") return false;

  const checksRaw = await $`gh pr checks ${branch} --json bucket,name,state,link`.nothrow().text();
  const checks = tryParseJson(checksRaw);
  if (!Array.isArray(checks) || checks.length === 0) return false;

  await sendSessionPrompt(
    client,
    sessionID,
    `All local changes are committed and pushed. Waiting for PR checks to finish for ${pr.url}.`,
    true,
  );

  const messageCounterAtWatchStart = getMessageCounter(sessionID);

  await $`gh pr checks ${branch} --watch --interval 10`.nothrow();

  const finalChecksRaw = await $`gh pr checks ${branch} --json bucket,name,state,link`.nothrow().text();
  const finalChecks = tryParseJson(finalChecksRaw);
  if (!Array.isArray(finalChecks) || finalChecks.length === 0) return false;

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
  const mrRaw = await $`glab mr view ${branch} -F json`.nothrow().text();
  const mr = tryParseJson(mrRaw);
  if (!mr || !mr.web_url) return false;

  const pipelineRaw = await $`glab ci status --branch ${branch} -F json`.nothrow().text();
  const pipeline = pickGitLabPipeline(tryParseJson(pipelineRaw));
  if (!pipeline || pipeline.sha !== headSha) return false;

  await sendSessionPrompt(
    client,
    sessionID,
    `All local changes are committed and pushed. Waiting for MR pipeline to finish for ${mr.web_url}.`,
    true,
  );

  const messageCounterAtWatchStart = getMessageCounter(sessionID);

  await $`glab ci status --branch ${branch} --live`.nothrow();

  const finalPipelineRaw = await $`glab ci status --branch ${branch} -F json`.nothrow().text();
  const finalPipeline = pickGitLabPipeline(tryParseJson(finalPipelineRaw));
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
      ? `MR pipeline finished successfully for ${mr.web_url} (status: ${status}). Session compacted because no new messages were sent while CI was running.`
      : `MR pipeline finished successfully for ${mr.web_url} (status: ${status}). Skipped compaction because new messages were sent while CI was running.`
    : `MR pipeline finished with status '${status}' for ${mr.web_url}. Please investigate the pipeline failure, fix the issues, then commit and push the changes.`;

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
  const insideWorktree = (await $`git rev-parse --is-inside-work-tree`.nothrow().text()).trim();
  if (insideWorktree !== "true") return null;

  const uncommittedOutput = await $`git status --porcelain`.text();
  const hasUncommittedChanges = uncommittedOutput.trim().length > 0;

  const upstreamOutput = await $`git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`.nothrow().text();
  const upstream = upstreamOutput.trim();
  let hasUnpushedCommits = false;
  let aheadCount = 0;

  if (upstream.length > 0) {
    const aheadOutput = await $`git rev-list --count ${upstream}..HEAD`.text();
    aheadCount = Number.parseInt(aheadOutput.trim(), 10) || 0;
    hasUnpushedCommits = aheadCount > 0;
  } else {
    const unpushedAnywhere = await $`git log --branches --not --remotes --max-count=1 --format=%H`.nothrow().text();
    hasUnpushedCommits = unpushedAnywhere.trim().length > 0;
  }

  const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
  const headSha = (await $`git rev-parse HEAD`.text()).trim();

  return {
    hasUncommittedChanges,
    hasUnpushedCommits,
    upstream,
    aheadCount,
    branch,
    headSha,
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
