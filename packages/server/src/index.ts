import express from "express";
import cors from "cors";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { router } from "./routes.js";
import { runHealthChecks } from "./docker.js";
import { PORT, validateEnvironment } from "./config.js";

validateEnvironment();

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors());
app.use(express.json({ limit: "100kb" }));

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

setInterval(() => {
  runHealthChecks().catch((err) => {
    console.error("Health check error:", err);
  });
}, 30000);

app.listen(PORT, () => {
  console.log(`Code Remote Control server listening on port ${PORT}`);
});
