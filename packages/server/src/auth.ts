import type { Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "node:http";
import crypto from "node:crypto";
import { loadConfigurations } from "./config.js";

const ACCESS_TOKEN = process.env.CRC_ACCESS_TOKEN || "";
const COOKIE_NAME = "crc_access";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function isAuthEnabled(): boolean {
  return ACCESS_TOKEN.length > 0;
}

function safeEqual(provided: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(ACCESS_TOKEN);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function hasValidCookie(cookieHeader: string | undefined): boolean {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[COOKIE_NAME];
  return typeof token === "string" && safeEqual(token);
}

function hasValidBearer(authorization: string | undefined): boolean {
  if (!authorization || !authorization.startsWith("Bearer ")) return false;
  return safeEqual(authorization.slice("Bearer ".length));
}

export function isWebSocketAuthorized(req: IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;
  return hasValidCookie(req.headers.cookie) || hasValidBearer(req.headers.authorization);
}

function stripAccessToken(originalUrl: string): string {
  const [path, query] = originalUrl.split("?");
  if (!query) return path || "/";
  const params = new URLSearchParams(query);
  params.delete("access_token");
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path || "/";
}

async function cookieDomain(): Promise<string | undefined> {
  const config = await loadConfigurations();
  return config.root_domain ? `.${config.root_domain}` : undefined;
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isAuthEnabled()) {
    next();
    return;
  }

  try {
    if (hasValidCookie(req.headers.cookie) || hasValidBearer(req.headers.authorization)) {
      next();
      return;
    }

    const queryToken = req.query.access_token;
    if (typeof queryToken === "string" && safeEqual(queryToken)) {
      res.cookie(COOKIE_NAME, ACCESS_TOKEN, {
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        domain: await cookieDomain(),
        path: "/",
        maxAge: COOKIE_MAX_AGE_MS,
      });
      if (req.method === "GET") {
        res.redirect(stripAccessToken(req.originalUrl));
        return;
      }
      next();
      return;
    }

    res.status(401).json({ error: "Unauthorized" });
  } catch (err) {
    next(err);
  }
}
