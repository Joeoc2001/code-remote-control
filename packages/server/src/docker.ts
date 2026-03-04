import Dockerode from "dockerode";
import crypto from "node:crypto";
import net from "node:net";
import { PassThrough } from "node:stream";
import tar from "tar-stream";
import type {
  ManagedContainer,
  ContainerHealth,
  EnvironmentConfig,
} from "./types.js";
import { GITHUB_TOKEN, CRC_ENV_IMAGE } from "./config.js";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

const CONTAINER_PREFIX = "crc-";
const LABEL_CONFIG_NAME = "crc.config-name";
const LABEL_REPO_NAME = "crc.repo-name";
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const OPENCODE_CONFIG_PATH = "/etc/opencode.json";
const CONTAINER_INTERNAL_PORT = 8080;

const MAX_PORT_ATTEMPTS = 10;

function tryBindPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function findFreePort(): Promise<number> {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = await tryBindPort();
    const portMap = await getPortMap();
    const inUse = [...portMap.values()].includes(port);
    if (!inUse) return port;
  }
  throw new Error("Failed to find a free port after " + MAX_PORT_ATTEMPTS + " attempts");
}

function createSingleFileTar(filePath: string, content: Buffer, mode: number): Promise<Buffer> {
  const pack = tar.pack();
  pack.entry({ name: filePath, mode }, content);
  pack.finalize();

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });
}

const healthCache = new Map<string, ContainerHealth>();
const logWatchers = new Map<string, NodeJS.ReadableStream>();

async function getPortMap(): Promise<Map<string, number>> {
  const containers = await docker.listContainers({
    all: true,
    filters: { name: [CONTAINER_PREFIX] },
  });

  const portMap = new Map<string, number>();
  for (const container of containers) {
    const name = (container.Names[0] || "").replace(/^\//, "");
    if (!name.startsWith(CONTAINER_PREFIX)) continue;

    const portMapping = container.Ports.find(p => p.PrivatePort === CONTAINER_INTERNAL_PORT);
    if (portMapping?.PublicPort) {
      portMap.set(container.Id, portMapping.PublicPort);
    }
  }
  return portMap;
}

export async function getContainerPort(id: string): Promise<number | null> {
  const portMap = await getPortMap();
  return portMap.get(id) ?? null;
}

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
    openCode: "unknown" as const,
  };

  const portMapping = container.Ports.find(p => p.PrivatePort === CONTAINER_INTERNAL_PORT);
  const hostPort = portMapping?.PublicPort ?? 0;

  return {
    id: container.Id,
    name,
    configName,
    repoName,
    status,
    health,
    hostPort,
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
      openCode: "unknown" as const,
    };

    const portKey = `${CONTAINER_INTERNAL_PORT}/tcp`;
    const bindings = info.NetworkSettings?.Ports?.[portKey];
    const hostPort = bindings?.[0]?.HostPort ? parseInt(bindings[0].HostPort, 10) : 0;

    return {
      id: info.Id,
      name,
      configName,
      repoName,
      status,
      health,
      hostPort,
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
  const hostPort = await findFreePort();

  const envVars = [
    `REPO_URL=${repoUrl}`,
    `GITHUB_TOKEN=${GITHUB_TOKEN}`,
    `OPENCODE_CONFIG=${OPENCODE_CONFIG_PATH}`,
    ...Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`),
  ];

  const portKey = `${CONTAINER_INTERNAL_PORT}/tcp`;

  const container = await docker.createContainer({
    Image: CRC_ENV_IMAGE,
    name: containerName,
    Env: envVars,
    Labels: {
      [LABEL_CONFIG_NAME]: config.name,
      [LABEL_REPO_NAME]: repoFullName,
    },
    ExposedPorts: { [portKey]: {} },
    HostConfig: {
      AutoRemove: false,
      PortBindings: {
        [portKey]: [{ HostPort: String(hostPort) }],
      },
    },
  });

  const configJson = Buffer.from(JSON.stringify(config.opencode));
  const configTar = await createSingleFileTar("etc/opencode.json", configJson, 0o444);
  await container.putArchive(configTar, { path: "/" });

  await container.start();

  const info = await container.inspect();
  return {
    id: info.Id,
    name: containerName,
    configName: config.name,
    repoName: repoFullName,
    status: "running",
    health: { container: "running", openCode: "unknown" },
    hostPort,
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

async function checkOpencodeHealth(containerId: string): Promise<ContainerHealth["openCode"]> {
  try {
    const container = docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: ["pgrep", "-f", "opencode.*--remote"],
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

      const opencodeState: ContainerHealth["openCode"] =
        containerState === "running"
          ? await checkOpencodeHealth(managed.id)
          : "unknown";

      const health: ContainerHealth = {
        container: containerState,
        openCode: opencodeState,
      };

      const prev = healthCache.get(managed.id);
      const changed =
        !prev ||
        prev.container !== health.container ||
        prev.openCode !== health.openCode;

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

export async function updateAndRestartSystem(): Promise<void> {
  const IMAGE_1 = "ghcr.io/joeoc2001/code-remote-control:latest";
  const IMAGE_2 = "ghcr.io/joeoc2001/code-remote-control-env:latest";
  const CONTAINER_NAME = "code-remote-control";

  async function pullImage(imageName: string): Promise<void> {
    console.log(`Pulling image: ${imageName}`);
    const stream = await docker.pull(imageName);
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err, _output) => {
        if (err) reject(err);
        else resolve(undefined);
      });
    });
    console.log(`Successfully pulled: ${imageName}`);
  }

  async function pruneOldImages(imageRepo: string): Promise<void> {
    console.log(`Pruning old versions of: ${imageRepo}`);
    const images = await docker.listImages();
    const repoPrefix = imageRepo.split(":")[0];

    for (const image of images) {
      if (!image.RepoTags) continue;
      for (const tag of image.RepoTags) {
        if (tag.startsWith(repoPrefix) && tag !== imageRepo) {
          try {
            console.log(`Removing old image: ${tag}`);
            await docker.getImage(tag).remove({ force: false });
          } catch (err) {
            console.warn(`Failed to remove image ${tag}:`, err);
          }
        }
      }
    }
  }

  async function restartSelfContainer(): Promise<void> {
    console.log(`Finding container: ${CONTAINER_NAME}`);
    const containers = await docker.listContainers({ all: true });
    const selfContainer = containers.find((c) =>
      c.Names.some((name) => name === `/${CONTAINER_NAME}` || name === CONTAINER_NAME)
    );

    if (!selfContainer) {
      throw new Error(`Container ${CONTAINER_NAME} not found`);
    }

    const selfDockerContainer = docker.getContainer(selfContainer.Id);
    const info = await selfDockerContainer.inspect();

    console.log("Creating replacement container");
    const tempName = `${CONTAINER_NAME}-next`;
    const newContainer = await docker.createContainer({
      Image: IMAGE_1,
      name: tempName,
      Env: info.Config.Env ?? [],
      Labels: info.Config.Labels ?? {},
      ExposedPorts: info.Config.ExposedPorts,
      WorkingDir: info.Config.WorkingDir,
      User: info.Config.User,
      Hostname: info.Config.Hostname,
      HostConfig: {
        Binds: info.HostConfig.Binds ?? [],
        PortBindings: info.HostConfig.PortBindings ?? {},
        NetworkMode: info.HostConfig.NetworkMode,
        RestartPolicy: info.HostConfig.RestartPolicy,
        Privileged: info.HostConfig.Privileged ?? false,
        CapAdd: info.HostConfig.CapAdd ?? [],
        CapDrop: info.HostConfig.CapDrop ?? [],
      },
    });

    const helperScript = `
      const http = require('http');
      const OLD_ID = process.env.OLD_ID;
      const NEW_ID = process.env.NEW_ID;
      const NEW_NAME = process.env.NEW_NAME;
      const SELF_NAME = process.env.SELF_NAME;
      function call(method, path) {
        return new Promise((resolve, reject) => {
          const req = http.request({ socketPath: '/var/run/docker.sock', method, path }, res => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          });
          req.on('error', reject);
          req.end();
        });
      }
      async function main() {
        await new Promise(r => setTimeout(r, 3000));
        console.log('Stopping old container...');
        await call('POST', '/containers/' + OLD_ID + '/stop');
        console.log('Renaming old container...');
        await call('POST', '/containers/' + OLD_ID + '/rename?name=' + OLD_ID + '-old');
        console.log('Renaming new container...');
        await call('POST', '/containers/' + NEW_ID + '/rename?name=' + NEW_NAME);
        console.log('Starting new container...');
        const startStatus = await call('POST', '/containers/' + NEW_ID + '/start');
        if (startStatus >= 400) {
          throw new Error('Failed to start new container (status ' + startStatus + '), old container preserved for log inspection');
        }
        console.log('Removing old container...');
        await call('DELETE', '/containers/' + OLD_ID + '?v=true');
        console.log('Removing helper container...');
        call('DELETE', '/containers/' + SELF_NAME + '?v=true&force=true');
        console.log('Restart complete');
      }
      main().catch(e => { console.error(e.message); process.exit(1); });
    `.trim();

    console.log("Starting restart helper");
    const helperName = `${CONTAINER_NAME}-helper-${generateId()}`;
    const helperContainer = await docker.createContainer({
      Image: IMAGE_1,
      name: helperName,
      Entrypoint: ["node"],
      Cmd: ["-e", helperScript],
      Env: [
        `OLD_ID=${selfContainer.Id}`,
        `NEW_ID=${newContainer.id}`,
        `NEW_NAME=${CONTAINER_NAME}`,
        `SELF_NAME=${helperName}`,
      ],
      HostConfig: {
        AutoRemove: false,
        Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
      },
    });
    await helperContainer.start();

    console.log("Restart initiated");
  }

  setTimeout(async () => {
    try {
      await pullImage(IMAGE_1);
      await pullImage(IMAGE_2);
      await pruneOldImages(IMAGE_1);
      await pruneOldImages(IMAGE_2);
      await restartSelfContainer();
    } catch (err) {
      console.error("Update and restart failed:", err);
    }
  }, 1000);
}
