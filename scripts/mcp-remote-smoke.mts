/* eslint-disable @typescript-eslint/no-explicit-any -- test script reads loosely-typed tool results */
// End-to-end test of the remote MCP server: OAuth discovery, registration, consent,
// (mock) Epson sign-in, PKCE code exchange, tool calls, refresh rotation.
// Usage: npm run mcp:remote-smoke -- http://localhost:3005   (server must run with EPSON_MOCK=true)
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = (process.argv[2] || "http://localhost:3005").replace(/\/$/, "");
const REDIRECT = "http://localhost:6274/oauth/callback";
let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const get = (path: string, init?: RequestInit) => fetch(path.startsWith("http") ? path : BASE + path, { redirect: "manual", ...init });

// 1. Unauthenticated call → 401 pointing at resource metadata
const r401 = await get("/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
const www = r401.headers.get("www-authenticate") ?? "";
check("401 without token", r401.status === 401 && www.includes("resource_metadata="), www);
const prmUrl = www.match(/resource_metadata="([^"]+)"/)?.[1] ?? "";

// 2. Discovery
const prm = await (await get(prmUrl)).json();
check("protected resource metadata", prm.resource === `${BASE}/api/mcp` && prm.authorization_servers?.[0] === BASE, JSON.stringify(prm));
const as = await (await get("/.well-known/oauth-authorization-server")).json();
check("authorization server metadata", as.code_challenge_methods_supported?.includes("S256") && !!as.registration_endpoint);

// 3. Registration
const badReg = await get(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
check("rejects non-https redirect", badReg.status === 400);
const reg = await (await get(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Smoke Test", redirect_uris: [REDIRECT] }) })).json();
check("registers client", typeof reg.client_id === "string", reg.client_id);

// 4. Authorize → consent page
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authUrl = new URL(as.authorization_endpoint);
Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz123", scope: "print", resource: prm.resource }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
const wrongRedirect = new URL(authUrl); wrongRedirect.searchParams.set("redirect_uri", "https://evil.example/cb");
check("unregistered redirect gets an error page, not a redirect", (await get(wrongRedirect.toString())).status === 400);
const consent = await get(authUrl.toString());
const consentHtml = await consent.text();
const reqId = consentHtml.match(/name="request" value="([^"]+)"/)?.[1] ?? "";
check("consent page", consent.status === 200 && consentHtml.includes("Smoke Test") && reqId.startsWith("mcp_"), consent.headers.get("x-frame-options") ?? "");

// 5. Continue → (mock) Epson → callback → redirect to client with code
const allow = await get("/oauth/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `request=${reqId}&action=allow` });
const epsonCb = allow.headers.get("location") ?? "";
check("continue goes to Epson sign-in (mock)", allow.status === 303 && epsonCb.includes("/api/auth/callback"), epsonCb.replace(/code=[^&]+/, "code=…"));
const back = await get(epsonCb);
const loc = new URL(back.headers.get("location") ?? "http://x/");
check("callback returns code to client", back.status === 302 && loc.origin + loc.pathname === REDIRECT && loc.searchParams.get("state") === "xyz123" && !!loc.searchParams.get("code"));
const code = loc.searchParams.get("code")!;

// 6. Token exchange
const tokenReq = (body: Record<string, string>) =>
  get(as.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
const badPkce = await tokenReq({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: "x".repeat(43) });
check("wrong PKCE verifier refused", badPkce.status === 400);
// The bad attempt consumed the code (single use) — do the flow again for a fresh code.
const consent2 = await (await get(authUrl.toString())).text();
const reqId2 = consent2.match(/name="request" value="([^"]+)"/)?.[1] ?? "";
const allow2 = await get("/oauth/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `request=${reqId2}&action=allow` });
const back2 = await get(allow2.headers.get("location")!);
const code2 = new URL(back2.headers.get("location")!).searchParams.get("code")!;
const tok = await (await tokenReq({ grant_type: "authorization_code", code: code2, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier })).json();
check("code + PKCE → tokens", !!tok.access_token && !!tok.refresh_token && tok.expires_in === 3600, `expires_in ${tok.expires_in}`);
const reuse = await tokenReq({ grant_type: "authorization_code", code: code2, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
check("code can't be reused", reuse.status === 400);

// 7. Tools over Streamable HTTP
const connect = async (accessToken: string) => {
  const c = new Client({ name: "remote-smoke", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return c;
};
const client = await connect(tok.access_token);
const tools = (await client.listTools()).tools.map((t) => t.name);
check("lists 4 tools", tools.length === 4, tools.join(", "));
const st: any = await client.callTool({ name: "get_printer_status", arguments: {} });
check("get_printer_status", !st.isError && st.structuredContent?.online === true, st.content[0].text);
const pr: any = await client.callTool({ name: "print_document", arguments: { source: { type: "markdown", title: "Remote test", markdown: "# Hello from the remote server\n\n- one\n- two" }, color: "black and white" } });
check("print_document", !pr.isError && !!pr.structuredContent?.jobId, pr.content[0].text);
const progress: string[] = [];
const js: any = await client.callTool({ name: "get_print_job_status", arguments: { job_id: pr.structuredContent.jobId, wait_seconds: 20 } }, undefined, { onprogress: (p) => progress.push(p.message ?? ""), timeout: 60_000 });
check("job status waits until printed", js.structuredContent?.status === "completed", js.content[0].text);
check("progress notifications over HTTP", progress.length >= 2, progress.join(" → "));
await client.close();

// 8. Refresh rotation
const rt1 = await (await tokenReq({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id })).json();
check("refresh issues new pair", !!rt1.access_token && rt1.refresh_token !== tok.refresh_token);
check("old refresh token is single-use", (await tokenReq({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id })).status === 400);
const c2 = await connect(rt1.access_token);
const st2: any = await c2.callTool({ name: "get_printer_status", arguments: {} });
check("new access token works", !st2.isError);
await c2.close();
const badTok = await get("/api/mcp", { method: "POST", headers: { Authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
check("bad token → 401 invalid_token", badTok.status === 401 && (badTok.headers.get("www-authenticate") ?? "").includes("invalid_token"));

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
