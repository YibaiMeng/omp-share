# omp-share

A self-hostable `/share` server for [oh-my-pi](https://github.com/can1357/oh-my-pi), running on
Cloudflare Workers with R2 blob storage. It implements the same contract as the `Bun.serve`
reference implementation in a fork's
[pull request #1](https://github.com/YibaiMeng/oh-my-pi/pull/1):

| Route | Behavior |
| --- | --- |
| `POST /s` | Store a sealed blob, respond `{"id":"<id>"}` |
| `GET /s/<id>` | Serve the standalone viewer page |
| `GET /s/<id>/raw` | Serve the sealed blob (viewer fetches and decrypts it) |
| `GET /healthz` | `ok` |

The server is content-blind: omp gzips the session, seals it with AES-256-GCM, and puts the key in
the link's `#fragment`, which browsers never send. R2 is strongly consistent, so a printed link works
as soon as the upload returns.

## Deploy

Requires Node 22.18+ and an authenticated `wrangler` (`npx wrangler login`).

```sh
npm install
npx wrangler r2 bucket create omp-share   # once
npm run deploy
```

`wrangler` prints the worker URL, e.g. `https://omp-share.<your-subdomain>.workers.dev`. Point omp at
it:

```sh
omp config set share.serverUrl https://omp-share.<your-subdomain>.workers.dev/s
omp share path/to/session.jsonl
```

Open the printed link (or paste it whole — the `#key` fragment is required).

To serve a custom domain, keep deployment-specific settings out of git: copy `wrangler.jsonc` to
`wrangler.local.jsonc` (ignored), add your `routes`, and run `npm run deploy:local`. `wrangler` fails
if the declared zone is not in the logged-in account. The viewer works at any origin because it
fetches `/s/<id>/raw` relative to itself. `"workers_dev": false` is deliberate: the
`workers.dev` hostname is off the zone, so no WAF rule or DNS setting covers it, and the country gate
should be the last thing standing. Flip it to `true` only for a deployment without a custom domain.

### Local development

```sh
npm run dev        # http://127.0.0.1:8787, R2 simulated by Miniflare
```

## Configuration

- Upload cap: `MAX_BYTES` in `wrangler.jsonc` (default `1000000`, matching
  `SERVER_MAX_SEALED_BYTES` in the omp client). The client trims to its own fixed 1,000,000-byte cap,
  so lowering this makes larger shares fail with 413; raising it has no effect on stock clients.
- Allowed countries: `ALLOWED_COUNTRIES` (default `US,CA`) is a comma-separated list of ISO
  alpha-2 codes matched against `request.cf.country`. Every request, reads included, must match;
  everything else gets 403 — an upload from outside fails, and so does a link opened there.
  `/healthz` is gated too. Unset the var to disable the gate entirely. This is edge IP
  geolocation: a VPN exiting in an allowed country passes and unresolved origins (`XX`) are
  rejected, so treat it as a throttle, not authentication.
- Storage: R2 bucket `omp-share`, binding `SHARES`. Renaming the bucket means updating
  `wrangler.jsonc` and the revoke command below; renaming the binding also means updating
  `Env.SHARES` / `env.SHARES` in `src/index.ts`.

## The viewer asset

`src/viewer.html` is generated from the published omp package, using the same template and
replacements as `packages/coding-agent/scripts/generate-share-viewer.ts`. Regenerate it after an omp
upgrade:

1. Bump `DEFAULT_VERSION` in `scripts/build-viewer.mjs` to the published omp release.
2. Run `npm run build:viewer` and commit the regenerated `src/viewer.html`.

The script refuses an argument that differs from the pin, so the constant always records what the
committed page was built from. It downloads the `@oh-my-pi/pi-coding-agent` tarball into a temporary
directory and needs no monorepo checkout or native addon.

The page is served with a same-origin Content-Security-Policy (`connect-src 'self'`), so it cannot
contact third-party hosts. One consequence: GitHub gist shares (`share.store: gist`, ids that are pure
hex) do not render here. Keep `share.store: blob` (the default).

## Operations

- **Revoke a share:** `npx wrangler r2 object delete omp-share/<id> --remote`. Blobs are served
  with `cache-control: no-store`, so a deleted share 404s immediately.
- **List shares:** use the Cloudflare dashboard (R2 → `omp-share`); current `wrangler` has no object
  listing command.
- **Uploads are unauthenticated**, like the upstream server. `POST /s` is limited to
  `ALLOWED_COUNTRIES` (see Configuration); anyone inside one of those countries, or behind a VPN
  that exits there, can still store up to `MAX_BYTES`. Tighten further with a WAF rate-limit rule on
  `POST /s`, or put Cloudflare Access in front with an IP/service-token bypass for the machines that
  run `omp share` — plain Access blocks the CLI's upload and every viewer.
- **Shares only open inside `ALLOWED_COUNTRIES`.** The gate runs before routing, so `/s/<id>`,
  `/s/<id>/raw` and `/healthz` all answer 403 elsewhere; a recipient outside needs a VPN exiting in
  an allowed country.
- Shares never expire on their own; delete objects to remove them.
- **What the server sees:** the sealed blob, the request path and id, content length, User-Agent and
  client IP, plus request timing in Cloudflare's invocation logs. It never sees plaintext or the key;
  see below.

## Privacy

The upload is `[12B IV][AES-256-GCM(gzip(snapshot))]`; the 32-byte key exists only in the link's
`#fragment`, which HTTP never sends. The Worker stores the body byte-for-byte and never logs it. HTTP
is redirected to HTTPS and the zone sends HSTS, so the body is also encrypted in transit.

This protects blobs at rest and from network observers, not from the operator: whoever can deploy to
the Worker can serve a modified viewer that reads `location.hash` and posts the key back. Anyone
holding the complete link can decrypt; deleting the object only stops future fetches.
