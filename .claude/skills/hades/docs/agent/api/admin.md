# API — Administration and Internal

`src/routes/admin.rs`.

Every `/admin/*` route requires `Authorization: Bearer` **and** `g_superadmin` in the token's `scope`:

```rust
if !auth_user.roles.contains(&"g_superadmin".to_string()) {
    return Err(AppError::Forbidden);
}
```

That check is per-handler, not middleware. **A new admin route without it is unprotected** — this is
the single easiest mistake to make in this file.

Roles come from the token, so a demotion would otherwise take effect only when the access token
expired. `update_user_admin` therefore sets the revocation watermark on every call (invariant I7).

`/internal/*` is authenticated separately — see the bottom of this file.

---

## Realms

### `POST /admin/realms`

```json
{ "name": "guildhall" }
```

Returns the created realm with a generated UUID `_id`. `409` if the name exists (uniquely indexed).

### `GET /admin/realms`

Returns all realms. Unpaginated.

### `DELETE /admin/realms/{realm_id}`

Deletes the realm and **cascades to its clients**. `404` if absent.

> Users are not touched, and their `presence_registry` entries for the realm are left behind. Tokens
> already issued for the realm stay valid until they expire — `request_context()` will reject new
> ones because the client no longer exists.

---

## Clients

### `POST /admin/clients`

```json
{ "realm_id": "uuid-v4", "name": "web-app" }
```

`400` if the realm does not exist; `409` if the name is taken **within that realm** (an
application-level check, not an index).

### `GET /admin/clients`

All clients across all realms. Unpaginated, not filterable by realm.

Both return a `ClientResponse`, not the stored document: `_id`, `realm_id`, `name`, `webhook_url`,
`webhook_configured`, `created_at`. The stored `webhook_secret` is an HMAC key and is deliberately
absent — it is returned once, by the call that sets it, and never again.

### `PUT /admin/clients/{client_id}/webhook`

Registers, rotates, or clears where this client is told about bans and revocations.

```json
{ "url": "https://guildhall.example.com/hooks/hades" }
```

Returns the freshly generated `webhook_secret`, which is not recoverable afterwards. `{ "url": null }`
unregisters and discards the secret. `400` if the URL is not one this service will fetch (invariant
I23); `404` if the client does not exist.

Full contract, payloads, and receiver-side verification: **[webhooks.md](webhooks.md)**.

### `DELETE /admin/clients/{client_id}`

`404` if absent. Existing sessions for the client keep working until their tokens expire, but no new
ones can be minted.

---

## Users

### `GET /admin/users?query=<substring>`

Case-insensitive substring match on username and email. Omit `query` for everything.

`query` is capped at 128 characters and passed through `regex_escape()` before reaching `$regex`, so
it matches literally — unescaped input would let a search term compile to a pathological expression
and pin the server on a collection scan.

```json
[{
  "id": "uuid-v4", "username": "johndoe", "email": "john@example.com", "email_verified": false,
  "global_status": "active", "global_roles": ["g_subscriber"],
  "presence_registry": [], "mfa_enabled": true, "totp_enabled": true,
  "federated_identities": [], "created_at": "...", "updated_at": "..."
}]
```

`AdminUserResponse` never includes `password_hash`, `mfa.totp_secret`, `mfa.passkeys`, or recovery
codes — only the booleans `mfa_enabled` / `totp_enabled`. Keep it that way.

Unpaginated. Worth fixing before the user table gets large.

### `GET /admin/users/{user_id}`

One user, same shape. `404` if absent.

### `PUT /admin/users/{user_id}`

```json
{ "global_status": "active", "global_roles": ["g_subscriber", "g_superadmin"] }
```

Both fields are **required and absolute** — this replaces, it does not merge. Send the full role list.

After the write it **always** sets the revocation watermark, because roles ride in the access token
and a demotion is meaningless otherwise. If `global_status == "suspended_global"` it also revokes
every refresh token and fires the security webhook.

> No guard prevents an admin removing their own `g_superadmin`, and none prevents removing the last
> superadmin in the system. Recovery from that requires direct database access.

### `POST /admin/users/{user_id}/ban`

No body. Sets `global_status: "suspended_global"`, revokes all refresh tokens, sets the revocation
watermark, fires the webhook. `404` if absent.

Unbanning is `PUT /admin/users/{user_id}` with `global_status: "active"`.

### `POST /admin/users/{user_id}/revoke-tokens`

No body. Revokes all refresh tokens and sets the revocation watermark, without changing account
status. This is the "log out everywhere" operation. Always `200`, even for an unknown user.

---

## `POST /admin/utils/generate-keys`

No body. Returns a fresh PASETO v4.public keypair, hex-encoded:

```json
{ "private_key": "hex...", "public_key": "hex..." }
```

**Generates only — it does not install anything.** The keys are read from the environment at startup,
so rotating means updating `PASETO_PRIVATE_KEY` / `PASETO_PUBLIC_KEY` and restarting. Doing so
invalidates every access token immediately; refresh tokens survive, being opaque database rows.

> This returns private key material in an HTTP response body. It will be in any request log or proxy
> buffer that captures response bodies. Prefer `cargo run --bin check_keys` on the host.

---

## `POST /internal/validate-session`

**Not an admin route.** Authenticated by `X-Internal-Key`, compared against `INTERNAL_API_KEY` in
constant time. **If the variable is unset the route is closed, not open** (invariant I16).

For relying services to confirm that an access token's session is still live.

```json
{ "jti": "from the access token", "user_id": "from `sub`", "device_id": "from `did`" }
```

`200 {}` if a matching non-revoked `refresh_tokens` document exists and the user is not suspended.
`403` for every other case — unknown, revoked, mismatched, suspended, or absent user.

This works because `issue_tokens` uses **one identifier** for the access token's `jti` and the refresh
token's `_id` (invariant I17). They were previously independent UUIDs, so this endpoint returned `403`
for every legitimate call and any service relying on it was silently getting a blanket deny.

After a refresh, the **old** access token's `jti` points at a revoked row, so it fails here while
remaining cryptographically valid until expiry. That is the intended "this session was rotated"
semantics.

> Served on the same listener as the public API. Restrict `/internal/*` at the ingress as well; the
> key is a second line of defence, not the only one.

---

## Security webhooks

`dispatch_security_event` in `src/webhooks.rs`, called from `ban_user`, `revoke_user_tokens`, and
`update_user_admin`. Every client holding a registered webhook URL is POSTed a signed envelope
(`user_banned`, `user_unbanned`, `sessions_revoked`).

Dispatch is spawned, so no admin route waits on a receiver or fails because of one. Delivery is
at-least-once with bounded retries, and an event that exhausts them is dropped with a warning —
`/internal/validate-session` remains the authoritative check, not the webhook.

See **[webhooks.md](webhooks.md)** for the payload, the signature scheme, and what a receiver must
do. The security properties are invariant I23.
