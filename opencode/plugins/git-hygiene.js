const reminderFingerprintBySession = new Map();
const pipelineWatchInFlightBySession = new Map();
const watchedHeadBySession = new Map();
const messageCounterBySession = new Map();

const pipelinePollIntervalMs = 10_000;
const autoCompactionEnabled = process.env.OPENCODE_GIT_HYGIENE_AUTO_COMPACT === "1";

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

function parseModelSpecifier(value) {
  if (!value) return null;

  const delimiterIndex = value.indexOf("/");
  if (delimiterIndex <= 0 || delimiterIndex >= value.length - 1) return null;

  return {
    providerID: value.slice(0, delimiterIndex),
    modelID: value.slice(delimiterIndex + 1),
  };
}

function unwrapClientData(payload) {
  if (!isRecord(payload)) return payload;
  if (!("data" in payload)) return payload;
  return payload.data;
}

function parseBooleanResult(payload) {
  if (typeof payload === "boolean") return payload;
  if (!isRecord(payload)) return false;
  if (typeof payload.data === "boolean") return payload.data;
  return false;
}

async function resolveCompactionModel(client) {
  const configRaw = await client.config.get();
  const config = unwrapClientData(configRaw);

  if (isRecord(config)) {
    const modelSpecifier = parseString(config.model);
    const parsedSpecifier = parseModelSpecifier(modelSpecifier);
    if (parsedSpecifier) return parsedSpecifier;

    const providerID = parseString(config.providerID) || parseString(config.providerId);
    const modelID = parseString(config.modelID) || parseString(config.modelId);
    if (providerID && modelID) {
      return {
        providerID,
        modelID,
      };
    }
  }

  const providersRaw = await client.config.providers();
  const providers = unwrapClientData(providersRaw);
  if (!isRecord(providers) || !isRecord(providers.default)) return null;

  for (const [providerID, modelIDValue] of Object.entries(providers.default)) {
    const modelID = parseString(modelIDValue);
    if (providerID.length > 0 && modelID) {
      return {
        providerID,
        modelID,
      };
    }
  }

  return null;
}

async function compactSession(client, sessionID) {
  const compactionModel = await resolveCompactionModel(client);
  if (!compactionModel) return false;

  const summarizeResult = await client.session.summarize({
    path: { id: sessionID },
    body: compactionModel,
  });

  return parseBooleanResult(summarizeResult);
}

async function runGithubPrView($, branch) {
  const raw = await $`gh pr view ${branch} --json number,url,title,state`.nothrow().text();
  return parseGithubPrView(tryParseJson(raw));
}

async function runGithubPrChecks($, branch) {
  const raw = await $`gh pr checks ${branch} --json bucket,name,state,link`.nothrow().text();
  return parseGithubPrChecks(tryParseJson(raw));
}

async function runGitLabMrView($, branch) {
  const encodedBranch = encodeURIComponent(branch);
  const mergeRequestsPath = `projects/:id/merge_requests?state=opened&source_branch=${encodedBranch}&per_page=1`;
  const raw = await $`glab api ${mergeRequestsPath}`.nothrow().text();
  return parseGitLabMergeRequestPayload(tryParseJson(raw));
}

async function runGitLabCiStatus($, branch, headSha) {
  const encodedBranch = encodeURIComponent(branch);
  const encodedSha = encodeURIComponent(headSha);
  const pipelinesPath = `projects/:id/pipelines?ref=${encodedBranch}&sha=${encodedSha}&per_page=1`;
  const raw = await $`glab api ${pipelinesPath}`.nothrow().text();
  return parseGitLabPipelinePayload(tryParseJson(raw));
}

async function runGitRevParseInsideWorktree($) {
  const raw = await $`git rev-parse --is-inside-work-tree`.nothrow().text();
  return parseGitWorktreeFlag(raw);
}

async function runGitStatusPorcelain($) {
  const raw = await $`git status --porcelain`.nothrow().text();
  return {
    hasUncommittedChanges: raw.trim().length > 0,
  };
}

async function runGitUpstreamRef($) {
  const raw = await $`git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`.nothrow().text();
  return parseGitUpstream(raw);
}

async function runGitAheadCount($, upstream) {
  const revisionRange = `${upstream}..HEAD`;
  const raw = await $`git rev-list --count ${revisionRange}`.nothrow().text();
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

function createPipelineWatchState(headSha) {
  let resolveCancelled;
  const cancelledPromise = new Promise((resolve) => {
    resolveCancelled = resolve;
  });

  let cancelled = false;

  return {
    headSha,
    cancelledPromise,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      resolveCancelled();
    },
    isCancelled() {
      return cancelled;
    },
  };
}

async function waitForNextPoll(state, intervalMs = pipelinePollIntervalMs) {
  if (state.isCancelled()) return false;

  await Promise.race([
    new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    }),
    state.cancelledPromise,
  ]);

  return !state.isCancelled();
}

function isUserMessageEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (event.type === "message.user") return true;
  if (typeof event.type !== "string" || !event.type.startsWith("message.")) return false;

  const properties = event.properties;
  if (!isRecord(properties)) return false;

  const role = parseString(properties.role)
    || parseString(properties.messageRole)
    || parseString(properties.authorRole)
    || parseString(properties.senderRole)
    || parseString(properties.actorRole);
  if (role) return role.toLowerCase() === "user";

  const source = parseString(properties.source)
    || parseString(properties.sender)
    || parseString(properties.origin)
    || parseString(properties.actor);
  if (source) return source.toLowerCase() === "user";

  return false;
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

function isGitLabPipelineTerminalStatus(status) {
  return status === "success"
    || status === "passed"
    || status === "failed"
    || status === "canceled"
    || status === "cancelled"
    || status === "skipped"
    || status === "manual";
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

async function maybeWatchGithubPipeline({ client, $, sessionID, branch, headSha, watchState }) {
  if (watchState.isCancelled()) return true;

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

  let finalChecks = checks;
  while (true) {
    if (watchState.isCancelled()) return true;

    const latestChecks = await runGithubPrChecks($, branch);
    if (latestChecks && latestChecks.length > 0) {
      finalChecks = latestChecks;
      const { summary } = getGithubChecksSummary(latestChecks);
      if (summary.pending === 0) break;
    }

    const shouldContinue = await waitForNextPoll(watchState);
    if (!shouldContinue) return true;
  }

  if (watchState.isCancelled()) return true;

  if (!finalChecks || finalChecks.length === 0) {
    await sendSessionPrompt(
      client,
      sessionID,
      `I couldn't fetch final PR check results for ${pr.url} after waiting. Please run gh pr checks ${branch} manually and re-run after auth/connectivity is healthy.`,
      false,
    );
    return true;
  }

  const { summary, successful } = getGithubChecksSummary(finalChecks);

  const noNewMessages = getMessageCounter(sessionID) === messageCounterAtWatchStart;
  const shouldCompact = successful && autoCompactionEnabled && noNewMessages;
  const compacted = shouldCompact
    ? await compactSession(client, sessionID)
    : false;

  const finalMessage = successful
    ? shouldCompact
      ? compacted
        ? `PR checks finished successfully for ${pr.url} (pass: ${summary.pass}, skipped: ${summary.skipping}). Session compacted because no new messages were sent while CI was running.`
        : `PR checks finished successfully for ${pr.url} (pass: ${summary.pass}, skipped: ${summary.skipping}). Tried to compact the session, but it did not complete; run /compact manually.`
      : autoCompactionEnabled
        ? `PR checks finished successfully for ${pr.url} (pass: ${summary.pass}, skipped: ${summary.skipping}). Skipped compaction because new messages were sent while CI was running.`
        : `PR checks finished successfully for ${pr.url} (pass: ${summary.pass}, skipped: ${summary.skipping}). Auto-compaction is disabled; run /compact manually if you want to compact the session.`
    : `PR checks finished with failures for ${pr.url} (fail: ${summary.fail}, cancel: ${summary.cancel}, pending: ${summary.pending}). Please investigate the failing checks, fix the issues, then commit and push the changes.`;

  await sendSessionPrompt(client, sessionID, finalMessage, successful);
  watchedHeadBySession.set(sessionID, headSha);
  return true;
}

async function maybeWatchGitLabPipeline({ client, $, sessionID, branch, headSha, watchState }) {
  if (watchState.isCancelled()) return true;

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

  let finalPipeline = pipeline;
  while (true) {
    if (watchState.isCancelled()) return true;

    const latestPipeline = await runGitLabCiStatus($, branch, headSha);
    if (latestPipeline && latestPipeline.sha === headSha) {
      finalPipeline = latestPipeline;
      const { status } = getGitLabPipelineSummary(latestPipeline);
      if (isGitLabPipelineTerminalStatus(status)) break;
    }

    const shouldContinue = await waitForNextPoll(watchState);
    if (!shouldContinue) return true;
  }

  if (watchState.isCancelled()) return true;

  if (!finalPipeline) {
    await sendSessionPrompt(
      client,
      sessionID,
      `I couldn't fetch the final MR pipeline status for ${mr.webUrl} after waiting. Please run glab ci status --branch ${branch} and re-run after auth/connectivity is healthy.`,
      false,
    );
    return true;
  }

  const { status, successful } = getGitLabPipelineSummary(finalPipeline);

  const noNewMessages = getMessageCounter(sessionID) === messageCounterAtWatchStart;
  const shouldCompact = successful && autoCompactionEnabled && noNewMessages;
  const compacted = shouldCompact
    ? await compactSession(client, sessionID)
    : false;

  const finalMessage = successful
    ? shouldCompact
      ? compacted
        ? `MR pipeline finished successfully for ${mr.webUrl} (status: ${status}). Session compacted because no new messages were sent while CI was running.`
        : `MR pipeline finished successfully for ${mr.webUrl} (status: ${status}). Tried to compact the session, but it did not complete; run /compact manually.`
      : autoCompactionEnabled
        ? `MR pipeline finished successfully for ${mr.webUrl} (status: ${status}). Skipped compaction because new messages were sent while CI was running.`
        : `MR pipeline finished successfully for ${mr.webUrl} (status: ${status}). Auto-compaction is disabled; run /compact manually if you want to compact the session.`
    : `MR pipeline finished with status '${status}' for ${mr.webUrl}. Please investigate the pipeline failure, fix the issues, then commit and push the changes.`;

  await sendSessionPrompt(client, sessionID, finalMessage, successful);
  watchedHeadBySession.set(sessionID, headSha);
  return true;
}

async function watchAssociatedPipeline({ client, $, sessionID, branch, headSha, watchState }) {
  if (watchState.isCancelled()) return;
  if (branch === "HEAD") return;

  const watchedHead = watchedHeadBySession.get(sessionID);
  if (watchedHead === headSha) return;

  const githubWatched = await maybeWatchGithubPipeline({
    client,
    $,
    sessionID,
    branch,
    headSha,
    watchState,
  });
  if (githubWatched) return;

  await maybeWatchGitLabPipeline({
    client,
    $,
    sessionID,
    branch,
    headSha,
    watchState,
  });
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
      if (sessionID && isUserMessageEvent(event)) {
        bumpMessageCounter(sessionID);
      }

      if (event.type !== "session.idle") return;
      if (!sessionID) return;

      const gitState = await getGitState($);
      if (!gitState) return;

      if (!gitState.hasUncommittedChanges && !gitState.hasUnpushedCommits) {
        reminderFingerprintBySession.delete(sessionID);

        const existingWatch = pipelineWatchInFlightBySession.get(sessionID);
        if (existingWatch && existingWatch.headSha === gitState.headSha) {
          return;
        }

        if (existingWatch) {
          existingWatch.cancel();
        }

        const watchState = createPipelineWatchState(gitState.headSha);
        const watchPromise = watchAssociatedPipeline({
            client,
            $,
            sessionID,
            branch: gitState.branch,
            headSha: gitState.headSha,
            watchState,
          })
            .catch(() => { })
            .finally(() => {
              const currentWatch = pipelineWatchInFlightBySession.get(sessionID);
              if (currentWatch === watchState) {
                pipelineWatchInFlightBySession.delete(sessionID);
              }
            });

        pipelineWatchInFlightBySession.set(sessionID, watchState);

        return;
      }

      const existingWatch = pipelineWatchInFlightBySession.get(sessionID);
      if (existingWatch) {
        existingWatch.cancel();
        pipelineWatchInFlightBySession.delete(sessionID);
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
