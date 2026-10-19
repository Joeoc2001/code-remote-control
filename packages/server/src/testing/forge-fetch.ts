import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RecordedRequest {
  method: string;
  url: string;
  token: string;
  body: unknown;
}

export interface StubResponse {
  status?: number;
  json?: unknown;
  text?: string;
}

export type Route = (request: RecordedRequest) => StubResponse | null;

export function writeTestConfig(config: Record<string, unknown>): string {
  const path = join(mkdtempSync(join(tmpdir(), "crc-config-")), "environments.json");
  writeFileSync(path, JSON.stringify({
    root_domain: "test.localhost",
    git: { email: "bot@example.com", username: "bot" },
    configurations: [],
    ...config,
  }));
  return path;
}

function requestToken(headers: Record<string, string>): string {
  if (headers["PRIVATE-TOKEN"] !== undefined) return headers["PRIVATE-TOKEN"];
  const authorization = headers.Authorization;
  if (!authorization?.startsWith("Bearer ")) throw new Error(`Request carried no token: ${JSON.stringify(headers)}`);
  return authorization.slice("Bearer ".length);
}

export function stubFetch(routes: Route[]): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const request: RecordedRequest = {
      method: init.method ?? "GET",
      url: String(input),
      token: requestToken((init.headers ?? {}) as Record<string, string>),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    for (const route of routes) {
      const response = route(request);
      if (response) {
        return new Response(response.text ?? JSON.stringify(response.json ?? {}), {
          status: response.status ?? 200,
          statusText: response.status === undefined ? "OK" : "Error",
        });
      }
    }
    throw new Error(`No stubbed response for ${request.method} ${request.url}`);
  }) as typeof fetch;
  return requests;
}
