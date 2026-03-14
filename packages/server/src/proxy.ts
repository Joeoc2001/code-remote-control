import type { Request, Response, NextFunction } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { loadConfigurations } from "./config.js";
import { listContainers, CONTAINER_INTERNAL_PORT } from "./docker.js";

export async function proxyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const config = await loadConfigurations();
  const rootDomain = config.root_domain;

  if (!rootDomain) {
    next();
    return;
  }

  const host = req.get("host");
  if (!host) {
    next();
    return;
  }

  const rootDomainPattern = rootDomain.replace(/\./g, "\\.");
  const subdomainMatch = host.match(new RegExp(`^(.+)\\.${rootDomainPattern}$`, "i"));

  if (!subdomainMatch) {
    next();
    return;
  }

  const subdomain = subdomainMatch[1];
  const containers = await listContainers();
  const container = containers.find(c => c.subdomain === subdomain);

  if (!container) {
    res.status(404).json({ error: "Container not found" });
    return;
  }

  const proxy = createProxyMiddleware({
    target: `http://${container.name}:${CONTAINER_INTERNAL_PORT}`,
    changeOrigin: true,
    ws: true,
  });

  proxy(req, res, next);
}
