# API — Email Verification

`src/routes/email_verification.rs`. Two public endpoints, plus the hooks the signup and
profile-update paths use to issue a link of their own.

The flow proves that the address on an account is a mailbox its holder can read. **A verification
token is not an authentication credential.** Redeeming one issues no session, changes no password,
and clears no factor. The most it ever does is promote an address the account already asked for from
`pending_email` into `email`. That is why its lifetime is measured in hours
(`EMAIL_VERIFICATION_TTL_MINUTES`, default 1440) rather than the reset token's minutes.

> **No mail is sent.** `src/email.rs` holds the transport hooks and is inert — every send logs a
> warning and returns `Ok(())`. Until a sender is wired in, exercise the flow through the `DEV_MODE`
> debug token below. Nothing else in the flow is stubbed; only delivery.

---

## Where the flag comes from

`users.email_verified` is set by exactly three things:

| Source | Value | Why |
|---|---|---|
| `POST /auth/register` | `false` | A signup address is a claim, not a proof |
| Social signup with a provider-asserted verified address | `true` | The provider established the same fact this flow does (invariant I9) |
| Social signup falling back to a `@federated.invalid` placeholder | `false` | Nothing to prove; the address cannot receive mail |
| `POST /auth/verify-email/confirm` | `true` | The link was redeemed |
| Bootstrap superadmin (`INIT_ADMIN_*`) | `true` | Provisioned out of band, before the service is reachable |

`@federated.invalid` is reserved for addresses this service mints. `register` and `PUT /user/profile`
both reject a caller-supplied address in that domain — it can never be verified, and it carries the
exemption described under `REQUIRE_VERIFIED_EMAIL`.

---

## `POST /auth/verify-email`

Public. No context headers, no bearer token — the common case is a signup whose first message was
lost, and that account may not hold a session yet.

```json
{ "email": "john@example.com" }
```

Always `200`. The body is `{}` in any normal deployment; when `DEV_MODE=true` it also carries
`debug_verification_token` so the flow can be exercised without a mail transport.

The response is identical for an unregistered address, an already-verified address, a suspended
account, and a rate-limited caller (invariant I15). Rate limit: 5 per hour per address
(`rl:verify:{email}`).

The address is matched against `email` **or** `pending_email`, under the case-insensitive collation,
so one endpoint serves both "confirm the address I signed up with" and "resend the link for the
address I am moving to".

When it resolves to an active account with something to prove:

1. A 32-byte token is drawn from `OsRng` and base64url-encoded.
2. `emailverify:{sha256(token)}` is written with `set_cache_if_absent` for
   `EMAIL_VERIFICATION_TTL_MINUTES`, holding `{user_id, email}`. The key is the *hash*, so cache
   access does not yield a usable token.
3. `crate::email::send_email_verification` is called with the assembled link.

| Status | Cause |
|---|---|
| `200` | Always |

---

## `POST /auth/verify-email/confirm`

Public. No context headers, no bearer token — requiring a session would break the case the flow
exists for, since the link opens in whatever browser the mail client hands it to.

```json
{ "token": "9Kf2..." }
```

```json
{ "email": "john@example.com", "email_verified": true }
```

1. Bound the token (non-empty, ≤128 bytes).
2. Read `emailverify:{sha256(token)}`, then **delete it before evaluating anything** — a rejected
   attempt must not leave the artifact usable (invariants I4, I13).
3. Load the user; `403` if suspended.
4. Decide which case this is by comparing the token's address against the account:
   - equals `pending_email` → **address change**;
   - equals `email` → **signup confirmation**;
   - neither → stale, `400`. The pending change was abandoned, a newer request replaced it, or an
     admin intervened.
5. **Address change.** `update_one` filtered on `{_id, pending_email}` sets `email`, sets
   `email_verified: true`, and `$unset`s `pending_email`. `matched_count == 0` means the pending
   address moved under the write → `400`. A duplicate-key error means another account claimed the
   address first → `409`. Then `crate::email::send_email_changed_notice` goes to the address being
   left behind.
6. **Signup confirmation.** Sets `email_verified: true`. Nothing else.

**No session is issued and no session is revoked.** This is not an authentication event in either
direction.

| Status | Cause |
|---|---|
| `200` | Verified |
| `400` | Unknown, expired, already-used, or stale token |
| `403` | Suspended account |
| `409` | The address was claimed by another account before the link was redeemed |

All `400` causes return the same string, `"Verification link is invalid or has expired"`.

---

## Interaction with the other routes

### `POST /auth/register`

After the user document is inserted, `issue_verification()` runs with `is_address_change: false`. A
failure there is logged and **does not fail the registration** — the account exists either way, and
`/auth/verify-email` can issue another link. See [auth.md](auth.md#post-authregister).

### `PUT /user/profile`

A new email address is written to `pending_email`, **not** to `email`. Login continues to resolve
against the old address until the link is redeemed. See [user.md](user.md#put-userprofile).

`pending_email` carries **no unique index**, deliberately: it is not an identity. Two accounts may
therefore hold the same pending address, and the first to confirm wins — the loser's token goes stale
at the uniqueness check on `email` and returns `409`. The `identity_taken()` check at staging time is
a courtesy that catches the common case early; the index is the arbiter (invariant I8).

### `POST /auth/login`

When `REQUIRE_VERIFIED_EMAIL=true`, an account with `email_verified: false` gets `403`, checked after
the password and the suspension check so account state is not disclosed to an unauthenticated caller.

An account whose address is a `@federated.invalid` placeholder is **exempt** — that address is minted
by this service, receives no mail, and can never be verified, so the policy would otherwise
permanently lock out every federated account whose provider asserted no verified address.

> **The flag must stay `false` until a mail transport is wired into `src/email.rs`.** With no
> transport, nobody can verify anything; enabling it locks out every existing account, superadmins
> included.

---

## What this does not solve

**Pre-hijack registration.** An attacker can still register with a victim's address and hold it
unverified. The victim then cannot register with their own address (`409` from `register`), and if
they later recover the account through a password reset, the attacker's session survives unless the
reset revokes it — which it does (invariant I21). Closing the registration side of this needs signup
to be gated on verification, which needs a mail transport first.

**Verification does not expire.** Once `email_verified` is true it stays true until the address
changes. There is no re-verification interval.

---

## Cache keys

| Key | Holds | TTL |
|---|---|---|
| `emailverify:{sha256(token)}` | `{user_id, email}` | `EMAIL_VERIFICATION_TTL_MINUTES` |
| `rl:verify:{email}` | Request counter | 1 hour |

The token itself is never stored anywhere — see invariant I22.
