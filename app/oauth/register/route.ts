import { isAllowedRedirectUri, json, oauthError, preflight } from "@/lib/oauth/http";
import { registerClient } from "@/lib/oauth/store";

// RFC 7591 dynamic client registration. Public clients only (PKCE, no secret).
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown } | null;
  if (!body) return oauthError("invalid_client_metadata", "Body must be JSON.");

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2000)) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be a list of 1-10 URLs.");
  }
  const bad = uris.find((u) => !isAllowedRedirectUri(u));
  if (bad) return oauthError("invalid_redirect_uri", `Not allowed: ${bad}. Use https, or http on localhost.`);
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
    return oauthError("invalid_client_metadata", "Only token_endpoint_auth_method \"none\" (PKCE) is supported.");
  }
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined;

  const client = await registerClient({ redirect_uris: uris as string[], client_name: name });
  return json(
    {
      ...client,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
}

export const OPTIONS = preflight;
