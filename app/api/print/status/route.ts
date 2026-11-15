import { NextResponse } from "next/server";
import { getSession, sessionTokenStore } from "@/lib/server/session";
import { collector, errorResponse, makeClient } from "@/lib/server/epson";

// Call 6 — Get print job information. The UI polls this after Execute print.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  const attempt = Number(url.searchParams.get("attempt") ?? 1) || 1;
  if (!jobId) return NextResponse.json({ error: "Missing jobId", code: "validation", log: [] }, { status: 400 });
  const session = await getSession();
  const log = collector();
  const client = makeClient(log.sink);
  try {
    const job = await client.withToken(sessionTokenStore(session), (t) => client.getJobInfo(t, jobId, attempt));
    return NextResponse.json({ job, log: log.entries() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, log.entries());
  }
}
