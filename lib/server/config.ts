import "server-only";
import type { EpsonConfig } from "@/lib/epson/types";
import { epsonConfigFromEnv, isMockEnv } from "@/lib/epson/env";

export const isMock = () => isMockEnv(process.env);

const DEV_SESSION_SECRET = "mock-mode-only-session-secret-0123456789abcdef";

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (isMock()) return DEV_SESSION_SECRET;
  throw new Error("SESSION_SECRET must be set (32+ characters) when EPSON_MOCK is not true.");
}

export function epsonConfig(): EpsonConfig {
  return epsonConfigFromEnv(process.env);
}
