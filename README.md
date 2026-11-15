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
- **Unconfirmed:** the 2.0 path for Call 6 is assumed to be `GET /printing/jobs/{jobId}`, because v1 used `/printers/{device_id}/jobs/{job_id}` and 2.0 drops the device ID. If Epson's reference says otherwise, set `EPSON_JOB_INFO_PATH`; no code change is needed.
- Not built yet: Cancel (Epson only allows it while a job is `pending`) and the P2 items.
- A second dev config, `dev-mock` in `.claude/launch.json`, runs mock mode on port 3005 without touching `.env.local`.
