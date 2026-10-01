# Steam sign-in return-to for lobby join links

This feature enables redirecting users back to a specified `next` path after they successfully log in with Steam.

## Pre-auth Session
Since `validateOpenId` strictly requires an exact `return_to` parameter that matches the initial request, we cannot pass the `next` path dynamically on the URL. Instead, the `steam-login` route intercepts the `next` query parameter and stores it in a short-lived `__session` cookie payload (pre-auth session).

## Allow-list Validation
To prevent open redirects, the `next` path is strictly validated:
- Only same-origin relative paths are accepted.
- Accepted paths must match `/library*` or `/lobby/*`.
- Absolute URLs, protocol-relative `//` URLs, backslashes, and encoded variants are rejected.

If the `next` path is invalid or missing, the callback falls back to the default post-login destination (`/library?autosync=1`).
