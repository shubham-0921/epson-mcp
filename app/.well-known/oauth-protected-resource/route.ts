import { baseUrl, json, mcpResourceUrl, preflight, SCOPE } from "@/lib/oauth/http";

// RFC 9728 protected resource metadata for /api/mcp. Also served at the
// path-suffixed URL (…/oauth-protected-resource/api/mcp) that the 401 points to.
export function GET(request: Request) {
  return json({
    resource: mcpResourceUrl(request),
    authorization_servers: [baseUrl(request)],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Epson Print",
  });
}

export const OPTIONS = preflight;
