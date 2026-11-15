import { NextResponse } from "next/server";
import { getSession, sessionTokenStore } from "@/lib/server/session";
import { collector, errorResponse, makeClient } from "@/lib/server/epson";

// Call 1 — device information.
export async function GET() {
  const session = await getSession();
  const log = collector();
  const client = makeClient(log.sink);
  try {
    const device = await client.withToken(sessionTokenStore(session), (t) => client.getDeviceInfo(t));
    return NextResponse.json({ device, log: log.entries() });
  } catch (err) {
    return errorResponse(err, log.entries());
  }
}
