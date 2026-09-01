# API — User Self-Service

`src/routes/user.rs`. All routes require `Authorization: Bearer <access_token>`. No context headers.

Everything here operates on `auth.user_id` from the token. **No handler takes a user id parameter** —
that is what keeps these routes free of an ownership check. Preserve that when adding to this module;
if a route ever needs to name another user it belongs in `admin.rs`.

---

## `GET /user/profile`

No body.

```json
{
  "id": "uuid-v4",
  "username": "johndoe",
  "email": "john@example.com",
  "email_verified": false,
  "pending_email": "new@example.com",
  "global_status": "active",
  "global_roles": ["g_subscriber"],
  "mfa_enabled": true,
  "totp_enabled": true,
  "passkeys": [{ "cred_id": "base64url-unpadded", "cred_type": "public-key" }],
  "created_at": "2026-08-29T12:00:00Z",
  "updated_at": "2026-08-29T12:00:00Z"
}
```

`cred_id` is the value to pass to
[`POST /mfa/passkeys/{cred_id}/revoke`](mfa.md#post-mfapasskeyscred_idrevoke).

`pending_email` is omitted when there is no address awaiting confirmation. It is **not** an identity —
login does not resolve against it. See [email-verification.md](email-verification.md).

`401` if the token's subject no longer exists.

This is also the `userinfo_endpoint` advertised in the OIDC discovery document, though it does not
return standard OIDC userinfo claims — see [oidc.md](oidc.md).

---

## `PUT /user/profile`

Changes username and/or email.

```json
{ "username": "newname", "email": "new@example.com", "password": "current password" }
```

All three fields are optional in the type, but **`password` is required whenever `username` or
`email` actually changes.** These are the fields login resolves against, so changing one is a
credential-level operation, not a preference (invariant I8).

1. Load the user.
2. Normalise the submitted values and drop any that equal the current value. If nothing changed,
   return the profile unmodified — **no password required for a no-op.**
3. Require and verify `password` → `401`.
4. Username: `validate_username()`, then `identity_taken()`. Applied immediately.
5. Email: `is_plausible_email()`, reject the reserved `@federated.invalid` domain, then
   `identity_taken()`. **Staged into `pending_email`, not applied.**
6. Update; a duplicate-key error is caught and returned as `409`.
7. If an address was staged, issue a verification link to it. A failure there is logged, not fatal —
   the account can request another at `POST /auth/verify-email`.

`identity_taken()` checks `$or [{username}, {email}]` against **other** documents under the
case-insensitive collation. Checking only the matching field would miss the cross-field collision that
makes the login lookup ambiguous.

**A new email address does not take effect here.** It is written to `pending_email` and becomes the
account's `email` only when the link sent to it is redeemed at `POST /auth/verify-email/confirm`
(invariant I22). Until then login still resolves against the old address, and the response body shows
the old `email` alongside the new `pending_email`.

`pending_email` carries no unique index, so two accounts may stage the same address; the first to
confirm wins and the other gets `409` at redemption. Full flow in
[email-verification.md](email-verification.md).

> No mail is actually sent — `src/email.rs` is inert. With `DEV_MODE=true`, drive the confirmation
> with the `debug_verification_token` from `POST /auth/verify-email`.

| Status | Cause |
|---|---|
| `400` | Invalid username or email; `password` missing while changing an identity field |
| `401` | Wrong password, or the token's subject no longer exists |
| `409` | Username or email already in use |

---

## `POST /user/password`

```json
{ "old_password": "...", "new_password": "..." }
```

1. Verify `old_password` → `401`.
2. `validate_password_strength(new_password)` → `400`.
3. Write the new Argon2id hash.
4. **Revoke every refresh token for the user.**
5. **Set the access-token revocation watermark.**

Steps 4 and 5 include the caller's own session. A password change is usually a response to
compromise, so every session goes — the client must re-authenticate rather than continuing with the
tokens it holds. This is deliberate; do not scope it to "other sessions".

Returns `200 {}`.

---

## `DELETE /user/account`

```json
{ "password": "..." }
```

Verifies the password, deletes the user document, deletes all refresh tokens, and sets the revocation
watermark.

The watermark matters because access tokens outlive the document they authenticate against — without
it a deleted account's token keeps passing the middleware until it expires.

Returns `200 {}`.

> Deletion is immediate and unrecoverable. There is no soft-delete, no grace period, and no export.
> `federated_identities` go with the document, so a subsequent social login provisions a **new**
> account with a fresh id.

| Status | Cause |
|---|---|
| `401` | Wrong password, or the token's subject no longer exists |
