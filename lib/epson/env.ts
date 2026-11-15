// Reads Epson settings from environment variables. Pure: shared by the Next.js
// app (lib/server/config.ts) and the MCP server.

import type { EpsonConfig } from "./types";

type Env = Record<string, string | undefined>;

export const isMockEnv = (env: Env = process.env) => env.EPSON_MOCK === "true";

export function epsonConfigFromEnv(env: Env = process.env): EpsonConfig {
  const base = {
    authBase: env.EPSON_AUTH_BASE || "https://auth.epsonconnect.com",
    apiBase: env.EPSON_API_BASE || "https://api.epsonconnect.com/api/2",
    jobInfoPath: env.EPSON_JOB_INFO_PATH || undefined,
  };
  if (isMockEnv(env)) {
    return {
      ...base,
      clientId: env.EPSON_CLIENT_ID || "mock-client-id-7f3a",
      clientSecret: env.EPSON_CLIENT_SECRET || "mock-client-secret-91bd",
      apiKey: env.EPSON_API_KEY || "mock-api-key-c0ffee42",
      redirectUri: env.EPSON_REDIRECT_URI || "http://localhost:3000/api/auth/callback",
    };
  }
  const missing = ["EPSON_CLIENT_ID", "EPSON_CLIENT_SECRET", "EPSON_API_KEY", "EPSON_REDIRECT_URI"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  return {
    ...base,
    clientId: env.EPSON_CLIENT_ID!,
    clientSecret: env.EPSON_CLIENT_SECRET!,
    apiKey: env.EPSON_API_KEY!,
    redirectUri: env.EPSON_REDIRECT_URI!,
  };
}
