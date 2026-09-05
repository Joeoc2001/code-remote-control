import express from "express";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { router } from "./routes.js";
import { runHealthChecks, cleanupAll } from "./docker.js";
import { runTaskSchedulerTick, TASK_TICK_INTERVAL_MS } from "./tasks/scheduler.js";
import { schedulerDeps } from "./tasks/runtime.js";
import { PORT, validateEnvironment, loadConfigurations } from "./config.js";
import { proxyMiddleware, wsUpgradeHandler } from "./proxy.js";
import { authMiddleware, isAuthEnabled } from "./auth.js";

const HEALTH_CHECK_INTERVAL_MS = 1000;

validateEnvironment();

await loadConfigurations();

if (!isAuthEnabled()) {
  console.warn("CRC_ACCESS_TOKEN is not set: the API and container terminals are exposed without authentication.");
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(authMiddleware);
app.use(proxyMiddleware);
app.use(express.json({ limit: "100kb" }));

const clientDistPath = resolve(__dirname, "../../client/dist");
const indexHtmlPath = resolve(clientDistPath, "index.html");
let indexHtml: string | null = null;

if (existsSync(indexHtmlPath)) {
  indexHtml = readFileSync(indexHtmlPath, "utf-8");
}

app.use(router);
app.all(/^\/api\//, (_req, res) => {
  res.status(404).json({ error: "Not found" });
});
if (existsSync(clientDistPath) && indexHtml) {
  app.use(express.static(clientDistPath, { index: false }));
  app.get("*", (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.send(indexHtml);
  });
}

let stopping = false;
let healthTimer: NodeJS.Timeout | null = null;

async function healthLoop(): Promise<void> {
  if (stopping) return;
  try {
    await runHealthChecks();
  } catch (err) {
    console.error("Health check error:", err);
  }
  if (!stopping) {
    healthTimer = setTimeout(() => {
      void healthLoop();
    }, HEALTH_CHECK_INTERVAL_MS);
  }
}

void healthLoop();

let taskTimer: NodeJS.Timeout | null = null;
let taskTick: Promise<void> = Promise.resolve();

async function taskLoop(): Promise<void> {
  if (stopping) return;
  taskTick = runTaskSchedulerTick(schedulerDeps).catch((err) => {
    console.error("Task scheduler error:", err);
  });
  await taskTick;
  if (!stopping) {
    taskTimer = setTimeout(() => {
      void taskLoop();
    }, TASK_TICK_INTERVAL_MS);
  }
}

void taskLoop();

const server = app.listen(PORT, () => {
  console.log(`Code Remote Control server listening on port ${PORT}`);
});

server.on("upgrade", wsUpgradeHandler);

function shutdown() {
  console.log("Shutting down...");
  stopping = true;
  if (healthTimer) clearTimeout(healthTimer);
  if (taskTimer) clearTimeout(taskTimer);
  cleanupAll();
  void taskTick.then(() => {
    server.close(() => {
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
