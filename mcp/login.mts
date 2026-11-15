// One-time Epson sign-in for the local MCP server. Saves tokens to a 0600 file
// (~/.config/epson-print-mcp/tokens.json) that the stdio server reads.
//
// Epson redirects to the registered EPSON_REDIRECT_URI (the deployed console).
// Because the state starts with "cli_", the console shows a one-time code instead
// of signing in itself; paste it here. The code is useless without the client secret.

import "./env.mts";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { EpsonClient } from "../lib/epson/client";
import { epsonConfigFromEnv, isMockEnv } from "../lib/epson/env";
import { fileTokenStore } from "../lib/mcp/file-store";

if (isMockEnv()) {
  console.log("EPSON_MOCK=true: the MCP server uses fake tokens, so no sign-in is needed.");
  process.exit(0);
}

const client = new EpsonClient(epsonConfigFromEnv());
const store = fileTokenStore();
const state = `cli_${randomBytes(12).toString("hex")}`;
const url = client.authorizeUrl(state);

console.log("\nSign in with Epson and pick your printer:\n");
console.log(`  ${url}\n`);
execFile("open", [url], () => {});

const rl = createInterface({ input: process.stdin, output: process.stdout });
const pasted = (await rl.question("Paste the code shown after sign-in: ")).trim();
rl.close();

const sep = pasted.lastIndexOf(":");
const gotState = sep > 0 ? pasted.slice(0, sep) : "";
const code = sep > 0 ? pasted.slice(sep + 1) : pasted;
if (gotState !== state) {
  console.error("\nThat code is from a different sign-in (state mismatch). Run `npm run mcp:login` again.");
  process.exit(1);
}

try {
  const tokens = await client.exchangeCode(code);
  store.set(tokens);
  const device = await client.getDeviceInfo(tokens.accessToken);
  console.log(`\nConnected to ${device.productName} (serial ${device.serialNumber}, ${device.connected ? "online" : "offline"}).`);
  console.log(`Tokens saved to ${store.path} (readable only by you).`);
} catch (err) {
  console.error(`\nSign-in failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
