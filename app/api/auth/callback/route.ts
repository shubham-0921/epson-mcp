import { NextResponse } from "next/server";
import { getSession } from "@/lib/server/session";
import { collector, makeClient, toErrorPayload } from "@/lib/server/epson";
import { redactUrl } from "@/lib/epson/redact";
import { handleMcpEpsonCallback } from "@/lib/oauth/epson-callback";
import type { ApiLogEntry } from "@/lib/epson/types";

// Epson redirects here with ?code&iss&state. Verify state, then run Call A.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const epsonError = url.searchParams.get("error");
  // Sign-in started by `npm run mcp:login` (local MCP server): show the one-time code
  // for pasting into the terminal. No session, no token exchange here — the code is
  // useless without the client secret, and the CLI checks the state.
  if (state?.startsWith("cli_")) return cliCodePage(state, code, epsonError);
  // Sign-in started by Claude connecting to the remote MCP server (/oauth/authorize).
  if (state?.startsWith("mcp_")) return handleMcpEpsonCallback(state, code, epsonError);

  const session = await getSession();
  const home = new URL("/", request.url);

  const client = makeClient();
  const authorizeEntry: ApiLogEntry = {
    id: `auth-${Date.now().toString(36)}`,
    step: "authorize",
    label: "0 · Authorize (browser redirect)",
    method: "GET",
    url: redactUrl(client.authorizeUrl(state ?? "")),
    request: { headers: {}, body: undefined },
    response: {
      status: 302,
      headers: { location: redactUrl(request.url) },
      body: Object.fromEntries([...new URL(redactUrl(request.url)).searchParams.entries()]),
    },
    status: code && !epsonError ? "success" : "error",
    startedAt: new Date().toISOString(),
    durationMs: 0,
    error: epsonError ?? undefined,
  };

  if (!state || state !== session.oauthState) {
    delete session.oauthState;
    session.pendingLog = [{ ...authorizeEntry, status: "error", error: "OAuth state mismatch (possible CSRF) — sign-in rejected" }];
    await session.save();
    home.searchParams.set("error", "state_mismatch");
    return NextResponse.redirect(home);
  }
  delete session.oauthState;

  if (!code || epsonError) {
    session.pendingLog = [authorizeEntry];
    await session.save();
    home.searchParams.set("error", epsonError ?? "missing_code");
    return NextResponse.redirect(home);
  }

  const log = collector();
  client.onLog = log.sink;
  try {
    session.tokens = await client.exchangeCode(code);
  } catch (err) {
    home.searchParams.set("error", toErrorPayload(err).error);
  }
  session.pendingLog = [authorizeEntry, ...log.entries()];
  await session.save();
  return NextResponse.redirect(home);
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function cliCodePage(state: string, code: string | null, error: string | null) {
  const ok = !!code && !error && /^cli_[a-f0-9]{24}$/.test(state);
  const value = ok ? esc(`${state}:${code}`) : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Epson sign-in code</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 16px;color:#0f172a;background:#f5f6fa}
@media (prefers-color-scheme:dark){body{color:#e6eaf5;background:#0a0e1a}code{background:#172033!important}}
code{display:block;word-break:break-all;background:#e8ecf5;padding:12px;border-radius:8px;font-size:13px;margin:12px 0}
button{font:inherit;padding:8px 14px;border-radius:8px;border:0;background:#1747d4;color:#fff;cursor:pointer}</style></head><body>
${ok ? `<h1>Paste this code into your terminal</h1><p>Your terminal is waiting for it (<b>npm run mcp:login</b>). It works once and expires in a few minutes.</p>
<code id="c">${value}</code><button onclick="navigator.clipboard.writeText(document.getElementById('c').textContent);this.textContent='Copied'">Copy code</button>
<p style="opacity:.7">You can close this tab afterwards.</p>`
  : `<h1>Sign-in didn't complete</h1><p>${esc(error ?? "Epson didn't return a code.")} Run <b>npm run mcp:login</b> again.</p>`}
</body></html>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
