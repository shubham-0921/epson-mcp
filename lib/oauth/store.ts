// OAuth records for the remote MCP server: registered clients, pending
// authorization requests, one-time codes, access/refresh tokens and printer
// connections (encrypted Epson tokens).

import type { TokenSet } from "../epson/types";
import { decrypt, encrypt, hashToken, randomToken } from "./crypto";
import { kv } from "./kv";

export const ACCESS_TTL = 60 * 60; // 1 hour
export const REFRESH_TTL = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL = 5 * 60;
const AUTHREQ_TTL = 10 * 60;
const CONN_TTL = 60 * 60 * 24 * 60; // renewed on every Epson token write

// ---------- clients (dynamic registration, public clients with PKCE) ----------

export type OAuthClient = { client_id: string; client_name?: string; redirect_uris: string[]; client_id_issued_at: number };

export async function registerClient(input: { redirect_uris: string[]; client_name?: string }): Promise<OAuthClient> {
  const client: OAuthClient = {
    client_id: `mcp_${randomToken(18)}`,
    client_name: input.client_name,
    redirect_uris: input.redirect_uris,
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
  await kv().set(`oauth:client:${client.client_id}`, client, { ex: 60 * 60 * 24 * 365 });
  return client;
}

export const getClient = (id: string) => kv().get<OAuthClient>(`oauth:client:${id}`);

// ---------- authorization requests (between /oauth/authorize and the Epson callback) ----------

export type AuthRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope: string;
  resource?: string;
};

/** Returns the id used as the Epson `state`. The `mcp_` prefix routes the shared Epson callback. */
export async function saveAuthRequest(req: AuthRequest): Promise<string> {
  const id = `mcp_${randomToken(24)}`;
  await kv().set(`oauth:authreq:${id}`, req, { ex: AUTHREQ_TTL });
  return id;
}

export const getAuthRequest = (id: string) => kv().get<AuthRequest>(`oauth:authreq:${id}`);
export const takeAuthRequest = (id: string) => kv().take<AuthRequest>(`oauth:authreq:${id}`);

// ---------- codes ----------

export type CodeRecord = AuthRequest & { connId: string };

export async function issueCode(rec: CodeRecord): Promise<string> {
  const code = randomToken();
  await kv().set(`oauth:code:${hashToken(code)}`, rec, { ex: CODE_TTL });
  return code;
}

export const takeCode = (code: string) => kv().take<CodeRecord>(`oauth:code:${hashToken(code)}`);

// ---------- access and refresh tokens ----------

export type Grant = { connId: string; clientId: string; scope: string; resource?: string };
export type AccessGrant = Grant & { exp: number };

export async function issueTokens(g: Grant) {
  const access_token = randomToken();
  const refresh_token = randomToken();
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL;
  await kv().set(`oauth:at:${hashToken(access_token)}`, { ...g, exp } satisfies AccessGrant, { ex: ACCESS_TTL });
  await kv().set(`oauth:rt:${hashToken(refresh_token)}`, g, { ex: REFRESH_TTL });
  return { access_token, token_type: "Bearer" as const, expires_in: ACCESS_TTL, refresh_token, scope: g.scope };
}

/** Valid only while the printer connection still exists. */
export async function verifyAccessToken(token: string): Promise<AccessGrant | null> {
  const g = await kv().get<AccessGrant>(`oauth:at:${hashToken(token)}`);
  if (!g || g.exp * 1000 < Date.now()) return null;
  return (await connectionExists(g.connId)) ? g : null;
}

/** Single use: the old refresh token is consumed and a new pair is issued. */
export async function rotateRefreshToken(token: string, clientId: string) {
  const g = await kv().take<Grant>(`oauth:rt:${hashToken(token)}`);
  if (!g || g.clientId !== clientId || !(await connectionExists(g.connId))) return null;
  return issueTokens(g);
}

// ---------- printer connections ----------

export type ConnectionMeta = { clientId: string; clientName?: string; productName: string; serialNumber: string; createdAt: string };

export async function createConnection(tokens: TokenSet, meta: ConnectionMeta): Promise<string> {
  const id = randomToken(16);
  await kv().set(`conn:${id}:meta`, meta, { ex: CONN_TTL });
  await writeConnectionTokens(id, tokens);
  return id;
}

export async function readConnectionTokens(id: string): Promise<TokenSet | null> {
  const blob = await kv().get<string>(`conn:${id}:tokens`);
  return blob ? decrypt<TokenSet>(blob) : null;
}

export async function writeConnectionTokens(id: string, tokens: TokenSet) {
  await kv().set(`conn:${id}:tokens`, encrypt(tokens), { ex: CONN_TTL });
}

export const connectionExists = async (id: string) => (await kv().get(`conn:${id}:tokens`)) !== null;
export const getConnectionMeta = (id: string) => kv().get<ConnectionMeta>(`conn:${id}:meta`);

/** Deletes the Epson tokens; every access and refresh token for the connection stops working. */
export async function deleteConnection(id: string) {
  await kv().del(`conn:${id}:tokens`);
  await kv().del(`conn:${id}:meta`);
}

// ---------- refresh lock and rate limit ----------

export const acquireLock = (name: string, seconds = 10) => kv().set(`lock:${name}`, 1, { ex: seconds, nx: true });
export const releaseLock = (name: string) => kv().del(`lock:${name}`);

export async function countPrint(connId: string): Promise<number> {
  const hour = new Date().toISOString().slice(0, 13);
  return kv().incr(`rate:print:${connId}:${hour}`, 60 * 60);
}
