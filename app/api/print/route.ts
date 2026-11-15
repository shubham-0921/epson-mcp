import { NextResponse } from "next/server";
import { getSession, sessionTokenStore } from "@/lib/server/session";
import { collector, errorResponse, makeClient, toErrorPayload } from "@/lib/server/epson";
import { buildJob, parseJson, validateFile, ValidationError } from "@/lib/server/print";
import type { ApiStep } from "@/lib/epson/types";

// One-click print: runs Call 3 → 4 → 5 and streams NDJSON progress events:
//   {type:"log", entry} | {type:"done", jobId} | {type:"error", step, error, code, status?, body?}
export async function POST(request: Request) {
  const session = await getSession();
  const pre = collector();
  const client = makeClient(pre.sink);

  let file: File, job: ReturnType<typeof buildJob>;
  try {
    const form = await request.formData();
    file = validateFile(form.get("file"));
    job = buildJob({ printMode: form.get("printMode"), settings: parseJson(form.get("settings")), fileName: file.name });
  } catch (err) {
    if (err instanceof ValidationError)
      return NextResponse.json({ error: err.message, code: "validation", log: [] }, { status: 400 });
    throw err;
  }

  // Refresh the token *before* streaming — once the stream starts we can't set cookies.
  let accessToken: string;
  try {
    accessToken = await client.withToken(sessionTokenStore(session), async (t) => t);
  } catch (err) {
    return errorResponse(err, pre.entries());
  }
  const bytes = new Uint8Array(await file.arrayBuffer());

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      for (const entry of pre.entries()) send({ type: "log", entry });
      client.onLog = (entry) => send({ type: "log", entry });

      let step: ApiStep = "createJob";
      try {
        const { jobId, uploadUri } = await client.createJob(accessToken, job);
        step = "upload";
        await client.uploadFile(uploadUri, bytes, file.type);
        step = "print";
        await client.executePrint(accessToken, jobId);
        send({ type: "done", jobId });
      } catch (err) {
        send({ type: "error", step, ...toErrorPayload(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
