// TokenStore for one printer connection, backed by the encrypted Redis record.
// Epson replaces the refresh token on every refresh, so two tool calls refreshing
// at once would break the connection: refreshes happen inside get() under a short
// Redis lock, and whoever waits re-reads the tokens the lock holder wrote.

import type { TokenSet, TokenStore } from "../epson/types";
import { acquireLock, deleteConnection, readConnectionTokens, releaseLock, writeConnectionTokens } from "../oauth/store";

const REFRESH_MARGIN_MS = 90_000; // a bit more than the client's own 60s, so the client rarely refreshes itself
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fresh = (t: TokenSet | null) => !!t && t.expiresAt - Date.now() > REFRESH_MARGIN_MS;
const isAuthRejection = (err: unknown) =>
  err instanceof Error && err.name === "EpsonApiError" && [400, 401].includes((err as Error & { status?: number }).status ?? 0);

export function connectionTokenStore(connId: string, refresh: (refreshToken: string) => Promise<TokenSet>): TokenStore {
  return {
    async get() {
      let tokens = await readConnectionTokens(connId);
      if (!tokens || fresh(tokens)) return tokens;

      const lock = `refresh:${connId}`;
      if (await acquireLock(lock)) {
        try {
          tokens = await readConnectionTokens(connId); // someone may have refreshed before we got the lock
          if (!tokens || fresh(tokens)) return tokens;
          try {
            const next = await refresh(tokens.refreshToken);
            await writeConnectionTokens(connId, next);
            return next;
          } catch (err) {
            if (isAuthRejection(err)) {
              await deleteConnection(connId); // Epson refused: sign-in needed again
              return null;
            }
            throw err;
          }
        } finally {
          await releaseLock(lock);
        }
      }

      // Another call is refreshing: wait for its result (up to ~10s).
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        tokens = await readConnectionTokens(connId);
        if (!tokens || fresh(tokens)) return tokens;
      }
      return tokens;
    },
    async set(tokens) {
      if (tokens) await writeConnectionTokens(connId, tokens);
      else await deleteConnection(connId);
    },
  };
}
