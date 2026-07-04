import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import httpProxy from "http-proxy";
import { createProxyMiddleware } from "http-proxy-middleware";
import { loadConfigurations } from "./config.js";
import { listContainers, CONTAINER_INTERNAL_PORT } from "./docker.js";
import { isWebSocketAuthorized } from "./auth.js";

const TARGET_CACHE_TTL_MS = 5000;

const targetCache = new Map<string, { target: string | null; expiresAt: number }>();
const proxyCache = new Map<string, RequestHandler>();

function hostname(host: string | undefined): string | null {
  if (!host) return null;
  return host.split(":")[0].toLowerCase();
}

async function computeTarget(host: string): Promise<string | null> {
  const config = await loadConfigurations();
  const rootDomain = config.root_domain;
  if (!rootDomain) return null;

  const rootDomainPattern = rootDomain.replace(/\./g, "\\.");
  const subdomainMatch = host.match(new RegExp(`^(.+)\\.${rootDomainPattern}$`, "i"));
  if (!subdomainMatch) return null;

  const subdomain = subdomainMatch[1];
  const containers = await listContainers();
  const container = containers.find((c) => c.subdomain === subdomain);
  if (!container) return null;

  return `http://${container.name}:${CONTAINER_INTERNAL_PORT}`;
}

async function resolveTarget(host: string | undefined): Promise<string | null> {
  const name = hostname(host);
  if (!name) return null;

  const cached = targetCache.get(name);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.target;
  }

  const target = await computeTarget(name);
  targetCache.set(name, { target, expiresAt: Date.now() + TARGET_CACHE_TTL_MS });
  return target;
}

function proxyFor(target: string): RequestHandler {
  let handler = proxyCache.get(target);
  if (!handler) {
    handler = createProxyMiddleware({ target, changeOrigin: true });
    proxyCache.set(target, handler);
  }
  return handler;
}

export async function proxyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const target = await resolveTarget(req.get("host"));
    if (!target) {
      next();
      return;
    }
    proxyFor(target)(req, res, next);
  } catch (err) {
    next(err);
  }
}

export async function wsUpgradeHandler(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
  try {
    if (!isWebSocketAuthorized(req)) {
      socket.destroy();
      return;
    }

    const target = await resolveTarget(req.headers.host);
    if (!target) {
      socket.destroy();
      return;
    }

    const proxy = httpProxy.createProxyServer();
    proxy.ws(req, socket, head, { target });
    proxy.on("error", (err) => {
      console.error("WS proxy error:", err);
      socket.destroy();
    });
  } catch (err) {
    console.error("WS upgrade error:", err);
    socket.destroy();
  }
}
