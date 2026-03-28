import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { ContainerCodeStatus, ForgeProvider, PipelineStatus, ReviewRequestStatus } from "../../container-metadata-types/src/index.js";

const execFileAsync = promisify(execFile);
const METADATA_PORT = parseInt(process.env.CRC_METADATA_PORT || "8081", 10);
const TASK_DESCRIPTION_PATH = "/run/opencode-current-task-description";

function respondJson(res: import("node:http").ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd: "/workspace",
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function runJsonCommand(command: string, args: string[]): Promise<unknown> {
  const output = await runCommand(command, args);
  return JSON.parse(output);
}

async function readCurrentTaskDescription(): Promise<string | null> {
  try {
    const value = await readFile(TASK_DESCRIPTION_PATH, "utf-8");
    const taskDescription = value.trim();
    return taskDescription.length > 0 ? taskDescription : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function resolveProvider(): ForgeProvider {
  if (process.env.CRC_REPO_SOURCE === "github") {
    return "github";
  }

  if (process.env.CRC_REPO_SOURCE === "gitlab") {
    return "gitlab";
  }

  if (process.env.GITLAB_TOKEN) {
    return "gitlab";
  }

  if (process.env.GITHUB_TOKEN) {
    return "github";
  }

  return "none";
}

function mapGitHubPipeline(rawChecks: unknown): PipelineStatus | null {
  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    return null;
  }

  const states = rawChecks
    .map((entry) => {
      if (typeof entry !== "object" || entry === null || !("state" in entry)) {
        return "";
      }
      const state = entry.state;
      return typeof state === "string" ? state.toUpperCase() : "";
    })
    .filter((state) => state.length > 0);

  if (states.length === 0) {
    return null;
  }

  const hasFailure = states.some((state) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(state));
  const hasRunning = states.some((state) => ["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "EXPECTED"].includes(state));

  let status = "unknown";
  if (hasFailure) {
    status = "failed";
  } else if (hasRunning) {
    status = "running";
  } else {
    status = "success";
  }

  let url: string | null = null;
  for (const entry of rawChecks) {
    if (typeof entry !== "object" || entry === null || !("detailsUrl" in entry)) {
      continue;
    }

    const detailsUrl = entry.detailsUrl;
    if (typeof detailsUrl === "string" && detailsUrl.length > 0) {
      url = detailsUrl;
      break;
    }
  }

  return { status, url };
}

async function fetchGitHubStatus(warnings: string[]): Promise<{ reviewRequest: ReviewRequestStatus | null; pipeline: PipelineStatus | null }> {
  try {
    const raw = await runJsonCommand("gh", [
      "pr",
      "view",
      "--json",
      "number,title,url,state,isDraft,headRefName,baseRefName,statusCheckRollup",
    ]) as Record<string, unknown>;

    const number = raw.number;
    const title = raw.title;
    const url = raw.url;
    const state = raw.state;
    const isDraft = raw.isDraft;
    const headRefName = raw.headRefName;
    const baseRefName = raw.baseRefName;

    if (
      typeof number !== "number" ||
      typeof title !== "string" ||
      typeof url !== "string" ||
      typeof state !== "string" ||
      typeof isDraft !== "boolean" ||
      typeof headRefName !== "string" ||
      typeof baseRefName !== "string"
    ) {
      throw new Error("GitHub CLI returned invalid PR payload");
    }

    const reviewRequest: ReviewRequestStatus = {
      id: String(number),
      title,
      url,
      state,
      isDraft,
      sourceBranch: headRefName,
      targetBranch: baseRefName,
    };

    return {
      reviewRequest,
      pipeline: mapGitHubPipeline(raw.statusCheckRollup),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.toLowerCase().includes("no pull requests found for branch")) {
      return {
        reviewRequest: null,
        pipeline: null,
      };
    }

    warnings.push(`GitHub metadata unavailable: ${message}`);
    return {
      reviewRequest: null,
      pipeline: null,
    };
  }
}

function mapGitLabPipeline(raw: unknown): PipelineStatus | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const statusValue = "status" in raw ? raw.status : undefined;
  if (typeof statusValue !== "string") {
    return null;
  }

  const webUrl =
    ("web_url" in raw && typeof raw.web_url === "string" && raw.web_url.length > 0 ? raw.web_url : null) ||
    ("url" in raw && typeof raw.url === "string" && raw.url.length > 0 ? raw.url : null);

  return {
    status: statusValue,
    url: webUrl,
  };
}

async function fetchGitLabStatus(warnings: string[]): Promise<{ reviewRequest: ReviewRequestStatus | null; pipeline: PipelineStatus | null }> {
  try {
    const raw = await runJsonCommand("glab", [
      "mr",
      "view",
      "--json",
      "iid,title,web_url,state,draft,source_branch,target_branch,pipeline,head_pipeline",
    ]) as Record<string, unknown>;

    const iid = raw.iid;
    const title = raw.title;
    const webUrl = raw.web_url;
    const state = raw.state;
    const draft = raw.draft;
    const sourceBranch = raw.source_branch;
    const targetBranch = raw.target_branch;

    if (
      typeof iid !== "number" ||
      typeof title !== "string" ||
      typeof webUrl !== "string" ||
      typeof state !== "string" ||
      typeof draft !== "boolean" ||
      typeof sourceBranch !== "string" ||
      typeof targetBranch !== "string"
    ) {
      throw new Error("GitLab CLI returned invalid MR payload");
    }

    const reviewRequest: ReviewRequestStatus = {
      id: String(iid),
      title,
      url: webUrl,
      state,
      isDraft: draft,
      sourceBranch,
      targetBranch,
    };

    return {
      reviewRequest,
      pipeline: mapGitLabPipeline(raw.head_pipeline) || mapGitLabPipeline(raw.pipeline),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`GitLab metadata unavailable: ${message}`);
    return {
      reviewRequest: null,
      pipeline: null,
    };
  }
}

async function buildCodeStatus(): Promise<ContainerCodeStatus> {
  const warnings: string[] = [];
  const branch = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commitSha = await runCommand("git", ["rev-parse", "--short", "HEAD"]);
  const currentTaskDescription = await readCurrentTaskDescription();

  const provider = resolveProvider();
  let reviewRequest: ReviewRequestStatus | null = null;
  let pipeline: PipelineStatus | null = null;

  if (provider === "github") {
    const status = await fetchGitHubStatus(warnings);
    reviewRequest = status.reviewRequest;
    pipeline = status.pipeline;
  }

  if (provider === "gitlab") {
    const status = await fetchGitLabStatus(warnings);
    reviewRequest = status.reviewRequest;
    pipeline = status.pipeline;
  }

  return {
    branch,
    commitSha,
    provider,
    currentTaskDescription,
    reviewRequest,
    pipeline,
    warnings,
    updatedAt: new Date().toISOString(),
  };
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" || req.url !== "/api/code-status") {
    respondJson(res, 404, { error: "Not found" });
    return;
  }

  try {
    const payload = await buildCodeStatus();
    respondJson(res, 200, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respondJson(res, 500, { error: `Failed to build code status metadata: ${message}` });
  }
});

server.listen(METADATA_PORT, "0.0.0.0", () => {
  console.log(`Container metadata server listening on port ${METADATA_PORT}`);
});
