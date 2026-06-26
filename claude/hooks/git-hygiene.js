const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");

const CWD = "/workspace";
const POLL_INTERVAL_MS = 60_000;
const WATCH_TIMEOUT_MS = parseInt(process.env.CRC_CI_WATCH_TIMEOUT_MS || "86400000", 10);
const GITHUB_CHECK_BUCKETS = new Set(["pass", "fail", "pending", "cancel", "skipping"]);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: CWD, encoding: "utf-8", maxBuffer: 1024 * 1024 });
  if (result.error) return "";
  return (result.stdout || "").trim();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowStop() {
  process.exit(0);
}

function blockStop(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

function fingerprintPath(sessionId) {
  const safeId = String(sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "-");
  return `/run/crc-git-hygiene-${safeId}.json`;
}

function readFingerprint(sessionId) {
  try {
    return JSON.parse(readFileSync(fingerprintPath(sessionId), "utf-8"));
  } catch {
    return {};
  }
}

function writeFingerprint(sessionId, value) {
  try {
    writeFileSync(fingerprintPath(sessionId), JSON.stringify(value), { encoding: "utf-8", mode: 0o644 });
  } catch {
    /* best-effort */
  }
}

function getGitState() {
  if (run("git", ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;

  const hasUncommittedChanges = run("git", ["status", "--porcelain"]).length > 0;
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const headSha = run("git", ["rev-parse", "HEAD"]);
  if (!branch || !headSha) return null;

  const upstream = run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  let hasUnpushedCommits;
  let aheadCount = 0;
  if (upstream) {
    aheadCount = parseInt(run("git", ["rev-list", "--count", `${upstream}..HEAD`]) || "0", 10);
    hasUnpushedCommits = aheadCount > 0;
  } else {
    hasUnpushedCommits = run("git", ["log", "--not", "--remotes", "--max-count=1", "--format=%H", "HEAD"]).length > 0;
  }

  return { hasUncommittedChanges, hasUnpushedCommits, upstream, aheadCount, branch, headSha };
}

function dirtyReminder(state) {
  if (state.hasUncommittedChanges && state.hasUnpushedCommits) {
    return "You have uncommitted and unpushed local changes; commit your outstanding workspace changes, push your local commits to remote, then open a PR or MR.";
  }
  if (state.hasUncommittedChanges) {
    return "You have uncommitted local changes; commit your outstanding workspace changes, then push to remote and open a PR or MR.";
  }
  return "You have unpushed local commits; push your local commits to remote, then open a PR or MR.";
}

function parseGithubPr(payload) {
  if (!isRecord(payload)) return null;
  const url = typeof payload.url === "string" ? payload.url : null;
  const state = typeof payload.state === "string" ? payload.state : null;
  if (!url || !state) return null;
  return { url, state };
}

function parseGithubChecks(payload) {
  if (!Array.isArray(payload)) return null;
  const summary = { pass: 0, fail: 0, pending: 0, cancel: 0, skipping: 0 };
  for (const item of payload) {
    const bucket = isRecord(item) && typeof item.bucket === "string" ? item.bucket : null;
    if (bucket && GITHUB_CHECK_BUCKETS.has(bucket)) summary[bucket] += 1;
  }
  return summary;
}

function watchGithub(branch) {
  const pr = parseGithubPr(tryParseJson(run("gh", ["pr", "view", branch, "--json", "number,url,title,state"])));
  if (!pr || pr.state !== "OPEN") return { handled: false };

  const deadline = Date.now() + WATCH_TIMEOUT_MS;
  let summary = null;
  while (Date.now() < deadline) {
    summary = parseGithubChecks(tryParseJson(run("gh", ["pr", "checks", branch, "--json", "bucket,name,state,link"])));
    if (summary && summary.pending === 0 && summary.cancel === 0) break;
    sleepSync(POLL_INTERVAL_MS);
  }

  if (!summary) return { handled: true, failure: null };
  if (summary.fail > 0) {
    return {
      handled: true,
      failure: `PR checks finished with failures for ${pr.url} (fail: ${summary.fail}, cancel: ${summary.cancel}, pending: ${summary.pending}). Please investigate the failing checks, fix the issues, then commit and push the changes.`,
    };
  }
  return { handled: true, failure: null };
}

function parseGitlabMr(payload) {
  const list = Array.isArray(payload) ? payload : [payload];
  for (const item of list) {
    if (isRecord(item) && typeof item.web_url === "string") return { url: item.web_url };
  }
  return null;
}

function parseGitlabPipeline(payload) {
  const list = Array.isArray(payload) ? payload : [payload];
  for (const item of list) {
    if (isRecord(item) && typeof item.status === "string") {
      return { status: item.status, sha: typeof item.sha === "string" ? item.sha : null };
    }
  }
  return null;
}

function isGitlabTerminal(status) {
  return ["success", "passed", "failed", "canceled", "cancelled", "skipped", "manual"].includes(status);
}

function watchGitlab(branch, headSha) {
  const encodedBranch = encodeURIComponent(branch);
  const mr = parseGitlabMr(tryParseJson(run("glab", ["api", `projects/:id/merge_requests?state=opened&source_branch=${encodedBranch}&per_page=1`])));
  if (!mr) return { handled: false };

  const encodedSha = encodeURIComponent(headSha);
  const deadline = Date.now() + WATCH_TIMEOUT_MS;
  let pipeline = null;
  while (Date.now() < deadline) {
    pipeline = parseGitlabPipeline(tryParseJson(run("glab", ["api", `projects/:id/pipelines?ref=${encodedBranch}&sha=${encodedSha}&per_page=1`])));
    if (pipeline && pipeline.sha === headSha && isGitlabTerminal(pipeline.status)) break;
    sleepSync(POLL_INTERVAL_MS);
  }

  if (!pipeline) return { handled: true, failure: null };
  if (pipeline.status === "failed") {
    return {
      handled: true,
      failure: `MR pipeline finished with status 'failed' for ${mr.url}. Please investigate the pipeline failure, fix the issues, then commit and push the changes.`,
    };
  }
  return { handled: true, failure: null };
}

async function main() {
  const payload = tryParseJson(await readStdin()) || {};
  const sessionId = payload.session_id;

  const state = getGitState();
  if (!state) allowStop();

  const fingerprint = readFingerprint(sessionId);

  if (state.hasUncommittedChanges || state.hasUnpushedCommits) {
    const dirtyKey = `${state.hasUncommittedChanges}:${state.hasUnpushedCommits}:${state.upstream}:${state.aheadCount}`;
    if (payload.stop_hook_active && fingerprint.dirtyKey === dirtyKey) allowStop();
    writeFingerprint(sessionId, { dirtyKey });
    blockStop(dirtyReminder(state));
  }

  if (state.branch === "HEAD") allowStop();
  if (fingerprint.watchedHead === state.headSha) allowStop();

  const result = watchGithub(state.branch);
  const finalResult = result.handled ? result : watchGitlab(state.branch, state.headSha);

  writeFingerprint(sessionId, { watchedHead: state.headSha });
  if (finalResult.handled && finalResult.failure) blockStop(finalResult.failure);
  allowStop();
}

main();
