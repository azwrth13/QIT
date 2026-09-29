# Route guards

`src/lib/http/guards.ts` holds the shared guards for new API routes. It has no dependencies beyond `base-url`, `client-ip` and `makeRoom`/`isSteamId` from `steam.ts`.

Standard POST route shape:

```ts
export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  const parsed = await readJsonBody(req);
  if ('response' in parsed) return parsed.response;
  // validate with parseSteamId / parseAppId / parseBoundedString, then jsonResponse(...)
}
```

- `checkSameOrigin` requires `Origin` (or `Referer`) to equal `getBaseUrl()`; anything else is a 403.
- `createLimiter({ capacity, refillPerSecond })` is a token bucket; use one for users and one for IPs (`checkRateLimit`). Denials are 429 with `Retry-After`.
- Limiter state is in memory, per instance. With `maxInstances: 2` the effective limit can be up to twice the configured one, and it resets on restart. Buckets are capped at 5000 entries using `makeRoom`.
- `readJsonBody` caps the size (default 8 KiB) by counting streamed bytes, not just `Content-Length`.
- Errors use one envelope, `{ "error": { "code", "message" } }`, and every response sets `Cache-Control: private, no-store`.
- Log with `logServerError` only (error name, never URLs, keys or payloads).
