import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

// The usage dashboard is protected by one password (ADMIN_PASSWORD, 12+ characters).
// Signing in sets an httpOnly cookie holding an HMAC derived from the password, so
// changing the password signs everyone out.

export const ADMIN_COOKIE = "epc_admin";
export const ADMIN_MAX_AGE = 60 * 60 * 24 * 7;

export const adminConfigured = () => (process.env.ADMIN_PASSWORD ?? "").length >= 12;

export function adminCookieValue(): string {
  return createHmac("sha256", process.env.ADMIN_PASSWORD!).update("epson-usage-dashboard-v1").digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function isAdmin(): Promise<boolean> {
  if (!adminConfigured()) return false;
  const v = (await cookies()).get(ADMIN_COOKIE)?.value;
  return !!v && safeEqual(v, adminCookieValue());
}
