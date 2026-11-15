import "server-only";
import type { EpsonConfig } from "@/lib/epson/types";

export const isMock = () => process.env.EPSON_MOCK === "true";

const DEV_SESSION_SECRET = "mock-mode-only-session-secret-0123456789abcdef";

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (isMock()) return DEV_SESSION_SECRET;
  throw new Error("SESSION_SECRET must be set (32+ characters) when EPSON_MOCK is not true.");
}

export function epsonConfig(): EpsonConfig {
  const env = process.env;
  if (isMock()) {
    return {
      clientId: env.EPSON_CLIENT_ID || "mock-client-id-7f3a",
      clientSecret: env.EPSON_CLIENT_SECRET || "mock-client-secret-91bd",
      apiKey: env.EPSON_API_KEY || "mock-api-key-c0ffee42",
      redirectUri: env.EPSON_REDIRECT_URI || "http://localhost:3000/api/auth/callback",
      authBase: env.EPSON_AUTH_BASE || "https://auth.epsonconnect.com",
      apiBase: env.EPSON_API_BASE || "https://api.epsonconnect.com/api/2",
    };
  }
  const missing = ["EPSON_CLIENT_ID", "EPSON_CLIENT_SECRET", "EPSON_API_KEY", "EPSON_REDIRECT_URI"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  return {
    clientId: env.EPSON_CLIENT_ID!,
    clientSecret: env.EPSON_CLIENT_SECRET!,
    apiKey: env.EPSON_API_KEY!,
    redirectUri: env.EPSON_REDIRECT_URI!,
    authBase: env.EPSON_AUTH_BASE || "https://auth.epsonconnect.com",
    apiBase: env.EPSON_API_BASE || "https://api.epsonconnect.com/api/2",
  };
}
