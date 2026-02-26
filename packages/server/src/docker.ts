import Dockerode from "dockerode";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import type {
  ManagedContainer,
  ContainerHealth,
  EnvironmentConfig,
} from "./types.js";
import { GITHUB_TOKEN, ANTHROPIC_API_KEY, CRC_ENV_IMAGE } from "./config.js";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

const CONTAINER_PREFIX = "crc-";
const LABEL_CONFIG_NAME = "crc.config-name";
const LABEL_REPO_NAME = "crc.repo-name";
const HEALTH_CHECK_TIMEOUT_MS = 10_000;

const remoteUrlCache = new Map<string, string>();
const healthCache = new Map<string, ContainerHealth>();
const logWatchers = new Map<string, NodeJS.ReadableStream>();

function slugify(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 30);
}

function generateId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function demuxDockerStream(rawStream: NodeJS.ReadableStream): NodeJS.ReadableStream {
  const output = new PassThrough();
  docker.modem.demuxStream(rawStream as unknown as NodeJS.ReadWriteStream, output, output);
  rawStream.on("end", () => output.end());
  rawStream.on("error", (err) => output.destroy(err));
  return output;
}

async function assertManagedContainer(id: string): Promise<void> {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  const name = info.Name.replace(/^\//, "");
  if (!name.startsWith(CONTAINER_PREFIX)) {
    throw new Error("Container is not managed by CRC");
  }
}

function parseContainerInfo(container: Dockerode.ContainerInfo): ManagedContainer {
  const name = (container.Names[0] || "").replace(/^\//, "");
  const configName = container.Labels[LABEL_CONFIG_NAME] || "unknown";
  const repoName = container.Labels[LABEL_REPO_NAME] || "unknown";
  const status = container.State || "unknown";
  const health = healthCache.get(container.Id) || {
    container: status === "running" ? "running" as const : "stopped" as const,
    claudeCode: "unknown" as const,
  };

  return {
    id: container.Id,
    name,
    configName,
    repoName,
    status,
    health,
    remoteUrl: remoteUrlCache.get(container.Id) || null,
    createdAt: new Date(container.Created * 1000).toISOString(),
  };
}

export async function listContainers(): Promise<ManagedContainer[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { name: [CONTAINER_PREFIX] },
  });

  return containers
    .filter((c) => {
      const name = (c.Names[0] || "").replace(/^\//, "");
      return name.startsWith(CONTAINER_PREFIX);
    })
    .map(parseContainerInfo);
}

export async function getContainer(id: string): Promise<ManagedContainer | null> {
  try {
    const container = docker.getContainer(id);
    const info = await container.inspect();
    const name = info.Name.replace(/^\//, "");
    if (!name.startsWith(CONTAINER_PREFIX)) return null;

    const configName = info.Config.Labels[LABEL_CONFIG_NAME] || "unknown";
    const repoName = info.Config.Labels[LABEL_REPO_NAME] || "unknown";
    const status = info.State.Running ? "running" : info.State.Status;
    const health = healthCache.get(id) || {
      container: info.State.Running ? "running" as const : "stopped" as const,
      claudeCode: "unknown" as const,
    };

    return {
      id: info.Id,
      name,
      configName,
      repoName,
      status,
      health,
      remoteUrl: remoteUrlCache.get(info.Id) || null,
      createdAt: info.Created,
    };
  } catch {
    return null;
  }
}

export async function createContainer(
  config: EnvironmentConfig,
  repoFullName: string
): Promise<ManagedContainer> {
  const repoShortName = slugify(repoFullName.split("/").pop() || "repo");
  const containerName = `${CONTAINER_PREFIX}${slugify(config.name)}-${repoShortName}-${generateId()}`;
  const repoUrl = `https://github.com/${repoFullName}.git`;

  const envVars = [
    `REPO_URL=${repoUrl}`,
    `GITHUB_TOKEN=${GITHUB_TOKEN}`,
    `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}`,
    ...Object.entries(config.env).map(([k, v]) => `${k}=${v}`),
  ];

  const container = await docker.createContainer({
    Image: CRC_ENV_IMAGE,
    name: containerName,
    Env: envVars,
    Labels: {
      [LABEL_CONFIG_NAME]: config.name,
      [LABEL_REPO_NAME]: repoFullName,
    },
    HostConfig: {
      AutoRemove: false,
    },
  });

  await container.start();

  watchContainerLogs(container.id);

  const info = await container.inspect();
  return {
    id: info.Id,
    name: containerName,
    configName: config.name,
    repoName: repoFullName,
    status: "running",
    health: { container: "running", claudeCode: "unknown" },
    remoteUrl: null,
    createdAt: info.Created,
  };
}

export async function removeContainer(id: string): Promise<void> {
  await assertManagedContainer(id);
  const container = docker.getContainer(id);
  try {
    await container.stop();
  } catch (err: unknown) {
    const isAlreadyStopped =
      err instanceof Error &&
      (err.message.includes("304") || err.message.includes("is not running"));
    if (!isAlreadyStopped) throw err;
  }
  await container.remove({ v: true });
  cleanupLogWatcher(id);
  remoteUrlCache.delete(id);
  healthCache.delete(id);
}

export async function getContainerLogStream(id: string): Promise<NodeJS.ReadableStream> {
  await assertManagedContainer(id);
  const container = docker.getContainer(id);
  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: 100,
  });
  return demuxDockerStream(stream as unknown as NodeJS.ReadableStream);
}

function cleanupLogWatcher(containerId: string): void {
  const existing = logWatchers.get(containerId);
  if (existing) {
    existing.removeAllListeners();
    if ("destroy" in existing && typeof existing.destroy === "function") {
      existing.destroy();
    }
    logWatchers.delete(containerId);
  }
}

function watchContainerLogs(containerId: string): void {
  if (logWatchers.has(containerId)) return;

  const container = docker.getContainer(containerId);
  container
    .logs({ follow: true, stdout: true, stderr: true, tail: 50 })
    .then((stream) => {
      const readable = demuxDockerStream(stream as unknown as NodeJS.ReadableStream);
      logWatchers.set(containerId, readable);
      readable.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        const urlMatch = text.match(/(https:\/\/claude\.ai\/code\/session_[^\s"']+)/);
        if (urlMatch && !remoteUrlCache.has(containerId)) {
          remoteUrlCache.set(containerId, urlMatch[1]);
          broadcastUpdate(containerId);
        }
      });
      readable.on("end", () => {
        logWatchers.delete(containerId);
      });
      readable.on("error", () => {
        logWatchers.delete(containerId);
      });
    })
    .catch(() => { });
}

export async function attachWatchersToExistingContainers(): Promise<void> {
  const containers = await listContainers();
  for (const container of containers) {
    if (container.status === "running" && !logWatchers.has(container.id)) {
      watchContainerLogs(container.id);
    }
  }
}

type SSEClient = {
  id: string;
  res: import("express").Response;
};

const sseClients: SSEClient[] = [];

export function addSSEClient(client: SSEClient): void {
  sseClients.push(client);
}

export function removeSSEClient(clientId: string): void {
  const index = sseClients.findIndex((c) => c.id === clientId);
  if (index !== -1) sseClients.splice(index, 1);
}

function broadcastSSE(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const deadClientIds: string[] = [];
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch {
      deadClientIds.push(client.id);
    }
  }
  for (const id of deadClientIds) {
    removeSSEClient(id);
  }
}

async function broadcastUpdate(containerId: string): Promise<void> {
  const container = await getContainer(containerId);
  if (container) {
    broadcastSSE("container-updated", container);
  }
}

export function broadcastRemoval(id: string): void {
  broadcastSSE("container-removed", { id });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout")), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function checkClaudeHealth(containerId: string): Promise<ContainerHealth["claudeCode"]> {
  try {
    const container = docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: ["pgrep", "-f", "claude.*--remote"],
      AttachStdout: true,
      AttachStderr: true,
    });
    const execStream = await exec.start({ Detach: false });
    const output = await withTimeout(
      new Promise<string>((resolve) => {
        let data = "";
        (execStream as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        (execStream as unknown as NodeJS.ReadableStream).on("end", () => resolve(data));
        (execStream as unknown as NodeJS.ReadableStream).on("error", () => resolve(""));
      }),
      HEALTH_CHECK_TIMEOUT_MS,
    );
    return output.trim().length > 0 ? "healthy" : "unhealthy";
  } catch {
    return "unhealthy";
  }
}

export async function runHealthChecks(): Promise<void> {
  const containers = await listContainers();

  const results = await Promise.allSettled(
    containers.map(async (managed) => {
      let containerState: ContainerHealth["container"];
      if (managed.status === "running") {
        containerState = "running";
      } else if (managed.status === "exited" || managed.status === "created") {
        containerState = "stopped";
      } else {
        containerState = "error";
      }

      const claudeCodeState: ContainerHealth["claudeCode"] =
        containerState === "running"
          ? await checkClaudeHealth(managed.id)
          : "unknown";

      const health: ContainerHealth = {
        container: containerState,
        claudeCode: claudeCodeState,
      };

      const prev = healthCache.get(managed.id);
      const changed =
        !prev ||
        prev.container !== health.container ||
        prev.claudeCode !== health.claudeCode;

      healthCache.set(managed.id, health);
      return { id: managed.id, changed };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value.changed) {
      await broadcastUpdate(result.value.id);
    }
  }
}

export function cleanupAll(): void {
  for (const [id] of logWatchers) {
    cleanupLogWatcher(id);
  }
  for (const client of sseClients) {
    try {
      client.res.end();
    } catch { }
  }
  sseClients.length = 0;
}
