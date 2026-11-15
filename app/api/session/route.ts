import { NextResponse } from "next/server";
import { getSession } from "@/lib/server/session";
import { isMock } from "@/lib/server/config";

// Connection status for the UI + one-time hand-off of OAuth log entries.
export async function GET() {
  const session = await getSession();
  const log = session.pendingLog ?? [];
  if (session.pendingLog) {
    delete session.pendingLog;
    await session.save();
  }
  return NextResponse.json({ connected: !!session.tokens, mock: isMock(), log });
}
