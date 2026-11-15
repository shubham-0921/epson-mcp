import { NextResponse } from "next/server";
import { getSession, sessionTokenStore } from "@/lib/server/session";
import { collector, errorResponse, makeClient } from "@/lib/server/epson";
import { buildJob, sealTicket, ValidationError } from "@/lib/server/print";

// Step mode — Call 3 only. Returns a sealed ticket carrying the uploadUri.
export async function POST(request: Request) {
  const session = await getSession();
  const log = collector();
  const client = makeClient(log.sink);
  try {
    const body = await request.json();
    const job = buildJob(body);
    const res = await client.withToken(sessionTokenStore(session), (t) => client.createJob(t, job));
    return NextResponse.json({ jobId: res.jobId, ticket: await sealTicket(res), log: log.entries() });
  } catch (err) {
    if (err instanceof ValidationError) return NextResponse.json({ error: err.message, code: "validation", log: [] }, { status: 400 });
    return errorResponse(err, log.entries());
  }
}
