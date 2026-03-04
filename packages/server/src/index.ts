import express from "express";
import cors from "cors";
import httpProxy from "http-proxy";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { router } from "./routes.js";
import { runHealthChecks, cleanupAll, getContainerPort } from "./docker.js";
import { PORT, validateEnvironment } from "./config.js";

validateEnvironment();

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors());
app.use(express.json({ limit: "100kb" }));

const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on("error", (_err, _req, res) => {
  if ("writeHead" in res && typeof res.writeHead === "function") {
    (res as import("http").ServerResponse).writeHead(502, { "Content-Type": "application/json" });
    (res as import("http").ServerResponse).end(JSON.stringify({ error: "Container unavailable" }));
  }
});

const CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/;

async function proxyToContainer(req: express.Request, res: express.Response) {
  const id = req.params.id as string;
  if (!CONTAINER_ID_RE.test(id)) { res.status(400).json({ error: "Invalid container ID" }); return; }
  const port = await getContainerPort(id);
  if (!port) { res.status(404).json({ error: "No port mapping for container" }); return; }
  req.url = req.url!.replace(`/proxy/${id}`, "") || "/";
  proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
}

app.all("/proxy/:id", proxyToContainer);
app.all("/proxy/:id/*", proxyToContainer);

app.use(router);

app.all(/^\/api\//, (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const clientDistPath = resolve(__dirname, "../../client/dist");
if (existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get("*", (_req, res) => {
    res.sendFile(resolve(clientDistPath, "index.html"));
  });
}

runHealthChecks().catch((err) => {
  console.error("Initial health check error:", err);
});

const healthInterval = setInterval(() => {
  runHealthChecks().catch((err) => {
    console.error("Health check error:", err);
  });
}, 30000);

const server = app.listen(PORT, () => {
  console.log(`Code Remote Control server listening on port ${PORT}`);
});

server.on("upgrade", async (req, socket, head) => {
  const match = req.url?.match(/^\/proxy\/([a-f0-9]{12,64})(\/.*)?$/);
  if (!match) { socket.destroy(); return; }
  const port = await getContainerPort(match[1]);
  if (!port) { socket.destroy(); return; }
  req.url = match[2] || "/";
  proxy.ws(req, socket, head, { target: `http://127.0.0.1:${port}` });
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
