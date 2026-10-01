# Steam sign-in return-to for lobby join links

This feature enables redirecting users back to a specified `next` path after they successfully log in with Steam.

## Pre-auth Session
Since `validateOpenId` strictly requires an exact `return_to` parameter that matches the initial request, we cannot pass the `next` path dynamically on the URL. Instead, the `steam-login` route intercepts the `next` query parameter and stores it in a short-lived `__session` cookie payload (pre-auth session).

## Allow-list Validation
To prevent open redirects, the `next` path is strictly validated:
- The raw `next` value must exactly match `/lobby/<id>`, where `<id>` contains only letters, digits, `_` and `-`.
- Anything else (absolute or protocol-relative URLs, paths not starting with `/`, query strings, encoded characters, dot segments) is rejected.
- The callback re-validates the stored value before redirecting.

The pre-auth cookie expires after 10 minutes. Starting a sign-in without a valid `next` clears any leftover pre-auth payload, so an abandoned lobby join cannot redirect a later sign-in.

If the `next` path is invalid or missing, the callback falls back to the default post-login destination (`/library?autosync=1`).

A user who already has a valid session is not sent through Steam again: `steam-login` keeps the existing session and redirects straight to a valid `next` path, or to `/library` otherwise.
