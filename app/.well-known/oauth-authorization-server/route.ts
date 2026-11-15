import { baseUrl, json, preflight, SCOPE } from "@/lib/oauth/http";

// RFC 8414 authorization server metadata, read by Claude when connecting.
export function GET(request: Request) {
  const base = baseUrl(request);
  return json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    service_documentation: `${base}/`,
  });
}

export const OPTIONS = preflight;
