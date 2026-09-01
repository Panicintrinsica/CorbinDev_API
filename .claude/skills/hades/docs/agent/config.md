# Configuration

Everything is read once by `Config::from_env()` in `src/config.rs`, after `dotenvy` loads `.env`.
`.env.example` is the reference copy. **`.env`, `private.pem`, and `public.pem` are gitignored — keep
it that way.**

## Required — the process panics without them

| Variable | Notes |
|---|---|
| `MONGODB_URI` | |
| `MONGODB_DB_NAME` | |
| `PASETO_PRIVATE_KEY` | Hex-encoded Ed25519 secret key for v4.public. Generate with `cargo run --bin check_keys` |
| `PASETO_PUBLIC_KEY` | Hex-encoded matching public key |

## Logging — read by `crates/lethe`, not by `Config::from_env()`

Security-event logging is embedded. `iris::init()` (the alias for `lethe::init()`) opens a local
SQLite file, and a single background thread batches inserts into it. Startup fails loudly if that
file cannot be created, the same way the old TCP client failed on a bad `CLIENT_ID`.

All optional, all defaulted: `LOG_DB_PATH` (`./logs/hades.db`), `LOG_ARCHIVE_DIR`,
`LOG_RETENTION_DAYS` (30), `LOG_LEVEL` (`trace`), `LOG_BATCH_SIZE` (256),
`LOG_FLUSH_INTERVAL_MS` (1000), `LOG_QUEUE_CAPACITY` (4096), `LOG_CACHE_KB` (256),
`LOG_MAX_MESSAGE_BYTES` (8192), `LOG_MAX_DB_MB` (256), `LOG_MAINTENANCE_INTERVAL_SECS` (21600),
`LOG_ECHO` (off), `CLIENT_ID` (recorded once in `meta`).

`IRIS_URL` is accepted and ignored, so an existing `.env` needs no edit. Full reference, including
the retention and archive behaviour, in [`crates/lethe/README.md`](../../crates/lethe/README.md).

## Conditionally required — the process exits with a message

| Variable | Condition |
|---|---|
| `CORS_ALLOWED_ORIGINS` | Required unless `DEV_MODE=true`. Comma-separated absolute origins. `*` is rejected outside dev mode (invariant I18) |
| `INTERNAL_API_KEY` | Required for `/internal/*` to function at all. Unset means those routes are **closed**, not open (invariant I16) |

## Optional

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Binds `0.0.0.0` |
| `DEV_MODE` | `false` | `true`/`1` only. Permits a wildcard CORS origin |
| `REDIS_URI` | unset | Absent or unreachable falls back to MongoDB for all caching |
| `ACCESS_TOKEN_TTL_MINUTES` | `15` | Also the ID token TTL and the base for the revocation watermark TTL |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | |
| `PASSWORD_MIN_LENGTH` | `12` | Applies to registration, password change, and the bootstrap admin |
| `PASSWORD_RESET_TTL_MINUTES` | `30` | Lifetime of a reset token. Floored at 1 minute |
| `PASSWORD_RESET_URL_BASE` | `{REDIRECT_URI_BASE}/reset-password` | The page that collects the new password; the token is appended as `?token=...` |
| `EMAIL_VERIFICATION_TTL_MINUTES` | `1440` | Lifetime of a verification token. Floored at 1 minute. Longer than a reset token on purpose — it grants no session |
| `EMAIL_VERIFICATION_URL_BASE` | `{REDIRECT_URI_BASE}/verify-email` | The page that submits the verification token; the token is appended as `?token=...` |
| `REQUIRE_VERIFIED_EMAIL` | `false` | `true`/`1` only. Refuses password login to an account whose address is unverified. **Leave false until a mail transport is wired into `src/email.rs`** — otherwise nobody can verify and every account is locked out (invariant I22) |
| `WEBHOOK_TIMEOUT_SECONDS` | `5` | Per-request timeout on outbound security webhooks |
| `WEBHOOK_MAX_ATTEMPTS` | `3` | Delivery attempts per event per recipient, with a 2s/4s/… backoff. `0` behaves as `1` |
| `OIDC_ISSUER` | `WEBAUTHN_RP_ORIGIN` | The `iss` claim and the discovery document's issuer |
| `WEBAUTHN_RP_ID` | `localhost` | The registrable domain. Changing it invalidates every enrolled passkey |
| `WEBAUTHN_RP_ORIGIN` | `http://localhost:3000` | Full origin URL; must parse as a URL |
| `WEBAUTHN_RP_NAME` | `Hades Auth` | Display name; also the TOTP issuer label |
| `REDIRECT_URI_BASE` | `http://localhost:4200` | The SPA host. Social redirect URIs are built from it and must match what is registered with each provider |
| `INIT_ADMIN_USERNAME` / `_EMAIL` / `_PASSWORD` | unset | Bootstrap superadmin, created only when `users` is empty |
| `RUST_LOG` | `hades=debug,tower_http=debug` | |

### Provider credentials

`TWITCH_CLIENT_ID` / `_SECRET`, `DISCORD_CLIENT_ID` / `_SECRET`, `EPIC_CLIENT_ID` / `_SECRET`. Each
provider is unavailable (400 on its routes) when its pair is unset. Steam needs no credentials.

## Startup failure modes

All of these are intentional. A misconfigured auth service should not be reachable.

| Condition | Behaviour |
|---|---|
| Missing required variable | Panic from `.expect()` in `Config::from_env` |
| `users` holds case-insensitively colliding identities | Exit; the message includes an aggregation to list them |
| `INIT_ADMIN_PASSWORD` fails the password policy | Exit |
| `users` contains legacy string dates | Exit with a migration message — **never** deletes data (invariant I19) |
| No CORS allow-list outside dev mode | Exit |
| Redis unreachable | Warn and fall back to MongoDB — **not** fatal |

## Key material

- **PASETO keypair** — environment only. Rotating it invalidates every access token immediately;
  refresh tokens survive because they are opaque database rows. `POST /admin/utils/generate-keys`
  generates a fresh pair for a superadmin but does not install it.
- **OIDC signing key** — generated on first start into `oidc_keys`, stored as unencrypted PEM. Anyone
  with database read access can mint ID tokens. Rotation is not implemented (see
  [data-model.md](data-model.md)).
- **`private.pem` / `public.pem`** — present in the working tree, gitignored, not read by the current
  code. Leftovers from an earlier revision.

## Deployment

`Dockerfile` and `docker-compose.yml` are at the repo root. `CLOUDFLARE_TUNNEL_TOKEN` in
`.env.example` is consumed by compose, not by the application.

Because the tunnel terminates in front of the service, **restrict `/internal/*` at the ingress in
addition to `INTERNAL_API_KEY`.** The key is a second line of defence, not the only one.
