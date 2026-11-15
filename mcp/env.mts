// Loads .env.local etc. the same way Next.js does, without printing to stdout
// (stdout is the MCP channel for the stdio server).
import nextEnv from "@next/env";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(projectDir, false, { info: () => {}, error: (...a: unknown[]) => console.error(...a) });
