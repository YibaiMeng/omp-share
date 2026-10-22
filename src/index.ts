/**
 * Self-hostable `/share` server on Cloudflare Workers.
 *
 * Implements the contract the omp client and viewer expect:
 *   POST /s            store a sealed blob, answer `{"id": "<id>"}`
 *   GET  /s/<id>       serve the viewer page
 *   GET  /s/<id>/raw   serve the sealed blob the viewer decrypts
 *   GET  /healthz      answer `ok`
 *
 * Sealed blobs are opaque: the AES-256-GCM key lives in the link's `#fragment`,
 * which browsers never send. R2 is strongly consistent, so a link works the
 * moment the upload returns.
 */
import viewerHtml from "./viewer.html";

/** Mirrors `SERVER_MAX_SEALED_BYTES` in packages/coding-agent/src/export/share.ts. */
const DEFAULT_SHARE_MAX_BYTES = 1_000_000;

/** Same id shape `share.ts` accepts from `POST /s`. */
const SHARE_PATH_RE = /^\/s\/([A-Za-z0-9_-]{10,64})(\/raw)?\/?$/;
/** The viewer routes pure-hex ids to GitHub gists, so the store never issues one. */
const HEX_ID_RE = /^[0-9a-f]+$/;

/**
 * Same-origin only. Inline scripts stay allowed (the viewer uses inline
 * handlers); `connect-src 'self'` permits the `/s/<id>/raw` fetch and blocks
 * the viewer's GitHub gist fetch.
 */
const VIEWER_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  // The page is static; the body is fetched from /s/<id>/raw.
  "cache-control": "public, max-age=3600",
};

const BLOB_HEADERS = {
  "content-type": "application/octet-stream",
  "x-content-type-options": "nosniff",
  // Deleting the R2 object is the revocation mechanism, so don't cache.
  "cache-control": "no-store",
};

export interface Env {
  SHARES: R2Bucket;
  /** Optional override of the upload cap in bytes. */
  MAX_BYTES?: string;
  /**
   * ISO 3166-1 alpha-2 countries that every request is restricted to, matched
   * against the edge's `request.cf.country`. Comma-separated (`"US,CA"`);
   * empty or absent disables the gate.
   */
  ALLOWED_COUNTRIES?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // Gate every route, reads included: a link handed to someone abroad must
      // not render either. `request.cf` is authoritative here even on
      // hostnames a zone-level WAF rule cannot see.
      if (!countryAllowed(request, env)) return text("forbidden", 403);
      return await route(request, env);
    } catch (error) {
      console.error("omp-share:", error);
      return text("internal error", 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/healthz") {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    return text("ok");
  }

  if (pathname === "/s" || pathname === "/s/") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return storeShare(request, env);
  }

  const match = SHARE_PATH_RE.exec(pathname);
  if (!match) return text("not found", 404);
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");

  const id = match[1]!;
  if (match[2]) return serveBlob(env, id);
  // The viewer fetches `/s/<id>/raw` itself and reports a missing share.
  return new Response(viewerHtml, { headers: VIEWER_HEADERS });
}

/** Parsed `ALLOWED_COUNTRIES`; the env value is fixed for the life of the isolate. */
let countryConfig: { raw: string; allowed: ReadonlySet<string> } | undefined;

/**
 * Country gate for every request. `request.cf.country` comes from the edge and
 * is `XX` when it cannot be resolved, so an unknown origin fails closed.
 */
function countryAllowed(request: Request, env: Env): boolean {
  const raw = env.ALLOWED_COUNTRIES?.trim();
  if (!raw) return true;
  // `Request.cf` is a union with an index-signature type, so `country` is
  // `unknown` to the checker even though the edge always sets a string.
  const country = request.cf?.country;
  return typeof country === "string" && allowedSet(raw).has(country);
}

function allowedSet(raw: string): ReadonlySet<string> {
  if (countryConfig?.raw === raw) return countryConfig.allowed;
  const allowed = new Set(
    raw
      .split(",")
      .map((code) => code.trim().toUpperCase())
      .filter((code) => code.length > 0),
  );
  countryConfig = { raw, allowed };
  return allowed;
}

async function storeShare(request: Request, env: Env): Promise<Response> {
  const maxBytes = resolveMaxBytes(env);

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return text("share too large", 413);

  const body = await readCapped(request, maxBytes);
  if (!body) return text("share too large", 413);
  if (body.byteLength === 0) return text("empty share", 400);

  let id: string;
  do {
    id = newId();
  } while (HEX_ID_RE.test(id));

  await env.SHARES.put(id, body);
  return Response.json(
    { id },
    { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}

async function serveBlob(env: Env, id: string): Promise<Response> {
  const object = await env.SHARES.get(id);
  if (!object) return text("share not found", 404);
  return new Response(object.body, {
    headers: { ...BLOB_HEADERS, "content-length": String(object.size) },
  });
}

/** Read at most `max` bytes; `null` as soon as the stream exceeds the cap. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function resolveMaxBytes(env: Env): number {
  const raw = env.MAX_BYTES;
  if (raw === undefined) return DEFAULT_SHARE_MAX_BYTES;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_SHARE_MAX_BYTES;
}

/** 16 random bytes, base64url (22 chars). Never pure hex; see {@link HEX_ID_RE}. */
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function methodNotAllowed(allow: string): Response {
  return new Response("method not allowed", {
    status: 405,
    headers: {
      allow,
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}
