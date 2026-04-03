import { Gitlab } from "@gitbeaker/rest";
import { Octokit } from "@octokit/rest";
import type { Plugin } from "@opencode-ai/plugin";
import simpleGit from "simple-git";

const reminderFingerprintBySession = new Map<string, string>();
const pipelineWatchInFlightBySession = new Map<string, Promise<void>>();
const watchedHeadBySession = new Map<string, string>();
const reviewTeamExecutedBySession = new Set<string>();

const REVIEW_SPECIALISMS = [
  {
    name: "Logic Errors",
    focus: "Reason through each piece of business logic and verify behavior matches intent.",
  },
  {
    name: "Documentation",
    focus: "Reject superfluous comments, require named constants for magic values, and enforce clear identifiers.",
  },
  {
    name: "Type Safety",
    focus: "Make invalid state unrepresentable where practical and validate data-structure choices.",
  },
  {
    name: "Best Practices",
    focus: "Check for community-accepted implementation patterns and anti-patterns.",
  },
  {
    name: "Alternate Approach",
    focus: "Evaluate whether a better top-level approach exists for the solved problem.",
  },
  {
    name: "Not Invented Here",
    focus: "Find custom logic that should be replaced by established libraries without over-adding dependencies.",
  },
  {
    name: "Dependency Bloat",
    focus: "Validate newly added dependencies are necessary and not replaceable by smaller or existing options.",
  },
  {
    name: "Code Re-use",
    focus: "Detect duplicated logic and missed opportunities to reuse existing helpers.",
  },
  {
    name: "Hacks",
    focus: "Flag brittle one-off code, test-fudging behavior, or partial implementations likely needing immediate rewrite.",
  },
  {
    name: "Testing",
    focus: "Check meaningful new logic has tests where appropriate, excluding intentionally fast-iterating UX/taste-only behavior.",
  },
] as const;

type PluginContext = Parameters<Plugin>[0];
type PluginClient = PluginContext["client"];
type SessionPromptInput = Parameters<PluginClient["session"]["prompt"]>[0];
type SessionPromptBody = SessionPromptInput["body"];

type SessionModel = {
  providerID: string;
  modelID: string;
};

type GitState = {
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  upstream: string;
  aheadCount: number;
  branch: string;
  headSha: string;
};

type GitHubReviewInfo = {
  owner: string;
  repo: string;
  pullNumber: number;
};

type GitLabReviewInfo = {
  host: string;
  projectPath: string;
  iid: number;
};

type GitHubRepoInfo = {
  owner: string;
  repo: string;
};

type GitLabProjectInfo = {
  host: string;
  projectPath: string;
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function sendSessionPrompt(client: PluginClient, sessionID: string, text: string, noReply: boolean): Promise<void> {
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      noReply,
      parts: [{ type: "text", text }],
    },
  });
}

async function getLatestSessionModel(client: PluginClient, sessionID: string): Promise<SessionModel | null> {
  if (typeof client.session?.messages !== "function") {
    return null;
  }

  const calls = [
    () => client.session.messages({ path: { id: sessionID }, query: { limit: 20 } }),
  ];

  for (const call of calls) {
    try {
      const result = await call();
      const messages = (result as { data?: unknown }).data ?? result;
      if (!Array.isArray(messages)) {
        continue;
      }

      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i] as { info?: { model?: Partial<SessionModel> } };
        const model = message.info?.model;
        if (typeof model?.providerID === "string" && typeof model?.modelID === "string") {
          return { providerID: model.providerID, modelID: model.modelID };
        }
      }
    } catch {
    }
  }

  return null;
}

async function compactSession(client: PluginClient, sessionID: string): Promise<void> {
  if (typeof client.session?.summarize !== "function") {
    throw new Error("OpenCode SDK client does not support session.summarize");
  }

  const model = await getLatestSessionModel(client, sessionID);
  if (!model) {
    throw new Error("No model available for summarize");
  }

  await client.session.summarize({
    path: { id: sessionID },
    body: { providerID: model.providerID, modelID: model.modelID },
  });
}

function buildSpecialismTaskPrompt({
  platform,
  reviewUrl,
  branch,
  headSha,
  specialismName,
  focus,
}: {
  platform: "GitHub" | "GitLab";
  reviewUrl: string;
  branch: string;
  headSha: string;
  specialismName: string;
  focus: string;
}): string {
  return [
    `CI passed for ${platform} review ${reviewUrl} on branch ${branch} at commit ${headSha}.`,
    `You are the '${specialismName}' reviewer.`,
    focus,
    "Review only. Do not modify files, do not run formatters, do not commit, do not push, and do not alter PR/MR metadata except review comments.",
    "If everything is fine for your specialism, do not leave any comment.",
    "If you find issues, leave concise actionable PR/MR comments tied to relevant lines when possible.",
  ].join("\n");
}

async function promptWithParts(client: PluginClient, sessionID: string, body: SessionPromptBody): Promise<void> {
  await client.session.prompt({ path: { id: sessionID }, body });
}

async function runReviewTeam({
  client,
  sessionID,
  platform,
  reviewUrl,
  branch,
  headSha,
}: {
  client: PluginClient;
  sessionID: string;
  platform: "GitHub" | "GitLab";
  reviewUrl: string;
  branch: string;
  headSha: string;
}): Promise<void> {
  const parts = REVIEW_SPECIALISMS.map((specialism) => ({
    type: "subtask" as const,
    description: `${specialism.name} review`,
    agent: "general",
    prompt: buildSpecialismTaskPrompt({
      platform,
      reviewUrl,
      branch,
      headSha,
      specialismName: specialism.name,
      focus: specialism.focus,
    }),
  }));

  await promptWithParts(client, sessionID, { parts });
}

function extractGitHubReviewInfo(reviewUrl: string): GitHubReviewInfo | null {
  const match = reviewUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:$|[/?#])/);
  if (!match) {
    return null;
  }

  const pullNumber = Number.parseInt(match[3], 10);
  if (!Number.isFinite(pullNumber) || pullNumber <= 0) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    pullNumber,
  };
}

function extractGitLabReviewInfo(reviewUrl: string): GitLabReviewInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(reviewUrl);
  } catch {
    return null;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const mergeRequestIndex = parts.findIndex((part) => part === "merge_requests");
  if (mergeRequestIndex < 1) {
    return null;
  }

  const iidPart = parts[mergeRequestIndex + 1];
  const iid = Number.parseInt(iidPart ?? "", 10);
  if (!Number.isFinite(iid) || iid <= 0) {
    return null;
  }

  const projectParts = parts.slice(0, mergeRequestIndex);
  if (projectParts.at(-1) === "-") {
    projectParts.pop();
  }

  if (projectParts.length === 0) {
    return null;
  }

  return {
    host: `${parsed.protocol}//${parsed.host}`,
    projectPath: projectParts.join("/"),
    iid,
  };
}

function getGitHubClient(): Octokit | null {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    return null;
  }

  return new Octokit({ auth: token });
}

function getGitLabClient(host: string): Gitlab | null {
  const token = process.env.GITLAB_TOKEN?.trim();
  if (!token) {
    return null;
  }

  return new Gitlab({ host, token });
}

function normalizeRepoPath(pathname: string): string {
  const trimmed = pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
  return trimmed.replace(/\/+$/, "");
}

function parseRemoteUrl(remoteUrl: string): { host: string; repoPath: string } | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("git@")) {
    const match = trimmed.match(/^git@([^:]+):(.+)$/);
    if (!match) {
      return null;
    }

    const host = match[1].toLowerCase();
    const repoPath = normalizeRepoPath(match[2]);
    if (!repoPath) {
      return null;
    }

    return { host, repoPath };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const host = parsed.host.toLowerCase();
  const repoPath = normalizeRepoPath(parsed.pathname);
  if (!repoPath) {
    return null;
  }

  return { host, repoPath };
}

async function getRemoteUrls(): Promise<string[]> {
  const git = simpleGit();
  const insideWorktree = await git.checkIsRepo();
  if (!insideWorktree) {
    return [];
  }

  const remotes = await git.getRemotes(true);
  const urls = remotes
    .sort((a, b) => {
      if (a.name === "origin" && b.name !== "origin") {
        return -1;
      }
      if (a.name !== "origin" && b.name === "origin") {
        return 1;
      }
      return 0;
    })
    .flatMap((remote) => {
      const refs = remote.refs ?? {};
      return [refs.push, refs.fetch].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    });

  return Array.from(new Set(urls));
}

async function getGitHubRepoInfo(): Promise<GitHubRepoInfo | null> {
  const remoteUrls = await getRemoteUrls();
  for (const remoteUrl of remoteUrls) {
    const parsed = parseRemoteUrl(remoteUrl);
    if (!parsed || parsed.host !== "github.com") {
      continue;
    }

    const parts = parsed.repoPath.split("/").filter(Boolean);
    if (parts.length !== 2) {
      continue;
    }

    return { owner: parts[0], repo: parts[1] };
  }

  return null;
}

async function getGitLabProjectInfo(): Promise<GitLabProjectInfo | null> {
  const remoteUrls = await getRemoteUrls();
  for (const remoteUrl of remoteUrls) {
    const parsed = parseRemoteUrl(remoteUrl);
    if (!parsed || parsed.host === "github.com") {
      continue;
    }

    return {
      host: `https://${parsed.host}`,
      projectPath: parsed.repoPath,
    };
  }

  return null;
}

async function hasReviewComments({ platform, reviewUrl }: { platform: "GitHub" | "GitLab"; reviewUrl: string }): Promise<boolean> {
  if (platform === "GitHub") {
    const info = extractGitHubReviewInfo(reviewUrl);
    if (!info) {
      return false;
    }

    const github = getGitHubClient();
    if (!github) {
      return false;
    }

    const [comments, reviews] = await Promise.all([
      github.issues.listComments({
        owner: info.owner,
        repo: info.repo,
        issue_number: info.pullNumber,
        per_page: 1,
      }),
      github.pulls.listReviews({
        owner: info.owner,
        repo: info.repo,
        pull_number: info.pullNumber,
        per_page: 1,
      }),
    ]);

    return comments.data.length > 0 || reviews.data.length > 0;
  }

  const info = extractGitLabReviewInfo(reviewUrl);
  if (!info) {
    return false;
  }

  const gitlab = getGitLabClient(info.host);
  if (!gitlab) {
    return false;
  }

  const mergeRequest = await gitlab.MergeRequests.show(info.projectPath, info.iid) as { user_notes_count?: number };
  const notes = typeof mergeRequest.user_notes_count === "number" ? mergeRequest.user_notes_count : 0;
  return notes > 0;
}

async function handleSuccessfulPipeline({
  client,
  sessionID,
  platform,
  reviewUrl,
  branch,
  headSha,
}: {
  client: PluginClient;
  sessionID: string;
  platform: "GitHub" | "GitLab";
  reviewUrl: string;
  branch: string;
  headSha: string;
}): Promise<void> {
  await compactSession(client, sessionID);

  if (reviewTeamExecutedBySession.has(sessionID)) {
    return;
  }

  reviewTeamExecutedBySession.add(sessionID);

  await runReviewTeam({
    client,
    sessionID,
    platform,
    reviewUrl,
    branch,
    headSha,
  });

  const reviewHasComments = await hasReviewComments({ platform, reviewUrl });
  if (!reviewHasComments) {
    return;
  }

  await sendSessionPrompt(
    client,
    sessionID,
    `There are review comments on ${reviewUrl}. Review them now. You may skip duplicate comments or comments you disagree with, then address the rest and close all comments.`,
    false,
  );
}

function getGithubChecksSummary(checks: Array<{ bucket?: string }>): { summary: Record<string, number>; successful: boolean } {
  const summary = {
    pass: 0,
    fail: 0,
    pending: 0,
    cancel: 0,
    skipping: 0,
  };

  for (const check of checks) {
    const bucket = check.bucket;
    if (bucket && bucket in summary) {
      summary[bucket as keyof typeof summary] += 1;
    }
  }

  const successful = summary.fail === 0 && summary.cancel === 0 && summary.pending === 0;
  return { summary, successful };
}

function getGitLabPipelineSummary(pipeline: { status?: string } | null): { status: string; successful: boolean } {
  const status = pipeline?.status ?? "unknown";
  const successful = status === "success" || status === "passed";
  return { status, successful };
}

async function maybeWatchGithubPipeline({
  client,
  sessionID,
  branch,
  headSha,
}: {
  client: PluginClient;
  sessionID: string;
  branch: string;
  headSha: string;
}): Promise<boolean> {
  const github = getGitHubClient();
  const repoInfo = await getGitHubRepoInfo();
  if (!github || !repoInfo) {
    return false;
  }

  let pulls = await github.pulls.list({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    state: "open",
    head: `${repoInfo.owner}:${branch}`,
    per_page: 20,
  });

  if (pulls.data.length === 0) {
    pulls = await github.pulls.list({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      state: "open",
      per_page: 100,
    });
  }

  const pr = pulls.data.find((pull) => pull.state === "open" && pull.head?.ref === branch);
  if (!pr?.html_url) {
    return false;
  }

  const toBucket = (state: string, conclusion?: string): string => {
    if (state !== "completed") {
      return "pending";
    }
    if (conclusion === "skipped") {
      return "skipping";
    }
    if (conclusion === "cancelled") {
      return "cancel";
    }
    if (conclusion === "success" || conclusion === "neutral") {
      return "pass";
    }
    return "fail";
  };

  const toStatusBucket = (state: string): string => {
    if (state === "pending") {
      return "pending";
    }
    if (state === "success") {
      return "pass";
    }
    return "fail";
  };

  const loadChecks = async (): Promise<Array<{ bucket?: string }>> => {
    const [checkRuns, statuses] = await Promise.all([
      github.paginate(github.checks.listForRef, {
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        ref: headSha,
        per_page: 100,
      }),
      github.paginate(github.repos.listCommitStatusesForRef, {
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        ref: headSha,
        per_page: 100,
      }),
    ]);

    const checkBuckets = checkRuns.map((checkRun) => ({
      bucket: toBucket(checkRun.status, checkRun.conclusion ?? undefined),
    }));

    const statusBuckets = statuses.map((status) => ({
      bucket: toStatusBucket(status.state),
    }));

    return [...checkBuckets, ...statusBuckets];
  };

  const checks = await loadChecks();
  if (checks.length === 0) {
    return false;
  }

  await sendSessionPrompt(
    client,
    sessionID,
    `All local changes are committed and pushed. Waiting for PR checks to finish for ${pr.html_url}.`,
    true,
  );

  let finalChecks = checks;
  while (true) {
    const currentChecks = await loadChecks();
    if (currentChecks.length === 0) {
      return false;
    }

    finalChecks = currentChecks;
    const { summary } = getGithubChecksSummary(currentChecks);
    if (summary.pending === 0) {
      break;
    }

    await sleep(10_000);
  }

  const { summary, successful } = getGithubChecksSummary(finalChecks);
  if (successful) {
    await handleSuccessfulPipeline({
      client,
      sessionID,
      platform: "GitHub",
      reviewUrl: pr.html_url,
      branch,
      headSha,
    });
  }

  const finalMessage = successful
    ? `PR checks finished successfully for ${pr.html_url} (pass: ${summary.pass}, skipped: ${summary.skipping}).`
    : `PR checks finished with failures for ${pr.html_url} (fail: ${summary.fail}, cancel: ${summary.cancel}, pending: ${summary.pending}). Please investigate the failing checks, fix the issues, then commit and push the changes.`;

  await sendSessionPrompt(client, sessionID, finalMessage, successful);
  watchedHeadBySession.set(sessionID, headSha);
  return true;
}

function isGitLabPipelineRunning(status: string): boolean {
  return ["created", "waiting_for_resource", "preparing", "pending", "running", "manual", "scheduled"].includes(status);
}

async function findOpenGitLabMergeRequest({
  gitlab,
  projectPath,
  branch,
}: {
  gitlab: Gitlab;
  projectPath: string;
  branch: string;
}): Promise<{ webUrl: string; iid: number } | null> {
  const all = await gitlab.MergeRequests.all({
    projectId: projectPath,
    state: "opened",
    sourceBranch: branch,
    perPage: 20,
  }) as unknown;

  if (!Array.isArray(all)) {
    return null;
  }

  for (const item of all) {
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const mergeRequest = item as { web_url?: unknown; iid?: unknown; source_branch?: unknown; state?: unknown };
    if (mergeRequest.state !== "opened" || mergeRequest.source_branch !== branch) {
      continue;
    }

    if (typeof mergeRequest.web_url === "string" && typeof mergeRequest.iid === "number") {
      return {
        webUrl: mergeRequest.web_url,
        iid: mergeRequest.iid,
      };
    }
  }

  return null;
}

async function getLatestGitLabPipeline({
  gitlab,
  projectPath,
  branch,
}: {
  gitlab: Gitlab;
  projectPath: string;
  branch: string;
}): Promise<{ status: string; sha?: string } | null> {
  const pipelines = await gitlab.Pipelines.all(projectPath, {
    ref: branch,
    orderBy: "id",
    sort: "desc",
    perPage: 1,
  }) as unknown;

  if (!Array.isArray(pipelines) || pipelines.length === 0) {
    return null;
  }

  const latest = pipelines[0];
  if (typeof latest !== "object" || latest === null) {
    return null;
  }

  const pipeline = latest as { status?: unknown; sha?: unknown };
  if (typeof pipeline.status !== "string") {
    return null;
  }

  return {
    status: pipeline.status,
    sha: typeof pipeline.sha === "string" ? pipeline.sha : undefined,
  };
}

async function maybeWatchGitLabPipeline({
  client,
  sessionID,
  branch,
  headSha,
}: {
  client: PluginClient;
  sessionID: string;
  branch: string;
  headSha: string;
}): Promise<boolean> {
  const projectInfo = await getGitLabProjectInfo();
  if (!projectInfo) {
    return false;
  }

  const gitlab = getGitLabClient(projectInfo.host);
  if (!gitlab) {
    return false;
  }

  const mr = await findOpenGitLabMergeRequest({
    gitlab,
    projectPath: projectInfo.projectPath,
    branch,
  });
  if (!mr) {
    return false;
  }

  const pipeline = await getLatestGitLabPipeline({
    gitlab,
    projectPath: projectInfo.projectPath,
    branch,
  });
  if (!pipeline || pipeline.sha !== headSha) {
    return false;
  }

  await sendSessionPrompt(
    client,
    sessionID,
    `All local changes are committed and pushed. Waiting for MR pipeline to finish for ${mr.webUrl}.`,
    true,
  );

  let finalPipeline = pipeline;
  while (true) {
    const currentPipeline = await getLatestGitLabPipeline({
      gitlab,
      projectPath: projectInfo.projectPath,
      branch,
    });

    if (!currentPipeline) {
      return false;
    }

    if (currentPipeline.sha && currentPipeline.sha !== headSha) {
      return false;
    }

    finalPipeline = currentPipeline;
    if (!isGitLabPipelineRunning(currentPipeline.status)) {
      break;
    }

    await sleep(10_000);
  }

  const { status, successful } = getGitLabPipelineSummary(finalPipeline);
  if (successful) {
    await handleSuccessfulPipeline({
      client,
      sessionID,
      platform: "GitLab",
      reviewUrl: mr.webUrl,
      branch,
      headSha,
    });
  }

  const finalMessage = successful
    ? `MR pipeline finished successfully for ${mr.webUrl} (status: ${status}).`
    : `MR pipeline finished with status '${status}' for ${mr.webUrl}. Please investigate the pipeline failure, fix the issues, then commit and push the changes.`;

  await sendSessionPrompt(client, sessionID, finalMessage, successful);
  watchedHeadBySession.set(sessionID, headSha);
  return true;
}

async function watchAssociatedPipeline({
  client,
  sessionID,
  branch,
  headSha,
}: {
  client: PluginClient;
  sessionID: string;
  branch: string;
  headSha: string;
}): Promise<void> {
  if (branch === "HEAD") {
    return;
  }

  const watchedHead = watchedHeadBySession.get(sessionID);
  if (watchedHead === headSha) {
    return;
  }

  const githubWatched = await maybeWatchGithubPipeline({ client, sessionID, branch, headSha });
  if (githubWatched) {
    return;
  }

  await maybeWatchGitLabPipeline({ client, sessionID, branch, headSha });
}

async function getGitState(): Promise<GitState | null> {
  const git = simpleGit();
  const insideWorktree = await git.checkIsRepo();
  if (!insideWorktree) {
    return null;
  }

  const status = await git.status();
  const hasUncommittedChanges = !status.isClean();
  const upstream = status.tracking ?? "";
  const aheadCount = status.ahead;

  let hasUnpushedCommits = aheadCount > 0;
  if (!upstream) {
    const unpushedAnywhere = await git.log(["--branches", "--not", "--remotes", "--max-count=1"]);
    hasUnpushedCommits = unpushedAnywhere.total > 0;
  }

  const branchSummary = await git.branchLocal();
  const branch = status.current || branchSummary.current || "HEAD";
  const headSha = (await git.revparse(["HEAD"])).trim();

  return {
    hasUncommittedChanges,
    hasUnpushedCommits,
    upstream,
    aheadCount,
    branch,
    headSha,
  };
}

export const GitHygienePlugin: Plugin = async ({ client }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") {
        return;
      }

      const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID;
      if (!sessionID) {
        return;
      }

      const gitState = await getGitState();
      if (!gitState) {
        return;
      }

      if (!gitState.hasUncommittedChanges && !gitState.hasUnpushedCommits) {
        reminderFingerprintBySession.delete(sessionID);

        if (!pipelineWatchInFlightBySession.has(sessionID)) {
          const watchPromise = watchAssociatedPipeline({
            client,
            sessionID,
            branch: gitState.branch,
            headSha: gitState.headSha,
          })
            .catch(() => {
            })
            .finally(() => {
              pipelineWatchInFlightBySession.delete(sessionID);
            });

          pipelineWatchInFlightBySession.set(sessionID, watchPromise);
        }

        return;
      }

      const fingerprint = `${gitState.hasUncommittedChanges}:${gitState.hasUnpushedCommits}:${gitState.upstream}:${gitState.aheadCount}`;
      if (reminderFingerprintBySession.get(sessionID) === fingerprint) {
        return;
      }

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
