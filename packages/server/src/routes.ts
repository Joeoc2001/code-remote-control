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
} from "./docker.js";
import { fetchRepos } from "./github.js";
import type { CreateContainerRequest } from "./types.js";

export const router = Router();

// List all managed containers
router.get("/api/containers", async (_req, res) => {
  try {
    const containers = await listContainers();
    res.json(containers);
  } catch (err) {
    console.error("Error listing containers:", err);
    res.status(500).json({ error: "Failed to list containers" });
  }
});

// Create a new container
router.post("/api/containers", async (req, res) => {
  try {
    const { configName, repoFullName } = req.body as CreateContainerRequest;

    if (!configName || !repoFullName) {
      res.status(400).json({ error: "configName and repoFullName are required" });
      return;
    }

    const configs = loadConfigurations();
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

// Delete a container
router.delete("/api/containers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await removeContainer(id);
    broadcastRemoval(id);
    res.status(204).send();
  } catch (err) {
    console.error("Error removing container:", err);
    res.status(500).json({ error: "Failed to remove container" });
  }
});

// Stream container logs via SSE
router.get("/api/containers/:id/logs", async (req, res) => {
  try {
    const { id } = req.params;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const stream = await getContainerLogStream(id);
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
    });
  } catch (err) {
    console.error("Error streaming logs:", err);
    res.status(500).json({ error: "Failed to stream logs" });
  }
});

// Get configurations
router.get("/api/configs", (_req, res) => {
  try {
    const configs = loadConfigurations();
    res.json(configs);
  } catch (err) {
    console.error("Error loading configs:", err);
    res.status(500).json({ error: "Failed to load configurations" });
  }
});

// Get GitHub repos
router.get("/api/github/repos", async (_req, res) => {
  try {
    const repos = await fetchRepos();
    res.json({ repos });
  } catch (err) {
    console.error("Error fetching repos:", err);
    res.status(500).json({ error: "Failed to fetch repositories" });
  }
});

// SSE endpoint for real-time updates
router.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const clientId = crypto.randomUUID();
  addSSEClient({ id: clientId, res });

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(":heartbeat\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeSSEClient(clientId);
  });
});
