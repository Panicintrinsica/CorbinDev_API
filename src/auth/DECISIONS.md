# Auth module — decision record

Written for a future port. Each entry is a choice that is **not** obvious from the
code, what it depends on, and what a re-implementation in another language or
framework has to preserve. Ordered roughly by how much a port depends on it.

Terminology: *Hades* is the central authentication service (Rust/Axum/MongoDB).
*This API* is any relying service. AuthN is Hades'. AuthZ is ours.

---

## D-1. Layering: pure core, ported edges

```
paseto.ts claims.ts authorize.ts webhook.ts   pure — bytes and data, no I/O
engine.ts session.ts config.ts ports.ts       I/O through interfaces, no framework
mongo/                                        storage adapter
hono/                                         framework adapter, glue only
```

**Why.** A port replaces one ring, not the whole thing. The rule that keeps it true:
*no file outside `hono/` may import from `hono`, and no file outside `mongo/` may
import from `mongoose`.* If a port has to touch `engine.ts`, something leaked.

**Port checklist.** Re-implement `AuthStore` and `SessionValidator` (ports.ts) and
the two adapter directories. Everything else transliterates.

## D-2. Framework use is limited to middleware and the error response

Hono appears in exactly three places: the middleware factory, the routers, and
`authErrorResponse`. Hono-specific conveniences (validators, `hono/jwt`, typed
helpers beyond `Variables`) are avoided on purpose. `c.get("auth")` /
`c.set("auth", ...)` is the only request-scope coupling, and it is one string
constant (`AUTH_CONTEXT_KEY`).

**Port note.** Express to `req.auth`; Axum to a request extension plus an extractor;
Fastify to a decorator. The middleware body is the same seven lines either way.

## D-3. PASETO v4.public verified in-process, no library

Hades access tokens are PASETO v4.public (Ed25519). Verification is: strip the
`v4.public.` header, base64url-decode, split the trailing 64-byte signature, rebuild
the PAE pre-auth string, one Ed25519 check. About 40 lines.

**Why not a library.** Hades' stated posture — "no dependency for what a short
standalone function can do". A PASETO library also drags in a key-management model
we do not need: there is exactly one key, and it arrives as hex in an env var.

**Load-bearing detail.** PAE is `le64(count) || (le64(len) || piece)*` over exactly
four pieces: header, message, footer, implicit assertion — **in that order, including
the empty ones**. Omitting an empty footer changes the signed bytes and every
verification fails. The high bit of each `le64` must be cleared.

**Port note.** Any Ed25519 verify works. `node:crypto`'s `verify(null, ...)` means
pure EdDSA; WebCrypto's `{name:"Ed25519"}` is the async equivalent.

## D-4. Public key as hex, parsed once

Hades publishes `PASETO_PUBLIC_KEY` as hex, so the module accepts hex and wraps the
32 raw bytes in the fixed Ed25519 DER SPKI prefix `302a300506032b6570032100` to make
a `KeyObject`. PEM is accepted too. Parsing happens in the `AuthEngine` constructor,
never per request.

**Port note.** Rotating the Hades keypair invalidates every access token instantly;
refresh tokens survive because they are database rows. There is no JWKS for the
*access* token — only the ID token has one. Do not build access-token verification on
`/oauth/jwks`.

## D-5. `iat`/`exp` are RFC 3339 strings in the access token

...and numeric seconds in the ID token. `claims.ts` accepts both so the same parser
can be reused if ID-token verification is ever added. A port that assumes numeric
epoch everywhere will reject every access token.

## D-6. The check order in `AuthEngine.authenticate`

1. bearer header, 2. signature, 3. claims (`exp`, `iat`, realm, client),
4. local revocation watermark, 5. Hades `/internal/validate-session`,
6. local principal (provision if new, reject if disabled), 7. permissions.

**Why 4 before 5.** Step 4 is a local read we already have to do (it lives on the
principal document), and a webhook we have processed is strictly fresher than a
cached session verdict. Doing it first also means a banned user never costs us a
network call.

**Why 6 after 5.** Do not create a local record for a token whose session is dead.

## D-7. Revocation is checked twice, from two directions

Access tokens are stateless, so "log out" cannot reach one. Two mechanisms:

- **Pull** — `POST /internal/validate-session` with `{jti, user_id, device_id}`.
  Authoritative. Works because Hades uses one identifier for the access token's `jti`
  and the refresh token's `_id` (invariant I17).
- **Push** — signed security webhooks (`user_banned`, `user_unbanned`,
  `sessions_revoked`) raise a local `revokedBefore` watermark on the principal.

**Why both.** Webhook delivery is at-least-once *and can fail entirely* — Hades keeps
no delivery record and has no replay endpoint. So the webhook is an optimisation, not
the check. Equally, the pull is cached for ~60s, so the webhook is what makes a ban
take effect immediately.

**Port note.** Keep both. Dropping the pull means trusting a lossy channel; dropping
the push means a ban takes up to the cache TTL plus the token TTL to bite.

## D-8. The watermark comparison is `iat <= revokedBefore`

Inclusive, and it compares against the token's **issue** time, mirroring Hades'
`access_revoked_before:{user_id}`. Written with `$max` so an out-of-order webhook can
never lower an existing watermark. An unban deliberately does **not** clear it:
Hades' own semantics are that an unban restores the ability to authenticate, not the
old sessions.

## D-9. Failure modes: closed by default, and stated per surface

| Surface | On error | Rationale |
|---|---|---|
| Principal/watermark read | **closed** (503) | Cannot see the watermark, so cannot honour it |
| `validate-session` | **closed** (503), configurable to `open` | Mirrors Hades invariant I7, which fails closed and says not to change that |
| Webhook signature | closed (401/400) | An unsigned event is forgeable by anyone who has seen one |
| Webhook apply failure | 503 so Hades retries | Dropping it leaves a banned user holding a live token |
| `touchLastSeen` | ignored | Presence is not a security property |
| Role seeding | logged, non-fatal | The process can still authorize correctly |

`HADES_ON_VALIDATOR_ERROR=open` exists so a Hades outage can degrade to
signature-only auth instead of taking the API down. It is a deliberate, documented
downgrade and is off by default.

## D-10. Negative session verdicts are cached; errors are not

A `403` from `validate-session` is cached (30s) because it only ever denies. A
`5xx`/timeout **throws** rather than caching, so a blip does not pin a user out for
the negative TTL. Distinguishing "denied" from "no answer" is the point.

## D-11. Configuration refuses to start when it cannot do its job

Missing public key means throw. Session validation on but no internal key or base URL
means throw. This copies Hades invariant I16's reasoning: an unset internal key
**closes** the check, it does not open it — silently skipping revocation because a
variable is absent is the exact failure this prevents. Turning validation off is
possible, but only by writing `HADES_SESSION_VALIDATION=off`.

An empty realm allow-list only warns, because a first-run integration legitimately
does not know its realm id yet. When `HADES_CLIENT_ID`/`HADES_REALM_ID` are set they
become the allow-lists automatically.

## D-12. `_id` of a principal **is** the Hades `sub`

A UUID string, not an ObjectId, and no mapping table. One identifier across services;
nothing can drift. Consequence: `provisionPrincipal` upserts with `$setOnInsert` so
two concurrent first requests converge — uniqueness is settled by the index, never by
a prior read (Hades invariant I8's reasoning).

## D-13. The local record stores no identity

No email, no username, no password anything. `displayName` is nullable, explicitly a
cache, and never used to resolve a user. Hades invariant I22 — an address it did not
verify is not an identity — means a copy held here would be worse than useless: it
would be a second, stale identity space.

**Consequence.** Admin UIs that want to show names must ask Hades
(`GET /admin/users?query=`), not this API.

## D-14. Permissions are strings; wildcards only on the grant side

`resource:action`, with `*` and `prefix:*` honoured in a **grant**. A requirement is
always literal, so `require("*")` asks for a permission literally named `*`. Denials
are applied last and are literal too: denying `articles:*` removes that wildcard
grant, not everything it would have matched.

An unknown role name grants nothing — a typo must never fail open.

**Port note.** `permits()` is 8 lines and fully specified by the tests. Keep the
literal-requirement rule; making requirements wildcard-matchable turns every typo
into a privilege escalation.

## D-15. Hades global roles are an escape hatch, not part of the permission set

Token `scope` (e.g. `g_superadmin`) is kept separate from local permissions and only
consulted via `PermissionRequirement.globalRoles`, where it satisfies the whole
requirement outright. It is never merged into the resolved permission set, so
`GET /auth/me` shows the two sources distinctly and a local role can never be
confused for a global one.

## D-16. Just-in-time provisioning

The first valid token for an unknown `sub` creates a principal with the roles marked
`isDefault` (or `AUTH_DEFAULT_ROLES`). There is no signup flow here — Hades already
did it. Set `AUTH_AUTO_PROVISION=false` for an API that only serves pre-authorized
users; unknown subjects are then refused with `principal_disabled`.

## D-17. Webhook signing is over the raw body bytes

`HMAC-SHA256(secret, "{timestamp}.{raw body}")`, hex, prefixed `v1=`. The route reads
`c.req.text()` and signs *that string*; re-serialising parsed JSON produces different
bytes and every signature fails. Timestamp skew over 300s is refused, comparison is
constant time, and `X-Hades-Event-Id` is de-duplicated by a unique `_id` insert
(duplicate-key means "already applied", not an error).

**Port note.** Any framework that parses JSON bodies by default has to be told not
to, or to keep the raw buffer, for this one route.

## D-18. Role definitions are cached in-process, keyed by the sorted role list

TTL `AUTH_ROLE_CACHE_TTL_SECONDS` (60s). Admin writes call
`engine.invalidateRoleCache()` so an edit through this API is immediate; an edit made
directly in the database takes up to the TTL, and only on the instance that did it —
the cache is per process. That is the accepted cost of not requiring Redis.

## D-19. `optionalAuth` rejects a bad token rather than ignoring it

An anonymous caller is fine. A caller who sent credentials that do not work is told
so, instead of being quietly served the public view and left wondering why their data
is missing.

## D-20. The frontend never speaks to Hades; this API is the gateway

`gatewayRoutes()` forwards Hades' credential, MFA, social and self-service routes,
mounted at the app root **under Hades' own paths** (`/auth/login`, `/mfa/*`,
`/user/*`, `/auth/social/*`).

**Why a gateway rather than direct browser-to-Hades calls.**
- `X-Client-ID` and `X-Realm-ID` are stamped server-side, so a browser cannot choose
  the realm its token is minted for (invariant I1) and the ids are never published.
- One origin: no second CORS surface, and Hades needs no allow-list entry per site.
- Hades stays reachable only from inside the perimeter, alongside `/internal/*`.

**Why the paths are identical to Hades'.** Client code is written from the Hades API
documentation verbatim, and moving a frontend on or off the gateway is a base-URL
change and nothing else.

**Rules the forwarder holds.** Status and body verbatim — never reshape an auth
response, the client's state machine is written against Hades' status codes. No
retries (a `401` from `/auth/refresh` means re-authenticate; invariant I3). No
inspection, caching or logging of bodies: they carry passwords, tokens, recovery
codes and WebAuthn material. Headers are added, never copied wholesale — the
`context` and `bearer` flags in the route table say exactly which go where.

**Why a table and not a catch-all `/*` proxy.** A wildcard forwarder would expose
`/admin/*` and `/internal/*` to the internet through this API. The table is an
allow-list; the two routes with path parameters validate them against a provider
allow-list and a base64url pattern before anything reaches a URL.

**Not forwarded, deliberately:** `/admin/*`, `/internal/*`, `/.well-known/*`,
`/oauth/jwks`. `/internal` is this API's own server-to-server channel; `/admin` is
excluded by the policy in D-24, not for want of a route.

## D-21. Error taxonomy has one status mapping

`AuthErrorCode` to status lives only in `statusForAuthError`: 401 for anything about
the token, 403 for authenticated-but-not-allowed, 503 for "we could not decide".
Bodies are terse; Hades invariant I15's reasoning about not disclosing account state
applies to a relying service too.

**Port note.** 503 rather than 401 for an unavailable dependency matters: a client
must not treat "Hades is down" as "your session ended" and throw the user into a
re-login loop.

## D-22. What is deliberately *not* here

- **No token minting.** This API never issues, refreshes or revokes a Hades token.
- **No password, MFA, or federated-identity handling.** All Hades'.
- **No ID token verification.** Nothing here needs it; `claims.ts` is already shaped
  to accept its numeric timestamps if that changes.
- **No distributed cache.** Per-process, deliberately — see D-18.
- **No `/internal` surface of our own.** If one is added, copy Hades invariant I16:
  an unset key closes the route.

## D-23. The pre-Hades auth code is gone

Deleted, not deprecated:

- `src/middleware/auth.ts` (`isAdmin()`) compared a bearer token to `AUTHPASS` — one
  shared secret, no identity, no revocation, no audit. Admin routes in `src/index.ts`
  now use `auth.requirePermission(...)`.
- `src/services/auth.service.ts` held local Argon2 hashing and `hono/jwt` signing.
  This API no longer stores credentials or mints tokens, so keeping it would only
  invite a second, unauthoritative login path.

`AUTHPASS` and `JWT_SECRET` are no longer read anywhere and can be removed from the
environment.

## D-24. Hades-level management is not reachable from this API at all

**The split.** The Hades application owns accounts: creation, credentials, MFA,
global roles, suspension, deletion. This API owns *membership of this site*: which
local roles and permissions a user holds, whether they may use it, and whether we
keep a record of them at all. Between the two sits self-service — profile, password,
MFA enrolment, account deletion — which is the user's own and is forwarded to Hades
unchanged by the gateway (D-20).

**Consequences, stated so nobody re-derives them wrongly:**

- No `/admin/*` route is proxied, and none should be added. If an operator needs to
  ban an *account*, they do it in the Hades application. Proxying it would put a
  realm-wide power behind this site's permission model, where a role edit here could
  escalate into account control everywhere.
- `POST /auth/principals/{id}/ban` is a **site** ban. It sets the local status to
  `disabled` and raises the local revocation watermark, so tokens already issued stop
  working *against this API*. The user's Hades session stays alive and every other
  service in the realm still accepts them. Anyone reading a ban as account-level will
  be wrong.
- `DELETE /auth/principals/{id}` forgets the local record. It is **not** a ban: with
  `autoProvision` on, the next valid token recreates the principal with the default
  roles. Ban to keep someone out; delete to reset them, or to clear up after an
  account that no longer exists in Hades.
- An unban does not restore sessions the ban killed — the watermark stays. Same
  semantics as a Hades unban (D-8), so the two behave alike.
- The local admin writes upsert, so a principal can be banned or granted a role
  before their first request ever arrives.

**Port note.** This is the decision most likely to be quietly broken by a port that
"helpfully" adds an admin proxy or makes delete imply ban. Keep both distinctions.
