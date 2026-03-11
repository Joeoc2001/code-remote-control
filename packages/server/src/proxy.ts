import type { Request, Response, NextFunction } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { ROOT_DOMAIN } from "./config.js";
import { listContainers } from "./docker.js";

export async function proxyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!ROOT_DOMAIN) {
    next();
    return;
  }

  const host = req.get("host");
  if (!host) {
    next();
    return;
  }

  const rootDomainPattern = ROOT_DOMAIN.replace(/\./g, "\\.");
  const subdomainMatch = host.match(new RegExp(`^(.+)\\.${rootDomainPattern}$`, "i"));

  if (!subdomainMatch) {
    next();
    return;
  }

  const subdomain = subdomainMatch[1];
  const containers = await listContainers();
  const container = containers.find(c => c.subdomain === subdomain);

  if (!container || !container.hostPort) {
    res.status(404).json({ error: "Container not found" });
    return;
  }

  const proxy = createProxyMiddleware({
    target: `http://localhost:${container.hostPort}`,
    changeOrigin: true,
    ws: true,
  });

  proxy(req, res, next);
}
