# Qit

A Steam library randomizer built with [Next.js](https://nextjs.org) featuring a Neobrutalism design aesthetic.

## Getting Started

Use Node.js 22.13 or later. Install dependencies with `npm ci`, copy
`.env.example` to `.env`, and supply your MySQL connection, Steam Web API key,
and a randomly generated `SESSION_SECRET` of at least 32 characters. Never
commit real credentials. Set `NEXT_PUBLIC_BASE_URL` to the public HTTPS origin
in production; the Steam callback must exactly match that origin plus
`/api/auth/steam-callback`.

Run `npx prisma generate` and apply the existing migrations with
`npx prisma migrate deploy` against your configured database. Then start the
development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Validation and sessions

Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
Pull requests and pushes to `master` run these checks plus a production
dependency audit in GitHub Actions, without production credentials.

Sessions use signed and encrypted HTTP-only cookies, last seven days, and
require HTTPS in production. Existing unsigned Steam ID cookies are no longer
accepted; users must sign in again. Rotating `SESSION_SECRET` invalidates all
current sessions. Logout removes the browser cookie.

The friend and genre APIs require a valid session. Profile search is public so
signed-out visitors can look up a profile; it accepts a 17-digit Steam ID, a
vanity name, or a Steam profile URL, is limited to 20 requests per minute per
client IP, and caches results for one minute. Genre requests
accept 1–500 unique positive integer app IDs owned by the caller; requests for
larger libraries must be split into batches. Steam request failures log only
safe error metadata, never request URLs or profile payloads.

The PostCSS override keeps Next.js's transitive PostCSS dependency on a patched
8.x release; retain it until the framework dependency itself meets that floor.
