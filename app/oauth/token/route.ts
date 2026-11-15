import { pkceMatches } from "@/lib/oauth/crypto";
import { json, oauthError, preflight, readParams } from "@/lib/oauth/http";
import { issueTokens, rotateRefreshToken, takeCode } from "@/lib/oauth/store";

// Token endpoint: authorization_code (with PKCE) and refresh_token (rotating).
export async function POST(request: Request) {
  const p = await readParams(request);
  const clientId = p.client_id ?? "";
  if (!clientId) return oauthError("invalid_client", "client_id is required.", 401);

  if (p.grant_type === "authorization_code") {
    const rec = p.code ? await takeCode(p.code) : null; // single use
    if (!rec) return oauthError("invalid_grant", "The code is invalid, expired or already used.");
    if (rec.clientId !== clientId) return oauthError("invalid_grant", "The code was issued to another client.");
    if (p.redirect_uri && p.redirect_uri !== rec.redirectUri) return oauthError("invalid_grant", "redirect_uri doesn't match.");
    if (!p.code_verifier || !pkceMatches(p.code_verifier, rec.codeChallenge)) return oauthError("invalid_grant", "PKCE check failed.");
    return json(await issueTokens({ connId: rec.connId, clientId, scope: rec.scope, resource: rec.resource }));
  }

  if (p.grant_type === "refresh_token") {
    const tokens = p.refresh_token ? await rotateRefreshToken(p.refresh_token, clientId) : null;
    if (!tokens) return oauthError("invalid_grant", "The refresh token is invalid, expired or already used. Reconnect the printer.");
    return json(tokens);
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

export const OPTIONS = preflight;
