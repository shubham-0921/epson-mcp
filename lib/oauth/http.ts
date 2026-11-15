// Shared HTTP helpers for the OAuth and MCP routes.

export const SCOPE = "print";

/** Public origin of this deployment (used as the OAuth issuer). */
export function baseUrl(request: Request): string {
  if (process.env.MCP_PUBLIC_URL) return process.env.MCP_PUBLIC_URL.replace(/\/$/, "");
  const u = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? u.host;
  const proto = request.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export const mcpResourceUrl = (request: Request) => `${baseUrl(request)}/api/mcp`;
export const resourceMetadataUrl = (request: Request) => `${baseUrl(request)}/.well-known/oauth-protected-resource/api/mcp`;

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, mcp-protocol-version",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...headers },
  });
}

export const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

export const preflight = () => new Response(null, { status: 204, headers: CORS });

/** Reads a form-encoded or JSON body into a flat string map. */
export async function readParams(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]));
  }
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

export const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A minimal standalone page (consent, errors). Can't be framed. */
export function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{--fg:#0f172a;--muted:#5b6476;--bg:#f5f6fa;--card:#fff;--line:#dfe3ec;--accent:#1747d4}
@media (prefers-color-scheme:dark){:root{--fg:#e6eaf5;--muted:#9aa3b8;--bg:#0a0e1a;--card:#121828;--line:#243049;--accent:#5b82ff}}
body{font:15px/1.55 system-ui,-apple-system,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:12vh 16px}
main{max-width:460px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 8px}p{margin:8px 0;color:var(--muted)}b{color:var(--fg)}
ul{padding-left:18px;color:var(--muted)}.row{display:flex;gap:10px;margin-top:20px}
button{font:inherit;padding:9px 16px;border-radius:9px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
code{font-size:13px;word-break:break-all}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/** Redirect back to the OAuth client with params. */
export function redirectTo(uri: string, params: Record<string, string | undefined>) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.toString(), "Cache-Control": "no-store" } });
}

/** https anywhere, or http only on a loopback host (native apps, RFC 8252). */
export function isAllowedRedirectUri(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}
