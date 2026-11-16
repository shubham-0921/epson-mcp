"use server";

import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE, ADMIN_MAX_AGE, adminConfigured, adminCookieValue, safeEqual } from "@/lib/analytics/admin-auth";
import { kv } from "@/lib/oauth/kv";

const MAX_ATTEMPTS = 10; // per IP per 15 minutes

export async function signIn(formData: FormData) {
  if (!adminConfigured()) redirect("/admin");
  const ip = ((await headers()).get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  const attempts = await kv().incr(`rate:admin:${createHash("sha256").update(ip).digest("hex").slice(0, 16)}:${bucket}`, 15 * 60);
  if (attempts > MAX_ATTEMPTS) redirect("/admin?error=locked");

  const given = String(formData.get("password") ?? "");
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  if (!safeEqual(h(given), h(process.env.ADMIN_PASSWORD!))) redirect("/admin?error=wrong");

  (await cookies()).set(ADMIN_COOKIE, adminCookieValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/admin",
    maxAge: ADMIN_MAX_AGE,
  });
  redirect("/admin");
}

export async function signOut() {
  (await cookies()).delete({ name: ADMIN_COOKIE, path: "/admin" });
  redirect("/admin");
}
