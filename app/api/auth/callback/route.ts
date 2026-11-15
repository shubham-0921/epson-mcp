import { NextResponse } from "next/server";
import { getSession } from "@/lib/server/session";
import { collector, makeClient, toErrorPayload } from "@/lib/server/epson";
import { redactUrl } from "@/lib/epson/redact";
import type { ApiLogEntry } from "@/lib/epson/types";

// Epson redirects here with ?code&iss&state. Verify state, then run Call A.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const epsonError = url.searchParams.get("error");
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
