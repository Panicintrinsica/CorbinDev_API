# API — Multi-Factor Authentication

`src/routes/mfa.rs`. Two factor types (TOTP, WebAuthn passkeys) plus recovery codes.

Routes split into three groups by what authenticates them:

| Group | Authenticated by | Routes |
|---|---|---|
| **Enrolment** | `Authorization: Bearer` | `totp/setup`, `totp/verify`, `webauthn/register/*` |
| **Completion** | An `mfa_token` from `/auth/login`, or nothing (passwordless passkey) | `verify/totp`, `webauthn/auth/*` |
| **Removal** | Bearer **and** the account password | `totp/disable`, `disable`, `passkeys/*/revoke`, `recovery/regenerate` |

`mfa.is_enabled` is recomputed on every change as `!passkeys.is_empty() || totp_secret.is_some()`. It
gates whether `/auth/login` challenges at all, so a stale value silently disables MFA.

---

## Enrolment — TOTP

### `POST /mfa/totp/setup`

Bearer. No body.

```json
{ "setup_id": "uuid-v4", "secret": "JBSWY3DPEHPK3PXP", "qr_code": "iVBORw0KG..." }
```

Generates SHA-1 / 6-digit / 30-second parameters (authenticator-app compatible) and caches the secret
for 600s under `totp_pending:{user_id}:{setup_id}`. **The key is namespaced by user id** so one
account's handle cannot be redeemed against another (invariant I13).

Nothing is written to the user document yet — an abandoned setup leaves no trace.

### `POST /mfa/totp/verify`

Bearer. Confirms enrolment by proving possession.

```json
{ "setup_id": "uuid-v4", "code": "123456" }
```

**Rate limit.** 10 per 10 min per user.

On success, writes `mfa.totp_secret`, sets `mfa.is_enabled: true`, generates **8 recovery codes**,
deletes the pending cache entry, and returns the codes:

```json
{ "recovery_codes": ["ABCD-EFGH", "..."] }
```

Codes are 8 characters from a 32-symbol alphabet excluding `I`, `O`, `0`, `1`, formatted `XXXX-XXXX`
(~40 bits). They are stored as Argon2 hashes and **shown exactly once**.

| Status | Cause |
|---|---|
| `400` | Expired/unknown `setup_id`, wrong code, rate limited |

---

## Enrolment — WebAuthn

### `POST /mfa/webauthn/register/start`

Bearer. No body. Returns the creation challenge and a `registration_id` keying a 300s cache entry at
`webauthn_reg:{user_id}:{registration_id}`.

```json
{ "options": { "publicKey": { "challenge": "...", "rp": {}, "user": {} } }, "registration_id": "uuid-v4" }
```

Pass `options` to `navigator.credentials.create()`.

### `POST /mfa/webauthn/register/finish`

Bearer.

```json
{ "registration_id": "uuid-v4", "data": { "id": "...", "rawId": "...", "response": {}, "type": "public-key" } }
```

The challenge is **deleted on retrieval, before verification** — one attempt per challenge. On
success the passkey is pushed to `mfa.passkeys` and `mfa.is_enabled` set.

A verification failure returns a bare `"Registration failed"`; the library error is logged but never
echoed, since it describes internal verification state.

---

## Completion

These finish a login. Both require the full context headers and both check the challenge against the
context recorded at password time (invariants I1, I5).

### `POST /mfa/verify/totp`

Headers: `X-Client-ID`, `X-Realm-ID`, `X-Device-ID` — **must match the `/auth/login` call that issued
the `mfa_token`.**

```json
{ "mfa_token": "uuid-v4", "code": "123456" }
```

`code` accepts either a TOTP code or a recovery code. Anything longer than 6 characters is tried as a
recovery code first.

1. `request_context()`.
2. Load the pending session; compare all four fields. Mismatch → burn the challenge, `401`.
3. **Count the attempt before evaluating it.** Over 5 → burn the challenge, `401` (invariant I4).
4. Load user; `403` if suspended.
5. Recovery path: for each unused code, Argon2-verify; on a match, claim it with a conditional
   `update_one` on `mfa.recovery_codes.{i}.is_used`. Only `modified_count == 1` counts as redeemed —
   this is what stops two concurrent requests spending the same code.
6. Otherwise TOTP: `check_current` against `mfa.totp_secret` (±1 step skew).
7. **Burn the challenge** — before issuing tokens, so it is single-outcome even if issuance fails.
8. `update_presence()`, `revoke_device_sessions()`, `issue_tokens()` with a new family.

Returns the standard `AuthResponse`.

| Status | Cause |
|---|---|
| `400` | Bad headers |
| `401` | Expired/unknown/exhausted challenge, context mismatch, wrong code, TOTP not enrolled |
| `403` | Suspended |

### `POST /mfa/webauthn/auth/start`

**Unauthenticated.** Two modes:

```json
{ "mfa_token": "uuid-v4" }      // second factor after password
{ "username": "johndoe" }        // passwordless — a passkey as the sole factor
```

The `username` branch is rate-limited to 20 per 15 min per identity, since it would otherwise be a
bulk account-existence oracle. An unknown user **and** a user with no passkeys both return `401`, so
the two are indistinguishable. Suspended accounts are rejected here too.

```json
{ "options": { "publicKey": { "challenge": "...", "allowCredentials": [] } }, "auth_id": "uuid-v4" }
```

Pass `options` to `navigator.credentials.get()`.

### `POST /mfa/webauthn/auth/finish`

Requires the full context headers.

```json
{ "auth_id": "uuid-v4", "mfa_token": "uuid-v4 (omit for passwordless)", "data": { } }
```

1. `request_context()`.
2. Fetch `webauthn_auth:{auth_id}` and **delete it immediately**, before verification — a captured
   assertion cannot be replayed and a failure cannot be retried (invariant I13).
3. If `mfa_token` is present: it must resolve to the same user **and** the same client/realm/device.
4. Load user; `403` if suspended.
5. `finish_passkey_authentication()`.
6. **Persist the signature counter** when `needs_update()` — `update_credential()` then write
   `mfa.passkeys` back. Skipping this disables cloned-authenticator detection.
7. Burn the `mfa_token` if one was used.
8. `update_presence()`, `revoke_device_sessions()`, `issue_tokens()` with a new family.

---

## Removal

All four take the same body and route through `require_password_reauth()`, which throttles to 10
attempts per 15 min per user. A bearer token proves a session exists, not that the owner is present
(invariant I12).

```json
{ "password": "..." }
```

### `POST /mfa/totp/disable`

Bearer + password. Clears `mfa.totp_secret`; `mfa.is_enabled` stays true if passkeys remain.

### `POST /mfa/passkeys/{cred_id}/revoke`

Bearer + password. `cred_id` is the base64url-unpadded credential id from
[`GET /user/profile`](user.md).

**This was `DELETE /mfa/passkeys/{cred_id}` and is now a POST.** It needs a request body for the
password, and a body on `DELETE` is unreliable through intermediaries.

`404` if no passkey matches. `mfa.is_enabled` is recomputed from what remains.

### `POST /mfa/disable`

Bearer + password. Clears TOTP **and** all passkeys, sets `mfa.is_enabled: false`.

Recovery codes are left in place but unreachable, since `/mfa/verify/totp` is only invoked when a
challenge was issued. Re-enrolling TOTP replaces them.

### `POST /mfa/recovery/regenerate`

Bearer + password. Requires TOTP to be enrolled (`400` otherwise). Replaces all 8 codes and returns
the new plaintext set once.

```json
{ "recovery_codes": ["ABCD-EFGH", "..."] }
```

---

## Client flow summary

```
POST /auth/login
  ├── AuthResponse with tokens          -> done, no MFA
  └── { mfa_required, mfa_token }
        ├── TOTP or recovery code:  POST /mfa/verify/totp          (same context headers)
        └── passkey:                POST /mfa/webauthn/auth/start  { mfa_token }
                                    POST /mfa/webauthn/auth/finish (same context headers)

Passwordless:  POST /mfa/webauthn/auth/start  { username }
               POST /mfa/webauthn/auth/finish (no mfa_token)
```

The context headers on every completion call must match the ones sent to `/auth/login`. A client that
load-balances across device ids, or omits them on the second call, will get `401`.
