import { execFileSync } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import type { Task } from "@crc/shared";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const stubTask: Task = {
  id: "task-1",
  repoFullName: "example/repo",
  repoSource: "github",
  workItem: {
    id: "1",
    reference: "#1",
    title: "Example work item",
    url: "https://example.test/issues/1",
    body: null,
    kind: "issue",
  },
  configByStep: {
    implement: "default",
    fix_ci: "default",
    rebase: "default",
    review: "default",
    address_comments: "default",
  },
  phase: "paused",
  reviewRequest: null,
  lastReviewedSha: null,
  activeContainerId: null,
  activeStep: null,
  attemptsByStep: { implement: 1, fix_ci: 0, rebase: 0, review: 0, address_comments: 0 },
  attempts: [],
  consecutiveErrors: 0,
  error: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const apiStubs: Record<string, unknown> = {
  "/api/containers": [],
  "/api/tasks": [],
  "/api/tasks/task-1": stubTask,
  "/api/configs": { configurations: [{ name: "default" }] },
  "/api/build-info": { buildId: "0000000" },
  "/api/root-domain": { rootDomain: "example.test" },
  "/api/github/repos": { repos: [] },
  "/api/gitlab/repos": { repos: [], configured: false },
};

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export interface ClientAppHarness {
  origin: string;
  browser: Browser;
  unstubbedRequests: string[];
  sendEvent: (event: string, data: unknown) => void;
  setStub: (path: string, response: unknown) => void;
  stop: () => Promise<void>;
}

function buildClient(): string {
  const distDir = mkdtempSync(join(tmpdir(), "crc-client-dist-"));
  execFileSync("npm", ["run", "build", "-w", "packages/client", "--", "--outDir", distDir, "--emptyOutDir"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  return distDir;
}

function startStubServer(
  distDir: string,
  unstubbedRequests: string[],
  eventStreams: Set<ServerResponse>,
  stubs: Record<string, unknown>,
): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(":ok\n\n");
      eventStreams.add(res);
      res.on("close", () => eventStreams.delete(res));
      return;
    }

    if (path.startsWith("/api/")) {
      const stub = stubs[path];
      if (stub === undefined) {
        unstubbedRequests.push(path);
        res.writeHead(500).end(`no stub for ${path}`);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(stub));
      return;
    }

    const extension = extname(path) || ".html";
    const assetPath = extension === ".html" ? "index.html" : path;
    res
      .writeHead(200, { "Content-Type": contentTypes[extension] ?? "application/octet-stream" })
      .end(readFileSync(join(distDir, assetPath)));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("stub server has no port");
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

export async function startClientApp(extraStubs: Record<string, unknown> = {}): Promise<ClientAppHarness> {
  const distDir = buildClient();
  const unstubbedRequests: string[] = [];
  const eventStreams = new Set<ServerResponse>();
  const stubs = { ...apiStubs, ...extraStubs };
  const { server, origin } = await startStubServer(distDir, unstubbedRequests, eventStreams, stubs);
  const browser = await chromium.launch();

  return {
    origin,
    browser,
    unstubbedRequests,
    sendEvent: (event, data) => {
      if (eventStreams.size === 0) throw new Error("no client is subscribed to /api/events");
      for (const stream of eventStreams) stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    setStub: (path, response) => {
      stubs[path] = response;
    },
    stop: async () => {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      rmSync(distDir, { recursive: true, force: true });
    },
  };
}
