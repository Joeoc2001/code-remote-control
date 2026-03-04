import { Router } from "express";
import crypto from "node:crypto";
import { loadConfigurations } from "./config.js";
import {
  listContainers,
  createContainer,
  removeContainer,
  getContainerLogStream,
  addSSEClient,
  removeSSEClient,
  broadcastRemoval,
  updateAndRestartSystem,
} from "./docker.js";
import { fetchRepos } from "./github.js";
import type { CreateContainerRequest } from "./types.js";

export const router = Router();

const REPO_NAME_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

function isValidContainerId(id: string): boolean {
  return /^[a-f0-9]+$/.test(id) && id.length >= 12 && id.length <= 64;
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

router.post("/api/containers", async (req, res) => {
  try {
    const { configName, repoFullName } = req.body as CreateContainerRequest;

    if (!configName || !repoFullName) {
      res.status(400).json({ error: "configName and repoFullName are required" });
      return;
    }

    if (!REPO_NAME_RE.test(repoFullName)) {
      res.status(400).json({ error: "repoFullName must be in owner/repo format" });
      return;
    }

    const configs = await loadConfigurations();
    const config = configs.configurations.find((c) => c.name === configName);
    if (!config) {
      res.status(400).json({ error: `Configuration '${configName}' not found` });
      return;
    }

    const container = await createContainer(config, repoFullName);
    res.status(201).json(container);
  } catch (err) {
    console.error("Error creating container:", err);
    res.status(500).json({ error: "Failed to create container" });
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

router.get("/api/configs", async (_req, res) => {
  try {
    const configs = await loadConfigurations();
    res.json(configs);
  } catch (err) {
    console.error("Error loading configs:", err);
    res.status(500).json({ error: "Failed to load configurations" });
  }
});

router.get("/api/github/repos", async (_req, res) => {
  try {
    const repos = await fetchRepos();
    res.json({ repos });
  } catch (err) {
    console.error("Error fetching repos:", err);
    res.status(500).json({ error: "Failed to fetch repositories" });
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

router.post("/api/system/update", async (_req, res) => {
  try {
    res.status(202).json({ message: "Update initiated" });
    updateAndRestartSystem();
  } catch (err) {
    console.error("Error initiating update:", err);
    res.status(500).json({ error: "Failed to initiate update" });
  }
});
