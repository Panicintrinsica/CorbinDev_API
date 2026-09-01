# API — Authentication

`src/routes/auth.rs`. All paths mint or destroy sessions.

Common headers on every route here except `/auth/logout` and `/auth/reset-password`:

| Header | Required | Notes |
|---|---|---|
| `X-Client-ID` | yes | Must exist in `clients` |
| `X-Realm-ID` | yes | Must equal that client's `realm_id` |
| `X-Device-ID` | no | Defaults to `"unknown"`, max 128 bytes |

A missing or mismatched pair is `400`. See invariant I1.

The shared success body (`AuthResponse`) omits null fields:

```json
{
  "access_token": "v4.public....",
  "refresh_token": "6f1c...uuid",
  "id_token": "eyJhbGciOiJFUzI1NiIs..."
}
```

---

## `POST /auth/register`

Creates an account and immediately issues a session.

**Rate limit.** 5 per hour per client.

```json
{ "username": "johndoe", "email": "john@example.com", "password": "brisk-lantern-oyster-9" }
```

Processing order — each step can reject:

1. `request_context()`.
2. Rate limit.
3. `normalize_identity()` on username and email (trim, lowercase). **The normalised values are what
   get stored.**
4. `validate_username()` — 1–64 chars, no `@`, no whitespace or control characters.
5. `is_plausible_email()`.
6. `validate_password_strength()` — `PASSWORD_MIN_LENGTH`, ≤1024 bytes, ≥5 distinct characters, no
   well-known sequence.
7. Collision check under the case-insensitive collation.
8. Argon2id hash.
9. Insert; a duplicate-key error is caught and returned as `409` (the read in step 7 loses to a
   concurrent registration).
10. `update_presence()`.
11. Issue an email-verification link. A failure here is logged and **does not fail the
    registration** — see [email-verification.md](email-verification.md).
12. `issue_tokens()` with a new family.

New accounts get `global_roles: ["g_subscriber"]`, `global_status: "active"`, and
`email_verified: false`. An address in the reserved `@federated.invalid` domain is rejected at step 5
(invariant I22).

| Status | Cause |
|---|---|
| `400` | Bad headers, invalid identity, weak password, rate limited |
| `409` | `"Username or email already exists"` |

---

## `POST /auth/login`

```json
{ "identity": "johndoe", "password": "..." }
```

`identity` matches username **or** email, case-insensitively.

**Rate limit.** 10 per 15 min per identity, plus 200 per 15 min per client so an attacker cannot
spread guesses across accounts. Both are checked; either tripping returns `400`.

Order matters here:

1. `request_context()`, rate limit, `normalize_identity()`.
2. Lookup with `$or [{username}, {email}]` under the collation.
3. **Not found** → `dummy_verify_password()` to match Argon2 timing, then `401` (invariant I15).
4. Verify password → `401` on failure.
5. **Only then** check `global_status` → `403` if suspended. Checking earlier would disclose account
   status to an unauthenticated caller. When `REQUIRE_VERIFIED_EMAIL=true`, an unverified address is
   also `403` here — see [email-verification.md](email-verification.md).
6. `update_presence()`.
7. If `mfa.is_enabled`, store a `PendingMfaSession` and return the challenge (below).
8. Otherwise `revoke_device_sessions()` for this (user, client, device), then `issue_tokens()` with a
   new family.

**MFA challenge response** — `200`, no tokens:

```json
{ "mfa_required": true, "mfa_token": "uuid-v4" }
```

The `mfa_token` keys a 300-second cache entry holding `{user_id, client_id, realm_id, device_id}`.
Completion **must** present the same client/realm/device (invariant I5). Complete it at
[`/mfa/verify/totp`](mfa.md#post-mfaverifytotp) or
[`/mfa/webauthn/auth/finish`](mfa.md#post-mfawebauthnauthfinish).

| Status | Cause |
|---|---|
| `400` | Bad headers, rate limited |
| `401` | Unknown identity or wrong password — indistinguishable |
| `403` | Suspended, or unverified address while `REQUIRE_VERIFIED_EMAIL=true` |

---

## `POST /auth/refresh`

```json
{ "refresh_token": "6f1c...uuid" }
```

This is the most security-sensitive handler in the service. Read invariants I2 and I3 before touching
it.

1. `request_context()`.
2. Fetch the token **without** filtering on `is_revoked` — a revoked token being presented is the
   signal, not a miss.
3. **Reuse detection.** If `is_revoked`: revoke the entire `family_id` lineage, set the account's
   access-token revocation watermark, log at error level, return `401`.
4. Expiry check.
5. **Binding.** Stored `realm_id` / `client_id` / `device_id` must equal the request's. Mismatch is
   `401` at error level.
6. Load the user; `403` if suspended.
7. `update_presence()`.
8. **Rotation.** Revoke the presented token with `update_one` conditional on `is_revoked: false`. If
   `modified_count == 0`, a concurrent request won the race → `401`.
9. `issue_tokens()` **keeping the same `family_id`**.

A client that receives `401` here must re-authenticate from `/auth/login`. It must not retry.

| Status | Cause |
|---|---|
| `400` | Bad headers |
| `401` | Unknown, revoked, reused, expired, context mismatch, or lost the rotation race |
| `403` | Suspended |

---

## `POST /auth/logout`

No context headers, no authentication.

```json
{ "refresh_token": "6f1c...uuid" }
```

Revokes the **entire session family**, not just the presented token — logging out must not leave an
earlier rotation usable.

Always returns `200 {}`, including for an unknown token. Whether a token existed is not disclosed
(invariant I15).

Access tokens already issued remain valid until they expire. To cut those too, use
[`/admin/users/{user_id}/revoke-tokens`](admin.md) or change the password.

---

## `POST /auth/reset-password`

Public. No context headers.

```json
{ "email": "john@example.com" }
```

Always `200`. The body is `{}` in any normal deployment; when `DEV_MODE=true` it also carries
`debug_reset_token` so the flow can be exercised without a mail transport.

The response is identical for an unregistered address, a suspended account, and a rate-limited
caller (invariant I15). Rate limit: 5 per hour per address (`rl:reset:{email}`).

When the address resolves to an active account:

1. A 32-byte token is drawn from `OsRng` and base64url-encoded.
2. `pwreset:{sha256(token)}` is written with `set_cache_if_absent` for `PASSWORD_RESET_TTL_MINUTES`
   (default 30), holding `{user_id, password_fingerprint}`. The key is the *hash*, so cache access
   does not yield a usable token.
3. `crate::email::send_password_reset` is called with the assembled link.

`src/email.rs` has no transport wired in — it logs and returns `Ok(())`. Whatever gets wired in must
not block the response and must not surface a delivery error, or the endpoint becomes an
account-existence oracle again.

---

## `POST /auth/reset-password/confirm`

Public. No context headers, no bearer token — the reset token *is* the credential.

```json
{ "token": "8Jd1...", "new_password": "brisk-lantern-oyster-9" }
```

1. Bound the token (non-empty, <= 128 bytes).
2. Read `pwreset:{sha256(token)}`, then **delete it before evaluating anything** — a rejected attempt
   must not leave the artifact usable (invariants I4, I13).
3. Load the user; `403` if suspended.
4. Compare `sha256(password_hash)` against the stored fingerprint. A mismatch means the password moved
   since the link was issued, so the link is stale.
5. `validate_password_strength()` (invariant I20), then re-hash.
6. Revoke every refresh token for the user and set the access-token revocation watermark
   (invariant I7).
7. `crate::email::send_password_changed_notice`.

**MFA is not cleared.** A reset proves control of a mailbox, which is the thing a second factor exists
to be independent of. A user who has lost both uses a recovery code, or an admin.

| Status | Cause |
|---|---|
| `200` | Password replaced, all sessions revoked |
| `400` | Unknown, expired, already-used, or stale token; password fails policy |
| `403` | Suspended account |

All four `400` causes return the same string, `"Reset link is invalid or has expired"`.

---

## `POST /auth/verify-email` and `POST /auth/verify-email/confirm`

Public, both of them. Documented in full in
**[email-verification.md](email-verification.md)** — the flow spans `register`, `PUT /user/profile`,
and `login` as well, so it is written up in one place rather than split across three.
