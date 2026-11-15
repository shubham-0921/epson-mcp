// Remote Epson Print MCP server (Streamable HTTP, stateless). Each request is
// authenticated with our OAuth access token, which maps to one printer connection.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { makeClient } from "@/lib/server/epson";
import { registerEpsonTools } from "@/lib/mcp/tools";
import { connectionTokenStore } from "@/lib/mcp/token-store";
import { CORS, preflight, resourceMetadataUrl } from "@/lib/oauth/http";
import { countPrint, verifyAccessToken } from "@/lib/oauth/store";
import type { ApiLogEntry } from "@/lib/epson/types";

export const maxDuration = 120; // job-status waits are capped at 50s

const PRINTS_PER_HOUR = 20;

const INSTRUCTIONS =
  "Prints on the user's Epson printer through Epson Connect. Confirm with the user before calling print_document. " +
  "After printing, use get_print_job_status with wait_seconds to report when the job is done.";

function unauthorized(request: Request, error?: string) {
  const params = [`resource_metadata="${resourceMetadataUrl(request)}"`];
  if (error) params.push(`error="${error}"`);
  return new Response(JSON.stringify({ error: error ?? "unauthorized", error_description: "Connect your Epson printer to use this server." }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": `Bearer ${params.join(", ")}`, ...CORS, "Access-Control-Expose-Headers": "WWW-Authenticate" },
  });
}

async function handle(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return unauthorized(request);
  const grant = await verifyAccessToken(token);
  if (!grant) return unauthorized(request, "invalid_token");

  const connId = grant.connId;
  const tag = connId.slice(0, 6);
  // Redacted, one line per finished Epson call, tagged with the connection.
  const onLog = (e: ApiLogEntry) => {
    if (e.status === "running") return;
    console.log(`[mcp ${tag}] ${e.label} · ${e.method} ${e.url} → ${e.response?.status ?? "ERR"} ${e.durationMs ?? 0}ms${e.error ? ` (${e.error})` : ""}`);
  };

  const server = new McpServer({ name: "epson-print", version: "0.2.0" }, { instructions: INSTRUCTIONS });
  registerEpsonTools(server, {
    makeClient,
    store: connectionTokenStore(connId, (rt) => makeClient(onLog).refresh(rt)),
    onLog,
    reconnectHint: "The Epson connection has expired or was revoked. Ask the user to reconnect the Epson Print connector in Claude's settings.",
    beforePrint: async () =>
      (await countPrint(connId)) > PRINTS_PER_HOUR
        ? `Print limit reached: at most ${PRINTS_PER_HOUR} print jobs per hour for this printer connection. Try again later.`
        : null,
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  const response = await transport.handleRequest(request, {
    authInfo: { token, clientId: grant.clientId, scopes: grant.scope.split(" "), expiresAt: grant.exp, extra: { connId } },
  });
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const OPTIONS = preflight;
