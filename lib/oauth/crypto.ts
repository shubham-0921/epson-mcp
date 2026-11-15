// Token generation, hashing and AES-256-GCM encryption for stored Epson tokens.

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Tokens are stored by hash, so a Redis leak doesn't reveal usable tokens. */
export const hashToken = (t: string) => createHash("sha256").update(t).digest("base64url");

/** PKCE S256 check. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

function key(): Buffer {
  const explicit = process.env.MCP_ENCRYPTION_KEY;
  if (explicit) {
    const k = Buffer.from(explicit, "base64");
    if (k.length !== 32) throw new Error("MCP_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
    return k;
  }
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Set MCP_ENCRYPTION_KEY (or SESSION_SECRET, 32+ chars) to encrypt stored tokens.");
  return createHash("sha256").update(`epson-mcp-token-encryption:${secret}`).digest();
}

export function encrypt(value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

export function decrypt<T>(blob: string): T {
  const [iv, tag, ct] = blob.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8")) as T;
}
