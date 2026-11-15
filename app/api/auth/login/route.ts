import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getSession } from "@/lib/server/session";
import { makeClient } from "@/lib/server/epson";
import { epsonConfig, isMock } from "@/lib/server/config";

// Builds the Epson authorize URL (Call 0) with a CSRF `state` and redirects to it.
export async function GET(request: Request) {
  const session = await getSession();
  const state = randomBytes(16).toString("hex");
  session.oauthState = state;
  await session.save();

  if (isMock()) {
    // Simulate Epson's sign-in page redirecting straight back with a code.
    const cb = new URL("/api/auth/callback", request.url);
    cb.searchParams.set("code", `mock_${randomBytes(12).toString("hex")}`);
    cb.searchParams.set("iss", "https://www.epsonconnect.com");
    cb.searchParams.set("state", state);
    return NextResponse.redirect(cb);
  }

  epsonConfig(); // throws early with a clear message if env is missing
  return NextResponse.redirect(makeClient().authorizeUrl(state));
}
