import "server-only";
import { cookies } from "next/headers";
import { getIronSession, type IronSession } from "iron-session";
import { sessionSecret } from "./config";
import type { ApiLogEntry, TokenSet, TokenStore } from "@/lib/epson/types";

export type SessionData = {
  tokens?: TokenSet;
  oauthState?: string;
  /** Redacted OAuth log entries carried across the callback redirect, handed to the UI once. */
  pendingLog?: ApiLogEntry[];
};

export async function getSession(): Promise<IronSession<SessionData>> {
  return getIronSession<SessionData>(await cookies(), {
    password: sessionSecret(),
    cookieName: "epc_session",
    ttl: 60 * 60 * 24 * 30, // matches the 30-day refresh token
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    },
  });
}

export function sessionTokenStore(session: IronSession<SessionData>): TokenStore {
  return {
    get: () => session.tokens ?? null,
    set: async (tokens) => {
      if (tokens) session.tokens = tokens;
      else delete session.tokens;
      await session.save();
    },
  };
}
