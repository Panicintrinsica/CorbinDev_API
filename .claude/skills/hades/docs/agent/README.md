# Hades — Agent Working Guide

Hades is the centralized authentication service for Impetus Studios projects. It is the source of
truth for AuthN: it owns user identity, credentials, MFA enrolment, federated identity links, and
token issuance. It does **not** own per-application authorization state.

This directory is the canonical specification set. Three entry points reference it — the Claude skill
(`.claude/skills/hades/SKILL.md`), `AGENTS.md`, and `GEMINI.md` — but the content lives here once so
it cannot drift between tools.

## Read this first

1. **[invariants.md](invariants.md)** — the security properties this service is required to hold.
   Read it before changing anything under `src/`. Most of these were violated at some point and fixed
   deliberately; the file records what the rule is and what breaks without it.
2. **[architecture.md](architecture.md)** — process shape, request lifecycle, storage, token model.
3. **[conventions.md](conventions.md)** — how code in this repo is written, and the checklist for
   adding an endpoint.

## Specifications

| Area | File | Covers |
|---|---|---|
| Security rules | [invariants.md](invariants.md) | Non-negotiable properties, with the failure each prevents |
| Architecture | [architecture.md](architecture.md) | Layers, request flow, cache, token lifecycle |
| Conventions | [conventions.md](conventions.md) | Error handling, logging, validation, adding endpoints |
| Data model | [data-model.md](data-model.md) | Collections, documents, indexes, migrations |
| Configuration | [config.md](config.md) | Environment variables, startup behaviour, failure modes |
| Auth endpoints | [api/auth.md](api/auth.md) | register, login, refresh, logout, password reset |
| Email verification | [api/email-verification.md](api/email-verification.md) | Confirming an address, staging an address change |
| MFA endpoints | [api/mfa.md](api/mfa.md) | TOTP, WebAuthn, recovery codes, factor removal |
| Social endpoints | [api/social.md](api/social.md) | Twitch, Discord, Epic, Steam |
| User endpoints | [api/user.md](api/user.md) | profile, password, account deletion |
| Admin endpoints | [api/admin.md](api/admin.md) | realms, clients, users, bans, internal validation |
| Security webhooks | [api/webhooks.md](api/webhooks.md) | Ban and revocation events pushed to relying services, and how to verify one |
| OIDC endpoints | [api/oidc.md](api/oidc.md) | Discovery document, JWKS, ID token shape |

`docs/*.md` (one level up) are older user-story documents written before the security pass. Where they
disagree with the files here, **these files are correct** — verify against `src/` if in doubt.

## Ground rules for changes

- **Never weaken an invariant to make a test or a client pass.** If a change requires it, stop and say
  so; the client is the thing that changes.
- **Do not introduce an ORM.** MongoDB is accessed through the driver directly.
- **Do not add a dependency for something a short standalone function can do.** Cryptography,
  protocol parsers, and the async runtime are the exceptions; string manipulation and validation are
  not.
- **Every token-issuing path goes through `request_context()`.** There are five of them; they must
  behave identically.
- **`cargo check`, `cargo clippy`, and `cargo test` must all pass** before you report a change done.
  On Windows, `cargo build` may fail to link while the server is running — that is a file lock, not a
  compile error; `cargo check` is the reliable signal.

## Current known gaps

Tracked in `SECURITY_AUDIT.md` at the repo root:

- No mail transport. The password reset and email verification flows are implemented end to end, but
  `src/email.rs` only logs; wire a sender in there and no handler changes. Until then, `DEV_MODE=true`
  returns the tokens in the response so both flows can be driven by hand.
- `REQUIRE_VERIFIED_EMAIL` must stay `false` for the same reason — with no delivery nobody can verify,
  and turning it on locks out every account.
- Security events are now persisted queryably — `iris` is an alias for `crates/lethe`, which writes
  them to an embedded SQLite file with a 30-day retention window and a text archive. Webhook
  deliveries are still not recorded: there is no delivery record and no replay endpoint, so a
  receiver that was down misses the event and falls back to `/internal/validate-session`.
