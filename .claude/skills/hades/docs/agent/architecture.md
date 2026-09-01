# Architecture

## Shape

A single Axum binary. No background workers, no message bus. MongoDB is the system of record; Redis
(or Dragonfly) is an optional cache with a MongoDB fallback for every operation.

```
src/
  main.rs             Startup: config, Mongo, indexes, bootstrap, Redis, WebAuthn, CORS, serve
  config.rs           Config::from_env() — every tunable, read once
  state.rs            AppState: db, redis, config, webauthn + cache/rate-limit/revocation primitives
  models.rs           BSON document types
  auth.rs             Password hashing, password policy, PASETO mint/verify, OIDC JWT mint
  auth_middleware.rs  AuthenticatedUser extractor — the only thing that trusts an access token
  errors.rs           AppError -> HTTP response mapping
  email.rs            Transactional mail hooks — no transport wired in yet
  routes/
    mod.rs            The route table
    auth.rs           Registration, login, refresh, logout + shared request-context helpers
    mfa.rs            TOTP, WebAuthn, recovery codes, factor removal
    social.rs         Federated identity (Twitch, Discord, Epic, Steam)
    user.rs           Self-service profile, password, deletion
    admin.rs          Realm/client/user administration + /internal
    oidc.rs           Discovery document and JWKS
  bin/check_keys.rs   Generates a PASETO v4.public keypair
```

`src/routes/auth.rs` is the shared foundation. `request_context`, `normalize_identity`,
`case_insensitive_collation`, `is_plausible_email`, `validate_username`, `issue_tokens`,
`revoke_device_sessions`, and `update_presence` all live there and are used across the other route
modules. Put new cross-cutting helpers there rather than duplicating them.

## Request lifecycle

**Authenticated request** (anything taking `AuthenticatedUser`):

1. `AuthenticatedUser::from_request_parts` requires `Authorization: Bearer <paseto>`.
2. `validate_paseto_v4_public` verifies the Ed25519 signature and the `exp`/`iat`/`nbf` claims
   (`ClaimsValidationRules::new()` validates all three by default).
3. `sub` becomes `user_id`; `scope` becomes `roles`.
4. `iat` is compared against the account's revocation watermark. **Fails closed** — see invariant I7.
5. The handler runs. Role checks are the handler's job:
   `if !auth_user.roles.contains(&"g_superadmin".to_string())`.

The middleware deliberately does **not** load the user document. Handlers that need it fetch it. This
keeps unauthenticated-adjacent routes cheap and makes the DB read explicit where it matters.

**Token-issuing request** (login, register, refresh, MFA completion, social callback):

1. `request_context()` — required headers, client-belongs-to-realm check (invariant I1).
2. Rate limit.
3. Credential verification (password / TOTP / assertion / provider handshake).
4. `global_status` check (invariant I6).
5. `update_presence()`.
6. `revoke_device_sessions()` where the flow starts a new session.
7. `issue_tokens()`.

## Token model

Three artifacts, all minted together by `issue_tokens`:

| Artifact | Format | Lifetime | Stateful? |
|---|---|---|---|
| `access_token` | PASETO **v4.public** (Ed25519) | `ACCESS_TOKEN_TTL_MINUTES`, default 15 | No — revoked via watermark |
| `refresh_token` | Opaque UUID (the `_id` of a `refresh_tokens` document) | `REFRESH_TOKEN_TTL_DAYS`, default 30 | Yes |
| `id_token` | JWT **ES256**, `kid` from `oidc_keys` | Same as access token | No |

The access token and refresh token share one identifier — see invariant I17.

Access token claims:

```
sub    Global user id (UUID)
iat    RFC 3339 issue time      -- compared against the revocation watermark
exp    RFC 3339 expiry
jti    Session id == refresh token _id
scope  Global roles, e.g. ["g_subscriber"]
rid    Realm id
cid    Client id
did    Device id
```

`scope` carries **global roles only**. Hades is realm-agnostic: per-application permissions are the
relying application's concern. The `rid`/`cid`/`did` claims tell that application which context the
token was minted in — which is exactly why invariants I1, I2, and I5 exist.

## The tripartite context

Every token is scoped to a *realm* (a security domain), a *client* (an application within it), and a
*device* (a caller-chosen session scope).

- `X-Client-ID` — required, must exist in `clients`.
- `X-Realm-ID` — required, must match the client's `realm_id`.
- `X-Device-ID` — optional, defaults to `"unknown"`, capped at 128 bytes. It only scopes sessions;
  it is not a trust boundary. Never make a security decision on it alone.

## Cache layer

`AppState` exposes cache primitives that use Redis when available and fall back to the `cache`
collection in MongoDB. The fallback is not an afterthought — the service is expected to run correctly
with `REDIS_URI` unset.

| Method | Purpose | Fallback strategy |
|---|---|---|
| `set_cache` | Store with TTL | Upsert with `expires_at` |
| `get_cache` | Read | Read, checking `expires_at` inline (the TTL monitor only sweeps once a minute) |
| `delete_cache` | Remove | Delete from both |
| `incr_cache` | Atomic counter with TTL on first write | `find_one_and_update` with `$inc` + upsert |
| `set_cache_if_absent` | Single-use claim | `insert_one`; a duplicate-key error means someone else won |
| `check_rate_limit` | `incr_cache` + threshold | Fails **open** on error |
| `revoke_access_tokens_for` / `access_token_is_revoked` | Access token watermark | Fails **closed** on error |

Keys in use:

```
mfa_session:{token}                  Pending MFA challenge (JSON PendingMfaSession), 300s
mfa_attempts:{token}                 Attempt counter for that challenge
totp_pending:{user_id}:{setup_id}    Un-confirmed TOTP secret, 600s
webauthn_reg:{user_id}:{reg_id}      Registration challenge, 300s
webauthn_auth:{auth_id}              Authentication challenge, 300s
oauth_state:{state}                  OauthFlowState, 600s
steam_nonce:{nonce}                  OpenID replay guard, 3600s
pwreset:{sha256(token)}              Pending password reset, PASSWORD_RESET_TTL_MINUTES
access_revoked_before:{user_id}      Revocation watermark, access TTL + 120s
rl:*                                 Rate limit counters
```

Anything single-use is consumed *before* the operation it guards, not after.

## Startup sequence

`main()` runs in this order, and each step can abort the process:

1. Tracing and `iris` logging.
2. `Config::from_env()` — panics on a missing required variable.
3. MongoDB connect + ping.
4. `ensure_indexes()` — **can refuse to start** on colliding identities (invariant I8).
5. `bootstrap_system()` — default realm and client, first superadmin. **Can refuse to start** on a
   weak `INIT_ADMIN_PASSWORD` or a legacy date format (invariant I19).
6. `bootstrap_oidc_subsystem()` — generates a P-256 keypair if no active key exists.
7. Redis connect (best-effort; falls back to MongoDB on any failure).
8. WebAuthn builder from `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_ORIGIN`.
9. `build_cors()` — **can refuse to start** outside dev mode without an allow-list (invariant I18).
10. Serve on `0.0.0.0:$PORT`.

Refusing to start is the intended behaviour in all three cases. A misconfigured auth service should
not be reachable.

`GET /health` is registered outside `create_router` and returns the literal string `OK`. It is
unauthenticated and checks nothing — not MongoDB, not Redis, not whether an active OIDC key exists. It
proves the process is accepting connections and nothing more. Do not use it as a readiness probe
without extending it.
