import { Router } from "express";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigurations } from "./config.js";
import {
  listContainers,
  getContainer,
  createContainer,
  removeContainer,
  getContainerLogStream,
  CONTAINER_METADATA_INTERNAL_PORT,
  addSSEClient,
  removeSSEClient,
  broadcastRemoval,
  pullLatestImage,
} from "./docker.js";
import { fetchOpenIssues as fetchGitHubOpenIssues, fetchRepos as fetchGitHubRepos } from "./github.js";
import { fetchOpenIssuesAndWorkItems as fetchGitLabOpenIssuesAndWorkItems, fetchRepos as fetchGitLabRepos, isGitLabConfigured } from "./gitlab.js";
import type { CreateContainerRequestV2, CreateContainersRequest, ManagedContainer, RepoSource } from "./types.js";
import type { ContainerCodeStatus } from "@crc/container-metadata-types";

export const router = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));

const CODE_STATUS_CACHE_TTL_MS = 30_000;
const codeStatusCache = new Map<string, { data: ContainerCodeStatus; expiresAt: number }>();

const REPO_NAME_RE = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+$/;
const VALID_REPO_SOURCES: RepoSource[] = ["github", "gitlab"];

function getBuildId(): string {
  try {
    const buildInfoPath = resolve(__dirname, "../build-info.json");
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf-8"));
    return buildInfo.buildId || "unknown";
  } catch {
    return "unknown";
  }
}

function isValidContainerId(id: string): boolean {
  return /^[a-f0-9]+$/.test(id) && id.length >= 12 && id.length <= 64;
}

function isValidRepoSource(value: unknown): value is RepoSource {
  return typeof value === "string" && VALID_REPO_SOURCES.includes(value as RepoSource);
}

router.get("/api/containers", async (_req, res) => {
  try {
    const containers = await listContainers();
    res.json(containers);
  } catch (err) {
    console.error("Error listing containers:", err);
    res.status(500).json({ error: "Failed to list containers" });
  }
});

router.get("/api/containers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidContainerId(id)) {
      res.status(400).json({ error: "Invalid container ID" });
      return;
    }
    const container = await getContainer(id);
    if (!container) {
      res.status(404).json({ error: "Container not found" });
      return;
    }
    res.json(container);
  } catch (err) {
    console.error("Error fetching container:", err);
    res.status(500).json({ error: "Failed to fetch container" });
  }
});

router.post("/api/containers", async (req, res) => {
  try {
    const { configName, repoFullName, repoSource = "github", initialPrompt } = req.body as CreateContainerRequestV2;

    if (!configName || !repoFullName) {
      res.status(400).json({ error: "configName and repoFullName are required" });
      return;
    }

    if (!REPO_NAME_RE.test(repoFullName)) {
      res.status(400).json({ error: "repoFullName must be in namespace/repo format" });
      return;
    }

    if (!isValidRepoSource(repoSource)) {
      res.status(400).json({ error: "repoSource must be 'github' or 'gitlab'" });
      return;
    }

    if (initialPrompt !== undefined && typeof initialPrompt !== "string") {
      res.status(400).json({ error: "initialPrompt must be a string" });
      return;
    }

    const configs = await loadConfigurations();
    const config = configs.configurations.find((c) => c.name === configName);
    if (!config) {
      res.status(400).json({ error: `Configuration '${configName}' not found` });
      return;
    }

    const container = await createContainer(configs, config, repoFullName, repoSource, { initialPrompt });
    res.status(201).json(container);
  } catch (err) {
    console.error("Error creating container:", err);
    res.status(500).json({ error: "Failed to create container" });
  }
});

router.post("/api/containers/many", async (req, res) => {
  try {
    const { configName, repoFullName, repoSource = "github", prompts } = req.body as CreateContainersRequest;

    if (!configName || !repoFullName || !Array.isArray(prompts)) {
      res.status(400).json({ error: "configName, repoFullName, and prompts are required" });
      return;
    }

    if (!REPO_NAME_RE.test(repoFullName)) {
      res.status(400).json({ error: "repoFullName must be in namespace/repo format" });
      return;
    }

    if (!isValidRepoSource(repoSource)) {
      res.status(400).json({ error: "repoSource must be 'github' or 'gitlab'" });
      return;
    }

    if (prompts.length === 0 || prompts.some((prompt) => typeof prompt !== "string" || prompt.trim().length === 0)) {
      res.status(400).json({ error: "prompts must contain at least one non-empty string" });
      return;
    }

    const configs = await loadConfigurations();
    const config = configs.configurations.find((c) => c.name === configName);
    if (!config) {
      res.status(400).json({ error: `Configuration '${configName}' not found` });
      return;
    }

    await pullLatestImage();

    const containers: ManagedContainer[] = [];
    const errors: Array<{ prompt: string; error: string }> = [];
    for (const prompt of prompts) {
      try {
        const container = await createContainer(configs, config, repoFullName, repoSource, {
          initialPrompt: prompt,
          pullImage: false,
        });
        containers.push(container);
      } catch (err) {
        errors.push({ prompt, error: err instanceof Error ? err.message : String(err) });
      }
    }

    res.status(errors.length > 0 ? 207 : 201).json({ containers, errors });
  } catch (err) {
    console.error("Error creating containers:", err);
    res.status(500).json({ error: "Failed to create containers" });
  }
});

router.delete("/api/containers", async (_req, res) => {
  try {
    const containers = await listContainers();
    await Promise.all(
      containers.map(async (c) => {
        await removeContainer(c.id);
        broadcastRemoval(c.id);
      }),
    );
    res.status(204).send();
  } catch (err) {
    console.error("Error removing all containers:", err);
    res.status(500).json({ error: "Failed to remove all containers" });
  }
});

router.delete("/api/containers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidContainerId(id)) {
      res.status(400).json({ error: "Invalid container ID" });
      return;
    }
    await removeContainer(id);
    broadcastRemoval(id);
    res.status(204).send();
  } catch (err) {
    console.error("Error removing container:", err);
    res.status(500).json({ error: "Failed to remove container" });
  }
});

router.get("/api/containers/:id/logs", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidContainerId(id)) {
      res.status(400).json({ error: "Invalid container ID" });
      return;
    }
    const stream = await getContainerLogStream(id);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    stream.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split("\n");
      for (const line of lines) {
        if (line.trim()) {
          res.write(`data: ${JSON.stringify({ log: line })}\n\n`);
        }
      }
    });

    stream.on("end", () => {
      res.write("event: end\ndata: {}\n\n");
      res.end();
    });

    stream.on("error", () => {
      res.end();
    });

    req.on("close", () => {
      stream.removeAllListeners();
      if ("destroy" in stream && typeof stream.destroy === "function") {
        stream.destroy();
      }
    });
  } catch (err) {
    console.error("Error streaming logs:", err);
    res.status(500).json({ error: "Failed to stream logs" });
  }
});

router.get("/api/containers/:id/code-status", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidContainerId(id)) {
      res.status(400).json({ error: "Invalid container ID" });
      return;
    }

    const container = await getContainer(id);
    if (!container) {
      res.status(404).json({ error: "Container not found" });
      return;
    }

    if (container.status !== "running") {
      res.status(409).json({ error: "Container is not running" });
      return;
    }

    const cached = codeStatusCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      res.json(cached.data);
      return;
    }

    const response = await fetch(
      `http://${container.name}:${CONTAINER_METADATA_INTERNAL_PORT}/api/code-status`,
      { signal: AbortSignal.timeout(3000) },
    );

    if (!response.ok) {
      res.status(502).json({ error: "Container metadata server returned an error" });
      return;
    }

    const payload = await response.json() as ContainerCodeStatus;
    codeStatusCache.set(id, { data: payload, expiresAt: Date.now() + CODE_STATUS_CACHE_TTL_MS });
    res.json(payload);
  } catch (err) {
    console.error("Error fetching container code status:", err);
    res.status(500).json({ error: "Failed to fetch container code status" });
  }
});

router.get("/api/configs", async (_req, res) => {
  try {
    const configs = await loadConfigurations();
    res.json(configs);
  } catch (err) {
    console.error("Error loading configs:", err);
    res.status(500).json({ error: "Failed to load configurations" });
  }
});

router.get("/api/root-domain", async (_req, res) => {
  const configs = await loadConfigurations();
  res.json({ rootDomain: configs.root_domain || undefined });
});

router.get("/api/build-info", (_req, res) => {
  res.json({ buildId: getBuildId() });
});

router.get("/api/github/repos", async (_req, res) => {
  try {
    const repos = await fetchGitHubRepos();
    res.json({ repos });
  } catch (err) {
    console.error("Error fetching GitHub repos:", err);
    res.status(500).json({ error: "Failed to fetch GitHub repositories" });
  }
});

router.get("/api/gitlab/repos", async (_req, res) => {
  try {
    if (!isGitLabConfigured()) {
      res.json({ repos: [], configured: false });
      return;
    }
    const repos = await fetchGitLabRepos();
    res.json({ repos, configured: true });
  } catch (err) {
    console.error("Error fetching GitLab repos:", err);
    res.status(500).json({ error: "Failed to fetch GitLab repositories" });
  }
});

router.get("/api/repo-work-items", async (req, res) => {
  try {
    const repoFullName = typeof req.query.repoFullName === "string" ? req.query.repoFullName : "";
    const repoSource = typeof req.query.repoSource === "string" ? req.query.repoSource : "github";

    if (!repoFullName) {
      res.status(400).json({ error: "repoFullName is required" });
      return;
    }

    if (!REPO_NAME_RE.test(repoFullName)) {
      res.status(400).json({ error: "repoFullName must be in namespace/repo format" });
      return;
    }

    if (!isValidRepoSource(repoSource)) {
      res.status(400).json({ error: "repoSource must be 'github' or 'gitlab'" });
      return;
    }

    const items = repoSource === "github"
      ? await fetchGitHubOpenIssues(repoFullName)
      : await fetchGitLabOpenIssuesAndWorkItems(repoFullName);

    res.json({ items });
  } catch (err) {
    console.error("Error fetching repo work items:", err);
    res.status(500).json({ error: "Failed to fetch repository work items" });
  }
});

router.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const clientId = crypto.randomUUID();
  addSSEClient({ id: clientId, res });

  const heartbeat = setInterval(() => {
    res.write(":heartbeat\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeSSEClient(clientId);
  });
});
