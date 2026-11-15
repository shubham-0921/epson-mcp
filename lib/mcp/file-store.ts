// Local TokenStore for the stdio MCP server (Phase 1). Tokens live in a 0600 JSON
// file outside the repo; Phase 2 replaces this with an encrypted Redis store.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TokenSet, TokenStore } from "../epson/types";

export const defaultTokenFile = () =>
  process.env.EPSON_MCP_TOKEN_FILE || join(homedir(), ".config", "epson-print-mcp", "tokens.json");

export function fileTokenStore(path = defaultTokenFile()): TokenStore & { path: string; clear(): void } {
  return {
    path,
    get() {
      if (!existsSync(path)) return null;
      try {
        const t = JSON.parse(readFileSync(path, "utf8")) as TokenSet;
        return t.accessToken && t.refreshToken ? t : null;
      } catch {
        return null;
      }
    },
    set(tokens) {
      if (!tokens) return this.clear();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
      chmodSync(path, 0o600);
    },
    clear() {
      rmSync(path, { force: true });
    },
  };
}

/** Mock mode: always-valid fake tokens kept in memory, so no login is needed. */
export function mockTokenStore(): TokenStore {
  let tokens: TokenSet | null = { accessToken: "mock-access-token-0000", refreshToken: "mock-refresh-token-0000", expiresAt: Date.now() + 3600_000 };
  return { get: () => tokens, set: (t) => void (tokens = t) };
}
