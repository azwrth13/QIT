# QIT

QIT picks a random game from a filtered Steam library. You can browse any public Steam library without signing in. Signing in with Steam syncs your own library once, and you can refresh it from the library page.

## Local setup

Use Node.js 22.13 or newer and MySQL. Copy `.env.example` to `.env.local` and set `DATABASE_URL`, `STEAM_API_KEY`, `SESSION_SECRET` (at least 32 random characters), and `NEXT_PUBLIC_BASE_URL` (normally `http://localhost:3000`). The base URL must match the Steam OpenID callback origin. Never commit real credentials.

Run `npm ci`. The postinstall script generates Prisma Client. Apply existing migrations with `npx prisma migrate deploy`, then run `npm run dev` and open `http://localhost:3000`.

Your Steam Game details must be Public to show owned games. Steam sign-in reads your public profile; QIT stores your Steam ID, profile URL, and synced game details in MySQL. The public library view reads live from Steam and does not write games to the database.

Sessions use signed and encrypted HTTP-only cookies and last seven days. Existing unsigned Steam ID cookies are not accepted; users must sign in again. Rotating `SESSION_SECRET` invalidates current sessions. Logout clears the session cookie.

The friend and genre APIs require a valid session. Genre requests accept up to 40 unique app IDs owned by the signed-in user; larger libraries load in batches. Profile search is public and accepts a 17-digit Steam ID, vanity name, or Steam profile URL. Profile search and public library lookups are each limited to 20 requests per minute per client IP and cache responses briefly. `TRUSTED_PROXY_HOPS` selects the `X-Forwarded-For` entry counted from the right (default 2 for Firebase App Hosting's Google load balancer); shorter headers use their leftmost entry and missing headers fall back to `X-Real-IP`. Steam request failures log only safe error metadata.

## Checks

Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Pull requests and pushes to `master` run these checks plus a production dependency audit in GitHub Actions.

The PostCSS override keeps Next.js's transitive PostCSS dependency on a patched 8.x release; retain it until the framework dependency itself meets that floor.
