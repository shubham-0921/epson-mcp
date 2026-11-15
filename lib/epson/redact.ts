// Secret redaction for anything that leaves the server (inspector, logs, cURL).

const SECRET_KEYS = new Set([
  "authorization",
  "x-api-key",
  "client_secret",
  "code",
  "access_token",
  "refresh_token",
  "accesstoken",
  "refreshtoken",
  "token",
  "key",
  "signature",
  "sig",
]);

export function mask(value: string): string {
  if (!value) return value;
  // Keep the auth scheme visible ("Bearer ••••abcd")
  const m = /^(Bearer|Basic)\s+(.+)$/i.exec(value);
  if (m) return `${m[1]} ${mask(m[2])}`;
  return `••••${value.slice(-4)}`;
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = isSecretKey(k) ? mask(v) : v;
  return out;
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (isSecretKey(k)) u.searchParams.set(k, mask(v));
    }
    // Keep the bullets readable rather than percent-encoded.
    return u.toString().replace(/%E2%80%A2/g, "•");
  } catch {
    return url;
  }
}

/** Deep-redact JSON-ish values and form-encoded strings. */
export function redactBody(body: unknown): unknown {
  if (body == null) return body;
  if (typeof body === "string") {
    if (body.includes("=") && !body.trim().startsWith("{")) {
      const params = new URLSearchParams(body);
      const obj: Record<string, string> = {};
      for (const [k, v] of params.entries()) obj[k] = isSecretKey(k) ? mask(v) : v;
      return obj;
    }
    return body;
  }
  if (Array.isArray(body)) return body.map(redactBody);
  if (typeof body === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (k === "uploadUri" && typeof v === "string") out[k] = redactUrl(v);
      else out[k] = isSecretKey(k) && typeof v === "string" ? mask(v) : redactBody(v);
    }
    return out;
  }
  return body;
}

export function describeBinary(size: number, mime: string): string {
  return `<binary: ${formatBytes(size)} ${mime}>`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
