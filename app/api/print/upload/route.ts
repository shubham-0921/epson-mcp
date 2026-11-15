import { NextResponse } from "next/server";
import { collector, errorResponse, makeClient } from "@/lib/server/epson";
import { unsealTicket, validateFile, ValidationError } from "@/lib/server/print";

// Step mode — Call 4 only.
export async function POST(request: Request) {
  const log = collector();
  const client = makeClient(log.sink);
  try {
    const form = await request.formData();
    const file = validateFile(form.get("file"));
    const { uploadUri } = await unsealTicket(form.get("ticket"));
    await client.uploadFile(uploadUri, new Uint8Array(await file.arrayBuffer()), file.type);
    return NextResponse.json({ ok: true, log: log.entries() });
  } catch (err) {
    if (err instanceof ValidationError) return NextResponse.json({ error: err.message, code: "validation", log: [] }, { status: 400 });
    return errorResponse(err, log.entries());
  }
}
