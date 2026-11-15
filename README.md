# Epson Print Console

Connect an Epson printer, upload a file, and watch every Epson Connect API 2.0 call happen live, with its request, response, status and timing. Secrets are always redacted.

## Quick start (mock mode)

```bash
npm install
cp .env.example .env.local   # then set EPSON_MOCK=true
npm run dev                   # http://localhost:3000
```

With `EPSON_MOCK=true` the whole flow (OAuth, device info, capabilities, create job → upload → print) runs against realistic fake responses with 300–800 ms delay, and a MOCK MODE banner is shown. To demo failures, set `EPSON_MOCK_FAIL` to `createJob`, `upload`, `print`, `deviceOffline`, `paperOut` or `jobCanceled`.

## Going live

1. Fill `EPSON_CLIENT_ID`, `EPSON_CLIENT_SECRET`, `EPSON_API_KEY` and `SESSION_SECRET` (32+ chars, e.g. `openssl rand -hex 32`).
2. Register `EPSON_REDIRECT_URI` (localhost and the Vercel URL) in the Epson app settings.
3. Set `EPSON_MOCK=false`.

## Layout

| Path | What it is |
|---|---|
| `lib/epson/client.ts` | Epson API client: OAuth, token refresh (60 s skew, one 401 retry), Calls 1–6. Pure TS, so it can be reused in the MCP server. |
| `lib/epson/logger.ts` | Wraps every HTTP call and records a redacted `ApiLogEntry` |
| `lib/epson/redact.ts` | Secret masking (`••••` + last 4) for headers, query strings and bodies |
| `lib/epson/mock.ts` | Mock transport, plugged into the client in place of `fetch` |
| `lib/server/*` | Next.js glue: env config, iron-session cookie (tokens stay server-side), print validation |
| `app/api/*` | Routes: `auth/login`, `auth/callback`, `auth/logout`, `session`, `printer`, `capability`, `print` (streamed NDJSON), `print/{job,upload,execute}` (step-by-step mode), `print/status` (job status) |
| `components/*` | UI: printer card, file drop, capability-driven settings, API call inspector |

### MCP reuse

```ts
import { EpsonClient } from "./lib/epson/client";
const client = new EpsonClient(config, { onLog: console.log });
await client.withToken(myTokenStore, (t) => client.getDeviceInfo(t));
```

`TokenStore` is a two-method interface (`get`/`set`); implement it with a file or keychain in the MCP server.

## Notes and open items

- Progress is streamed as NDJSON over the `POST /api/print` response, so it works on Vercel with no shared state. The token is refreshed *before* the stream starts, because cookies can't be set once streaming has begun.
- OAuth log entries are carried across the callback redirect in the encrypted session and handed to the UI once.
- In step-by-step mode the `uploadUri` goes to the browser only as a sealed (encrypted) ticket.
- **Job status (Call 6):** after Execute print, the UI polls `GET /api/print/status` (1.5 s at first, backing off to 5 s, for up to 3 minutes) until the job is `completed` or `canceled`. Status values come from the v1.3 spec, Appendix E: `pending`, `processing`, `processing_stopped` (`media_jam`, `media_empty`, `marker_supply_empty`, `attention_required`), `canceled`, `completed`. The parser accepts both snake_case and camelCase fields.
- **Confirmed live:** Call 6 is `GET /printing/jobs/{jobId}` (v1 used `/printers/{device_id}/jobs/{job_id}`). `EPSON_JOB_INFO_PATH` can still override it.
- Not built yet: Cancel (Epson only allows it while a job is `pending`) and the P2 items.
- A second dev config, `dev-mock` in `.claude/launch.json`, runs mock mode on port 3005 without touching `.env.local`.

## MCP server (Phase 1: local, stdio)

Lets Claude Desktop print through your Epson printer. The design plan is the "Epson Print MCP Server — Design Plan" doc.

| Tool | What it does | Epson calls |
|---|---|---|
| `get_printer_status` | Printer name, serial number, online or offline | 1 |
| `get_print_options` | Supported sizes, paper types, qualities, colours, sources, and defaults | 2 |
| `print_document` | Prints Markdown (rendered to PDF) or a base64 PDF/JPEG/PNG up to 1 MB. Settings are optional and readable ("Letter", "photo paper", "black and white") | 1, 2, 3, 4, 5, 6 |
| `get_print_job_status` | Queued, printing, paused (with reason), printed or canceled; can wait up to 50 s with progress updates | 6 |

Limits: 1–10 copies; more than 30 printed pages (pages × copies) needs `confirm_large: true`, which Claude should only set after asking.

### Set up

1. **Sign in once.** This opens Epson's sign-in. After you pick the printer, the console page shows a one-time code; paste it into the terminal. Tokens are saved to `~/.config/epson-print-mcp/tokens.json` (mode 600) and refreshed automatically.

   ```bash
   npm run mcp:login
   ```

   The code page needs the deployed console to include the `cli_` handling in `/api/auth/callback`.

2. **Add it to Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`), using absolute paths:

   ```json
   {
     "mcpServers": {
       "epson-print": {
         "command": "/absolute/path/to/node",
         "args": ["/absolute/path/to/epson/node_modules/tsx/dist/cli.mjs", "/absolute/path/to/epson/mcp/stdio.mts"]
       }
     }
   }
   ```

   Restart Claude Desktop. Add `"env": { "EPSON_MOCK": "true" }` to try it without a printer.

### Develop and test

- `npm run mcp:smoke` starts the server in mock mode and runs every tool through a real MCP client (15 checks).
- `npm run mcp` runs the server on stdio by hand. Logs (redacted) go to stderr.
- Code: tools in `lib/mcp/tools.ts` (transport-agnostic, reused by the Phase 2 remote endpoint), sources and Markdown → PDF in `lib/mcp/sources.ts`, local token file in `lib/mcp/file-store.ts`, entry points in `mcp/`.
- Markdown → PDF uses the standard PDF fonts, so characters outside Windows-1252 (e.g. emoji) print as `?`.

## MCP server (Phase 2: remote, OAuth)

The same four tools, served over Streamable HTTP at `/api/mcp` for claude.ai, Claude Desktop and mobile. Add `https://<deployment>/api/mcp` as a custom connector in Claude.

**Connecting:** Claude gets a 401 pointing at `/.well-known/oauth-protected-resource/api/mcp`, registers itself (`/oauth/register`), and opens `/oauth/authorize`. After a consent page the user signs in at Epson; Epson returns to the existing `/api/auth/callback`, which recognises the `mcp_` state, stores the Epson tokens as a printer connection and sends a one-time code back to Claude. Claude swaps it at `/oauth/token` (PKCE S256) for a 1-hour access token and a 30-day refresh token that rotates on each use. No new Epson redirect URI is needed.

**Storage:** Upstash Redis (`UPSTASH_REDIS_REST_URL`/`_TOKEN` or `KV_REST_API_URL`/`_TOKEN`). Epson tokens are encrypted with AES-256-GCM (`MCP_ENCRYPTION_KEY`, or derived from `SESSION_SECRET`); our tokens are stored only as SHA-256 hashes. Refreshes of Epson tokens take a 10-second Redis lock, because Epson replaces the refresh token each time. Locally, without Redis, an in-memory store is used; on Vercel the routes refuse to run without Redis.

**Limits:** as Phase 1, plus 20 print jobs per connection per hour.

**Test:** `npm run mcp:remote-smoke -- http://localhost:3005` against a dev server running with `EPSON_MOCK=true` (21 checks: discovery, registration, consent, PKCE, single-use codes, tools, progress, refresh rotation).

Code: `app/api/mcp/route.ts`, `app/oauth/*`, `app/.well-known/*`, `lib/oauth/*` (KV, crypto, records, Epson callback), `lib/mcp/token-store.ts`.
