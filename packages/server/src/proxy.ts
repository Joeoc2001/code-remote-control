import type { Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import httpProxy from "http-proxy";
import { createProxyMiddleware } from "http-proxy-middleware";
import { loadConfigurations } from "./config.js";
import { listContainers, CONTAINER_INTERNAL_PORT } from "./docker.js";

async function resolveTarget(host: string | undefined): Promise<string | null> {
  if (!host) return null;

  const config = await loadConfigurations();
  const rootDomain = config.root_domain;
  if (!rootDomain) return null;

  const rootDomainPattern = rootDomain.replace(/\./g, "\\.");
  const subdomainMatch = host.match(new RegExp(`^(.+)\\.${rootDomainPattern}$`, "i"));
  if (!subdomainMatch) return null;

  const subdomain = subdomainMatch[1];
  const containers = await listContainers();
  const container = containers.find(c => c.subdomain === subdomain);
  if (!container) return null;

  return `http://${container.name}:${CONTAINER_INTERNAL_PORT}`;
}

export async function proxyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const target = await resolveTarget(req.get("host"));
  if (!target) {
    next();
    return;
  }

  createProxyMiddleware({ target, changeOrigin: true })(req, res, next);
}

export async function wsUpgradeHandler(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
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
}
