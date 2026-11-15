import { randomBytes } from "node:crypto";
import { makeClient } from "@/lib/server/epson";
import { isMock } from "@/lib/server/config";
import { esc, page, redirectTo, SCOPE } from "@/lib/oauth/http";
import { getAuthRequest, getClient, saveAuthRequest, takeAuthRequest } from "@/lib/oauth/store";

// Step 1 of connecting Claude: check the request, show a consent page, then send
// the user to Epson's sign-in. Epson returns to /api/auth/callback with our state.

const errorPage = (msg: string) => page("Can't connect", `<h1>Can't connect</h1><p>${esc(msg)}</p>`, 400);

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";

  // Until client and redirect URI are known-good, errors must not redirect anywhere.
  const client = clientId ? await getClient(clientId) : null;
  if (!client) return errorPage("Unknown client. Remove the connector in Claude and add it again.");
  if (!client.redirect_uris.includes(redirectUri)) return errorPage("The redirect URI doesn't match the one this client registered.");

  const state = q.get("state") ?? undefined;
  const fail = (error: string, description: string) => redirectTo(redirectUri, { error, error_description: description, state });
  if (q.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }

  const id = await saveAuthRequest({
    clientId,
    redirectUri,
    codeChallenge: challenge,
    state,
    scope: SCOPE,
    resource: q.get("resource") ?? undefined,
  });

  const name = client.client_name || "An app";
  const host = new URL(redirectUri).host;
  return page(
    "Connect your Epson printer",
    `<h1>Connect your Epson printer</h1>
<p><b>${esc(name)}</b> wants to print on your Epson printer.</p>
<ul><li>Check whether your printer is online</li><li>Read its paper and quality options</li><li>Send print jobs and follow their status</li></ul>
<p>Next you'll sign in with Epson and choose the printer. You'll return to <b>${esc(host)}</b>.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${esc(id)}">
<div class="row"><button class="primary" name="action" value="allow">Continue to Epson</button><button name="action" value="deny">Cancel</button></div></form>`,
  );
}

export async function POST(request: Request) {
  const form = new URLSearchParams(await request.text());
  const id = form.get("request") ?? "";
  if (!id.startsWith("mcp_")) return errorPage("This sign-in link is invalid.");

  if (form.get("action") !== "allow") {
    const req = await takeAuthRequest(id);
    if (!req) return errorPage("This sign-in has expired. Start again from Claude.");
    return redirectTo(req.redirectUri, { error: "access_denied", error_description: "The user canceled.", state: req.state });
  }

  const req = await getAuthRequest(id);
  if (!req) return errorPage("This sign-in has expired (10 minutes). Start again from Claude.");

  if (isMock()) {
    // Simulate Epson's sign-in page redirecting straight back with a code.
    const cb = new URL("/api/auth/callback", request.url);
    cb.searchParams.set("code", `mock_${randomBytes(12).toString("hex")}`);
    cb.searchParams.set("state", id);
    return new Response(null, { status: 303, headers: { Location: cb.toString() } });
  }
  return new Response(null, { status: 303, headers: { Location: makeClient().authorizeUrl(id) } });
}
