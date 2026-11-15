// Epson Print MCP server — local stdio transport (Phase 1).
// Claude Desktop launches this; stdout carries MCP messages, so all logging goes to stderr.
console.log = console.error;

import "./env.mts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EpsonClient } from "../lib/epson/client";
import { createMockTransport } from "../lib/epson/mock";
import { epsonConfigFromEnv, isMockEnv } from "../lib/epson/env";
import { fileTokenStore, mockTokenStore } from "../lib/mcp/file-store";
import { registerEpsonTools } from "../lib/mcp/tools";
import type { ApiLogEntry } from "../lib/epson/types";

const mock = isMockEnv();
const config = epsonConfigFromEnv();
const store = mock ? mockTokenStore() : fileTokenStore();

// Redacted, one line per finished Epson call.
const onLog = (e: ApiLogEntry) => {
  if (e.status === "running") return;
  console.error(`[epson] ${e.label} · ${e.method} ${e.url} → ${e.response?.status ?? "ERR"} ${e.durationMs ?? 0}ms${e.error ? ` (${e.error})` : ""}`);
};

const server = new McpServer({ name: "epson-print", version: "0.1.0" }, { instructions:
  "Prints on the user's Epson printer through Epson Connect. Confirm with the user before calling print_document. " +
  "After printing, use get_print_job_status with wait_seconds to report when the job is done." });

registerEpsonTools(server, {
  makeClient: (log) => new EpsonClient(config, { onLog: log, transport: mock ? createMockTransport() : undefined }),
  store,
  onLog,
  reconnectHint: "Run `npm run mcp:login` in the epson project folder, then try again.",
});

await server.connect(new StdioServerTransport());
console.error(`[epson-print] MCP server ready on stdio${mock ? " (MOCK MODE)" : ""}`);
