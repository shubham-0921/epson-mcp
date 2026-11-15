import { NextResponse } from "next/server";
import { getSession, sessionTokenStore } from "@/lib/server/session";
import { collector, errorResponse, makeClient } from "@/lib/server/epson";

// Step mode — Call 5 only.
export async function POST(request: Request) {
  const session = await getSession();
  const log = collector();
  const client = makeClient(log.sink);
  try {
    const { jobId } = (await request.json()) as { jobId?: string };
    if (!jobId) return NextResponse.json({ error: "Missing jobId", code: "validation", log: [] }, { status: 400 });
    await client.withToken(sessionTokenStore(session), (t) => client.executePrint(t, jobId));
    return NextResponse.json({ ok: true, jobId, log: log.entries() });
  } catch (err) {
    return errorResponse(err, log.entries());
  }
}
