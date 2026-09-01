---
name: hades
description: Working on the Hades authentication service (Rust/Axum/MongoDB centralized AuthN for Impetus Studios). Use when changing anything under src/ — auth, login, tokens, PASETO, refresh, MFA, TOTP, WebAuthn/passkeys, recovery codes, social/federated login (Twitch, Discord, Epic, Steam), realms, clients, admin routes, OIDC, or when reviewing this service for security issues.
---

# Hades

Centralized authentication for Impetus Studios projects. Rust + Axum + MongoDB, with optional Redis.
Owns identity, credentials, MFA, federated links, and token issuance. Does **not** own per-application
authorization.

## Before changing code

Read [`docs/agent/invariants.md`](docs/agent/invariants.md) first. It lists 23 security
properties this service is required to hold, each with the failure it prevents. Most were violated in
an earlier revision and fixed deliberately — they are not aspirational.

The ones that catch people out:

- **Every path that calls `issue_tokens` must call `request_context()` first.** No default realm, no
  default client. There are five such paths and they must behave identically.
- **Single-use artifacts are consumed before the operation they guard**, not after — MFA challenges,
  WebAuthn challenges, OAuth state, Steam nonces, password reset and email verification tokens.
- **Uniqueness is settled by the index, not by a prior read.** Handle the duplicate-key error on the
  write as well.
- **Identity queries need `.collation(case_insensitive_collation())`** or they will not agree with
  the unique indexes.
- **Removing an authentication factor requires the account password**, via
  `require_password_reauth()`.
- **An unverified address is never an identity.** A changed email is staged in `pending_email` and
  only becomes `email` when the confirmation link is redeemed — see
  [`docs/agent/api/email-verification.md`](docs/agent/api/email-verification.md).
- **The access-token revocation check fails closed.** Do not make it fail open.
- **Outbound webhooks are signed, and their URLs are validated before every send** — this service
  makes those requests from inside the perimeter. The signing secret is shown once and never
  serialised into a response; see
  [`docs/agent/api/webhooks.md`](docs/agent/api/webhooks.md).

## Reference

| Need | File |
|---|---|
| Security rules and why they exist | [docs/agent/invariants.md](docs/agent/invariants.md) |
| Layers, request flow, token model, cache | [docs/agent/architecture.md](docs/agent/architecture.md) |
| Error handling, logging, validation, adding an endpoint | [docs/agent/conventions.md](docs/agent/conventions.md) |
| Collections, documents, indexes, migrations | [docs/agent/data-model.md](docs/agent/data-model.md) |
| Environment variables and startup failure modes | [docs/agent/config.md](docs/agent/config.md) |
| register / login / refresh / logout | [docs/agent/api/auth.md](docs/agent/api/auth.md) |
| Email verification, staged address changes | [docs/agent/api/email-verification.md](docs/agent/api/email-verification.md) |
| TOTP, WebAuthn, recovery codes, factor removal | [docs/agent/api/mfa.md](docs/agent/api/mfa.md) |
| Twitch, Discord, Epic, Steam | [docs/agent/api/social.md](docs/agent/api/social.md) |
| Profile, password, account deletion | [docs/agent/api/user.md](docs/agent/api/user.md) |
| Outbound email hooks (unwired) | `src/email.rs` |
| Realms, clients, users, bans, `/internal` | [docs/agent/api/admin.md](docs/agent/api/admin.md) |
| Security webhooks: events, signing, receiver rules | [docs/agent/api/webhooks.md](docs/agent/api/webhooks.md) |
| Discovery, JWKS, ID token | [docs/agent/api/oidc.md](docs/agent/api/oidc.md) |

Start at [`docs/agent/README.md`](docs/agent/README.md) for the full index.

`docs/*.md` (the flat files one level up from `docs/agent/`) predate the security pass. Where they
disagree with `docs/agent/`, the latter is correct.

## Engineering posture

From the project owner, in `GEMINI.md`: security first, then performance. Minimise CPU and memory;
wasting either is treated as sloppy. Specifically:

- **No ORM.** MongoDB driver directly.
- **No dependency for what a short standalone function can do.** Cryptography, protocol
  implementations, and the async runtime are the exceptions.
- Argon2 dominates every password path — don't add a second hash to a request that already does one.

## Verifying a change

```
cargo check     # fast signal
cargo clippy    # no new warnings
cargo test      # unit tests for the pure validators
```

On Windows `cargo build` fails to link while the server is running (`Access is denied. (os error 5)`).
That is a file lock, not a compile error.

## Adding an endpoint

1. Decide what authenticates it — bearer token, password re-auth, `X-Internal-Key`, or public — and
   be able to justify it.
2. Token-issuing? `request_context()` first, `issue_tokens()` last, with a status check and rate
   limit between.
3. Weakens authentication? `MfaDisableRequest` + `require_password_reauth()`.
4. Consumes a single-use artifact? Delete it first, and key the cache on a hash of it rather than
   the artifact itself.
5. Register in `src/routes/mod.rs`, document in `docs/agent/api/`, update `invariants.md` if the
   change touches one.
6. Unit-test new pure validators.

## Known gaps

Tracked in `SECURITY_AUDIT.md`: **no mail transport.** The password-reset and email-verification
handlers are real end to end, but `src/email.rs` only logs, so no link ever reaches a mailbox — use
`DEV_MODE=true`, which returns both tokens in the response, and leave `REQUIRE_VERIFIED_EMAIL` off
until a sender is wired in. Security events are logged but not persisted queryably — including
webhook deliveries, which have no delivery record and no replay path, so an event a receiver missed
is gone. Don't build on top of these as though they work.
