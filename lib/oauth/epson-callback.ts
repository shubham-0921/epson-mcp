// Epson's sign-in returns here (via /api/auth/callback) for Claude connections,
// recognised by a state starting with "mcp_". Swap the Epson code for tokens,
// store them as a new printer connection, and send our own code back to Claude.

import { makeClient } from "@/lib/server/epson";
import { recordUsage } from "@/lib/analytics/usage";
import { esc, page, redirectTo } from "./http";
import { createConnection, getClient, issueCode, takeAuthRequest } from "./store";

export async function handleMcpEpsonCallback(state: string, code: string | null, epsonError: string | null) {
  const req = await takeAuthRequest(state);
  if (!req) return page("Can't connect", "<h1>This sign-in has expired</h1><p>Start again from Claude's connector settings.</p>", 400);

  if (epsonError || !code) {
    await recordUsage({ type: "connect_failed", error: epsonError ? `Epson sign-in: ${epsonError}` : "No code from Epson" });
    return redirectTo(req.redirectUri, {
      error: "access_denied",
      error_description: epsonError ? `Epson sign-in failed: ${epsonError}` : "Epson didn't return a code.",
      state: req.state,
    });
  }

  const log = (e: { status: string; label: string; response?: { status: number }; durationMs?: number }) => {
    if (e.status !== "running") console.log(`[mcp-oauth] ${e.label} → ${e.response?.status ?? "ERR"} ${e.durationMs ?? 0}ms`);
  };
  try {
    const client = makeClient(log);
    const tokens = await client.exchangeCode(code);
    const device = await client.getDeviceInfo(tokens.accessToken);
    const oauthClient = await getClient(req.clientId);
    const connId = await createConnection(tokens, {
      clientId: req.clientId,
      clientName: oauthClient?.client_name,
      productName: device.productName,
      serialNumber: device.serialNumber,
      createdAt: new Date().toISOString(),
    });
    await recordUsage({ type: "connected", conn: connId, app: oauthClient?.client_name, printer: device.productName });
    console.log(`[mcp-oauth] connected ${device.productName} as connection ${connId.slice(0, 6)}…`);
    const ourCode = await issueCode({ ...req, connId });
    return redirectTo(req.redirectUri, { code: ourCode, state: req.state, iss: undefined });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mcp-oauth] Epson token exchange failed: ${msg}`);
    await recordUsage({ type: "connect_failed", error: msg });
    return page("Can't connect", `<h1>Couldn't connect to Epson</h1><p>${esc(msg)}</p><p>Try connecting again from Claude.</p>`, 502);
  }
}
