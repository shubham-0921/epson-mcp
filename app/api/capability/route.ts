import { NextResponse } from "next/server";
import { getSession, sessionTokenStore } from "@/lib/server/session";
import { collector, errorResponse, makeClient } from "@/lib/server/epson";

// Call 2 — printing capabilities for ?mode=document|photo.
export async function GET(request: Request) {
  const mode = new URL(request.url).searchParams.get("mode") === "photo" ? "photo" : "document";
  const session = await getSession();
  const log = collector();
  const client = makeClient(log.sink);
  try {
    const capability = await client.withToken(sessionTokenStore(session), (t) => client.getCapability(t, mode));
    return NextResponse.json({ mode, capability, log: log.entries() });
  } catch (err) {
    return errorResponse(err, log.entries());
  }
}
