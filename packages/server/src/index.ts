import express from "express";
import cors from "cors";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { router } from "./routes.js";
import { runHealthChecks, cleanupAll, pullLatestImage, buildCustomImage } from "./docker.js";
import { PORT, validateEnvironment, loadConfigurations } from "./config.js";
import { proxyMiddleware } from "./proxy.js";

validateEnvironment();

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(proxyMiddleware);
app.use(cors());
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

loadConfigurations().then((config) =>
  config.env_dockerfile
    ? buildCustomImage(config.env_dockerfile)
    : pullLatestImage()
).catch((err) => {
  console.error("Failed to set up env image:", err);
});

runHealthChecks().catch((err) => {
  console.error("Initial health check error:", err);
});

const healthInterval = setInterval(() => {
  runHealthChecks().catch((err) => {
    console.error("Health check error:", err);
  });
}, 1000);

const server = app.listen(PORT, () => {
  console.log(`Code Remote Control server listening on port ${PORT}`);
});

function shutdown() {
  console.log("Shutting down...");
  clearInterval(healthInterval);
  cleanupAll();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
