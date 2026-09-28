# QIT

QIT picks a random game from a filtered Steam library. Visitors can browse public Steam libraries without signing in. Steam sign-in saves the user's profile and syncs their library into Firestore. A library can be refreshed from its page. On their own library, signed-in users can launch the picked game directly in the Steam client through a `steam://run/<appid>` link.

## Local development

Use Node.js 22.13 or newer. Run `npm ci`, then copy `.env.example` to `.env.local`. Set `STEAM_API_KEY`, a random `SESSION_SECRET` of at least 32 characters, and `NEXT_PUBLIC_BASE_URL` to the exact local origin, normally `http://localhost:3000`. Steam OpenID returns to `<NEXT_PUBLIC_BASE_URL>/api/auth/steam-callback`.

Install the Firebase CLI and Java, run `firebase emulators:start --only firestore`, then run `npm run dev` in a second terminal. `.env.local` sets `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`; the Admin SDK connects to the emulator without a service account. To use a real Firestore database in local development, unset that variable and point `GOOGLE_APPLICATION_CREDENTIALS` at a local service account JSON file. Never commit that file or credentials.

Your Steam Game details must be Public for QIT to sync owned games. Firestore stores profiles under `users/{steamid}`, owned games under `users/{steamid}/games/{appid}`, achievement progress under `users/{steamid}/achievementProgress/{appid}`, and shared genre data under `apps/{appid}`. Existing Railway data is not migrated; users and libraries are rebuilt from Steam at the next sign-in. The public library view reads live from Steam and does not store games.

Sessions use a signed and encrypted HTTP-only `__session` cookie for seven days. Firebase Hosting forwards this cookie to Cloud Run. Existing unsigned Steam ID cookies are not accepted, and rotating `SESSION_SECRET` invalidates current sessions. Logout clears the session cookie.

Friend, genre, and achievement APIs require a valid session. On your own library, the random picker shows achievement progress for the picked game; the app caches each result in Firestore for six hours, including games without achievements or with private stats. Genre requests accept up to 40 unique owned app IDs. The app stores Steam Store genre responses in Firestore for one day and fills missing entries in small, spaced batches. Profile search accepts a Steam ID, vanity name, or Steam profile URL. Signed-in users get suggestions from their Steam friends list in the search box; this requires a public Steam friends list. For public profiles, search results and the selected-friend card also show the Steam level and badge count when Steam returns them. Profile search and public library lookups are limited to 20 requests per minute per client IP. `TRUSTED_PROXY_HOPS` selects the `X-Forwarded-For` entry counted from the right (default 2 for Firebase App Hosting).

## Firebase App Hosting

The default Firebase project is `quixotic-sol-510005-m4`. The `qit` backend in `us-central1` is configured for local source deployment at `https://qit--quixotic-sol-510005-m4.us-central1.hosted.app`. `firebase.json` connects this repository to that backend and has a Hosting rewrite to its Cloud Run service. The Hosting site ID is pending: replace `REPLACE_WITH_HOSTING_SITE_ID` in `firebase.json` with the created site ID, then set `NEXT_PUBLIC_BASE_URL` in `apphosting.yaml` to `https://<site-id>.web.app` before deploying. `apphosting.yaml` also references `STEAM_API_KEY` and `SESSION_SECRET` by secret name. App Hosting uses Application Default Credentials for Firestore. The backend runtime is `nodejs22`; `package.json` requires Node 22.13 through 22.x.

For a new project, create a Firestore database, create an App Hosting backend connected to `azwrth13/QIT`, and set secrets with `firebase apphosting:secrets:set STEAM_API_KEY` and `firebase apphosting:secrets:set SESSION_SECRET`. Grant that backend access to both secrets. For this project the backend and secret access already exist. Steam OpenID uses `<NEXT_PUBLIC_BASE_URL>/api/auth/steam-callback` as its return URL and that origin as its realm. After the Hosting site ID and base URL are set, deploy the application, Hosting rewrite, and Firestore rules with `firebase deploy --only apphosting,hosting,firestore`. Merging into `master` does not deploy; deployment is manual. `firestore.rules` denies direct client access; all data access runs on the server.

## Checks

Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Run the Firestore integration tests with `npm run test:firestore`, which starts the Firestore emulator. Pull requests and pushes to `master` run the checks plus a production dependency audit in GitHub Actions.

The PostCSS override keeps Next.js's transitive PostCSS dependency on a patched 8.x release.
