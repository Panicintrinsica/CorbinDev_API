# Security Invariants

These are the properties Hades is required to hold. Each entry states the rule, where it is enforced,
and what breaks without it. Most were violated in an earlier revision and fixed deliberately — the
failure descriptions are not hypothetical.

**If a task appears to require breaking one of these, stop and raise it.** Do not work around it.

---

## I1. Every token-issuing path validates the same request context

**Rule.** `X-Client-ID` and `X-Realm-ID` are required, non-empty, and the client must belong to the
realm. `X-Device-ID` is optional, defaults to `"unknown"`, and is capped at 128 bytes.

**Enforced by.** `request_context()` in `src/routes/auth.rs`. Used by `register`, `login`, `refresh`,
`mfa_verify_totp`, `webauthn_auth_finish`, `social_redirect`, `social_callback`.

**Without it.** The MFA completion handlers previously defaulted to `client_id="direct"` /
`realm_id="default"`, letting a caller choose the `rid` claim stamped into the token they were about
to receive. Any downstream service authorizing on `rid` was bypassable.

**When adding a handler that calls `issue_tokens`, it must call `request_context()` first.** No
exceptions, no fallback defaults.

---

## I2. A refresh token is only valid in the context it was issued for

**Rule.** `refresh` compares the stored `realm_id`, `client_id`, and `device_id` on the token document
against the request headers. A mismatch is `401`, logged at error level.

**Enforced by.** The `--- BINDING ---` block in `refresh` (`src/routes/auth.rs`).

**Without it.** Validating only that the header pair is self-consistent lets a refresh token issued
for a low-privilege realm mint access tokens carrying any other valid realm's `rid`.

---

## I3. Refresh tokens rotate, and replay of a rotated token destroys the session family

**Rule.** Rotation *revokes* the presented token (`is_revoked: true`) rather than deleting it, so the
record survives until its natural `expires_at` and a replay still finds it. Presenting an already
revoked token revokes every token sharing its `family_id` and sets the account's access-token
revocation watermark.

**Enforced by.** The `--- REUSE DETECTION ---` and `--- ROTATION ---` blocks in `refresh`.

**Details that matter.**
- The rotation write is conditional on `is_revoked: false` and checks `modified_count`. That makes the
  database the arbiter between two concurrent uses of one token; the loser gets `401`.
- A fresh login starts a **new** family. Reuse of an old family's token therefore cannot take down a
  session the attacker never touched.
- `family_id` is `Option<String>`; a legacy token without one is treated as its own family.

**Without it.** Deleting rotated tokens destroys the only signal that a token was stolen, and keying
cleanup on the client-supplied `X-Device-ID` lets an attacker keep a parallel session alive simply by
sending a different device id.

---

## I4. An MFA challenge is single-outcome and attempt-bounded

**Rule.** The `mfa_session:{token}` cache entry is destroyed on success, on context mismatch, and once
5 attempts are spent. Every attempt is counted **before** it is evaluated.

**Enforced by.** `load_mfa_session`, `register_mfa_attempt`, `burn_mfa_session` in `src/routes/mfa.rs`.
`MFA_MAX_ATTEMPTS = 5`, TTL 300s.

**Without it.** A six-digit TOTP with ±1 step of skew has ~3 acceptable values in 10⁶. An unconsumed,
unthrottled challenge reduces the second factor to a few minutes of parallel guessing, and a
successful challenge stays replayable for its whole TTL.

---

## I5. The MFA challenge records its origin context and is checked against it

**Rule.** `login` stores `{user_id, client_id, realm_id, device_id}` as the pending session. Both
completion handlers compare all four against the current request and burn the challenge on mismatch.

**Enforced by.** `PendingMfaSession` in `src/routes/mfa.rs`.

**Without it.** I1's guarantee is undone one step later: the caller re-picks the realm at completion.

---

## I6. Suspended accounts cannot authenticate by any route

**Rule.** `global_status == "suspended_global"` is checked on `login`, `refresh`, `mfa_verify_totp`,
`webauthn_auth_start`, `webauthn_auth_finish`, and the social login path.

**Enforced by.** `ensure_active()` in `src/routes/mfa.rs`; explicit checks elsewhere.

**Without it.** A banned user holding a passkey could log in normally — `webauthn_auth_start` accepts a
bare username with no prior authentication, so this was a complete ban bypass.

**Note on ordering.** In `login` the status check runs *after* password verification, so account
status is not disclosed to an unauthenticated caller.

---

## I7. Access tokens are revocable

**Rule.** Access tokens are stateless PASETOs and cannot be individually withdrawn, so a per-user
watermark (`access_revoked_before:{user_id}`) is compared against each token's `iat` on every
authenticated request. Any action that should end a session sets it.

**Enforced by.** `revoke_access_tokens_for` / `access_token_is_revoked` in `src/state.rs`, checked in
`src/auth_middleware.rs`. Set by: ban, admin user update, token revocation, password change,
password reset, account deletion, refresh-token reuse detection.

**This check fails closed.** If the store cannot answer, the request is rejected. Do not change that
to fail open.

**Without it.** Ban and role changes only affected refresh tokens, so a banned superadmin kept full
authority for the remaining access-token TTL.

---

## I8. Identity fields are unique case-insensitively, and a username can never look like an email

**Rule.** Login resolves identity with `$or [{username}, {email}]` under an `"en"` secondary-strength
collation. Therefore:
- Unique indexes on `users.username` and `users.email` use **that same collation**.
- Stored values are normalised with `normalize_identity()` (trim + lowercase).
- `validate_username()` rejects `@`, whitespace, control characters, and anything over 64 chars.
- Changing either field requires the account password and a cross-field collision check.

**Enforced by.** `ensure_unique_identity_index` in `src/main.rs`; `validate_username`,
`normalize_identity` in `src/routes/auth.rs`; `identity_taken` in `src/routes/user.rs`.

**Without it.** A username set to a victim's email address makes that victim's login resolve to the
wrong document. A case-sensitive unique index admits `Victim@x.com` beside `victim@x.com` while the
lookup treats them as one.

**Startup behaviour.** If existing data collides case-insensitively the index cannot be built and the
service **refuses to start**, with an aggregation in the error message to find the offenders. That is
intentional — do not downgrade it to a warning.

---

## I9. Provider-supplied identity data is untrusted

**Rule.** For federated signup:
- A provider email is adopted **only** when the provider explicitly asserts it verified
  (`email_verified` / `verified`) *and* it is unclaimed. Otherwise a
  `{provider}.{id}@federated.invalid` placeholder is stored.
- Provider usernames are sanitised to `[A-Za-z0-9_.-]`, truncated, lowercased, and suffixed until
  unique.

**Enforced by.** `resolve_local_email`, `allocate_username` in `src/routes/social.rs`.

**Without it.** A provider handle is chosen by its owner, so it is an attacker-controlled input to
I8's identity space.

---

## I10. OAuth flows are CSRF-bound and single-use

**Rule.** `social_redirect` mints a random 32-byte `state`, stores
`{provider, client_id, realm_id, device_id, code_verifier}` under it for 600s, and returns it.
`social_callback` requires it, consumes it before anything else, and rejects any mismatch of provider
or request context. PKCE (S256) is used on Discord and Epic.

**Enforced by.** `OauthFlowState` in `src/routes/social.rs`.

**Without it.** The state parameter was the constant `"hades_state"` — no binding at all between the
browser that started a flow and the one that finished it, so an attacker could feed a victim their own
authorization code and silently link accounts.

**Twitch has no PKCE** because its authorization endpoint rejects unknown parameters. That is a
deliberate exclusion, recorded in `supports_pkce()`.

---

## I11. Steam OpenID assertions are validated field by field

**Rule.** Before a SteamID is trusted, all of the following are checked:

| Check | Why |
|---|---|
| `openid.ns` is OpenID 2.0 | Protocol sanity |
| `op_endpoint` is `https://steamcommunity.com/openid/login` | Another OP must not be able to assert a SteamID |
| `claimed_id`, `identity`, `op_endpoint`, `return_to`, `response_nonce` all appear in `openid.signed` | **The signature only covers listed fields.** A field read outside the list is attacker-controlled even when the assertion verifies |
| `claimed_id == identity` | Consistency |
| `claimed_id` matches `https://steamcommunity.com/openid/id/<digits>` exactly | `split('/').last()` accepted any URL shape |
| `return_to` equals the URL built for *this* flow's state | Binds the assertion to the flow |
| `response_nonce` is unseen (claimed via `set_cache_if_absent` **before** contacting Steam) | Blocks replay of a captured assertion |
| Steam's `check_authentication` reply contains a line equal to `is_valid:true` | Matched line-wise, not by substring |

**Enforced by.** `resolve_steam` in `src/routes/social.rs`.

**The signed-fields check is the load-bearing one.** Do not remove it on the grounds that Steam
verified the signature — Steam verifies the signature over the fields the *caller* listed.

---

## I12. Removing an authentication factor requires the account password

**Rule.** `/mfa/totp/disable`, `/mfa/disable`, `/mfa/recovery/regenerate`, and
`/mfa/passkeys/{cred_id}/revoke` all take `MfaDisableRequest { password }` and route through
`require_password_reauth()`, which throttles to 10 attempts per 15 minutes per user.

**Enforced by.** `require_password_reauth` in `src/routes/mfa.rs`.

**Without it.** A bearer token proves a session exists, not that the owner is present. An attacker with
a stolen access token could strip factors one at a time.

This is also why passkey revocation is `POST .../revoke` rather than `DELETE` — it needs a body, and a
request body on `DELETE` is unreliable through intermediaries.

---

## I13. WebAuthn state is single-use and the signature counter is persisted

**Rule.** `webauthn_reg:{user_id}:{id}` and `webauthn_auth:{id}` cache entries are deleted immediately
on retrieval, before verification. After a successful assertion, `update_credential()` is applied and
the passkey written back when `needs_update()` is true.

**Enforced by.** `webauthn_register_finish`, `webauthn_auth_finish` in `src/routes/mfa.rs`.

**Without it.** A captured assertion is replayable for the challenge's 300s TTL, and discarding the
counter disables the cloned-authenticator detection the counter exists to provide.

Challenge cache keys are namespaced by `user_id` so one account's handle cannot be redeemed against
another.

---

## I14. Authentication attempts are rate-limited

| Surface | Limit | Key |
|---|---|---|
| Login (per identity) | 10 / 15 min | `rl:login:id:{identity}` |
| Login (per client) | 200 / 15 min | `rl:login:client:{client_id}` |
| Registration | 5 / hour | `rl:register:{client_id}` |
| Password reset | 5 / hour | `rl:reset:{email}` |
| Passwordless passkey start | 20 / 15 min | `rl:wa_start:{identity}` |
| Factor-removal re-auth | 10 / 15 min | `rl:reauth:{user_id}` |
| TOTP enrolment verify | 10 / 10 min | `rl:totp_setup:{user_id}` |
| MFA challenge attempts | 5 per challenge | `mfa_attempts:{token}` |

**Enforced by.** `check_rate_limit` / `incr_cache` in `src/state.rs`.

**Rate limiting fails open** on a backend error, deliberately: a cache outage must not lock every user
out. The MFA attempt counter is the exception — it propagates its error and denies.

---

## I15. Responses do not disclose whether an account exists

**Rule.**
- `login` runs `dummy_verify_password()` on the not-found path so the timing matches a real Argon2
  verification.
- `webauthn_auth_start` returns `401` both for an unknown user and for a user with no passkeys.
- `/auth/reset-password` returns `200` unconditionally, including when rate-limited.
- `logout` returns `200` whether or not the token existed.

`register` still returns `409` on a taken identity — unavoidable for a usable signup form, and the
rate limit bounds its use for enumeration.

---

## I16. Internal endpoints authenticate

**Rule.** `/internal/*` requires `X-Internal-Key` matching `INTERNAL_API_KEY`, compared in constant
time. **If the variable is unset the route is closed, not open.**

**Enforced by.** `require_internal_caller`, `secret_eq` in `src/routes/admin.rs`.

They are served on the public listener, so restrict them at the ingress as well.

---

## I17. The access token's `jti` is the refresh token's `_id`

**Rule.** `issue_tokens` generates one `session_id` and uses it for both.

**Enforced by.** `issue_tokens` in `src/routes/auth.rs`.

**Without it.** They were two independent UUIDs, so `/internal/validate-session` — which looks up
`refresh_tokens._id` by the access token's `jti` — could never match and returned `403` for every
legitimate call. Any downstream service relying on it for revocation was silently getting a blanket
deny.

---

## I18. CORS is explicit outside development

**Rule.** `CORS_ALLOWED_ORIGINS` must list origins. A wildcard is permitted only when `DEV_MODE=true`,
and the server **refuses to start** otherwise.

**Enforced by.** `build_cors` in `src/main.rs`.

**Without it.** The API accepts bearer tokens and the tripartite client headers; reflecting arbitrary
origins hands any site the ability to drive it with a token it has obtained.

---

## I19. Startup never destroys data

**Rule.** A deserialization failure on the `users` collection returns a migration error. It must not
delete documents.

**Enforced by.** `bootstrap_system` in `src/main.rs`.

**Without it.** The previous code deleted **every user account** when an error string mentioned a date
format — a remotely-influenceable data-destruction path.

---

## I20. Password policy applies everywhere a password is set

**Rule.** `validate_password_strength()` gates registration, password change, and the bootstrap admin.
It enforces `PASSWORD_MIN_LENGTH` (default 12), a 1024-byte ceiling, at least 5 distinct characters,
and rejects well-known sequences.

**Enforced by.** `src/auth.rs`. Argon2id parameters are pinned explicitly (19 MiB, t=3, p=1) rather
than inherited from `Argon2::default()`, so a dependency bump cannot silently weaken them.
Verification still reads parameters from the stored PHC string, so older hashes continue to verify.

---

## I21. Password reset tokens are single-use, hashed at rest, and bound to one password

**Rule.**
- The token is 32 bytes of `OsRng`, and only `sha256(token)` ever leaves the request — it is the cache
  key, not the value.
- The cache entry is **deleted before** the reset is evaluated, so a rejected attempt does not leave a
  second try.
- The entry stores a fingerprint of the `password_hash` it was issued against. Any other password
  change invalidates every outstanding link.
- Completion revokes all refresh tokens and sets the access-token watermark, and does **not** clear
  MFA.

**Enforced by.** `reset_password_request`, `reset_password_confirm` in `src/routes/auth.rs`.

**Without it.** A token stored in plaintext makes read access to Redis or the `cache` collection
equivalent to takeover of every account with a pending reset. A token that survives a failed attempt
is not single-use. Clearing MFA on reset reduces every account to the security of its mailbox.

`src/email.rs` holds the delivery hooks and is currently inert. Delivery must stay off the response
path: a slow or failing provider on the account-exists branch reintroduces the timing oracle
invariant I15 closes.

---

## I22. An unverified address is never an identity

**Rule.**
- `users.email_verified` records whether the address was proven; it is `false` on every fresh signup.
- A change of address is staged in `users.pending_email` and becomes `email` **only** when the
  confirmation link is redeemed. Login never resolves against `pending_email`, and it carries no
  unique index because it is not an identity.
- Verification tokens follow the same rules as reset tokens: 32 bytes of `OsRng`, stored only as
  `emailverify:{sha256(token)}`, and deleted before the redemption is evaluated.
- Redeeming one issues no session, revokes none, changes no password, and clears no factor.
- The promotion into `email` is settled by the unique index, not by the prior read — two accounts may
  hold the same `pending_email` and the first to confirm wins (invariant I8).
- `@federated.invalid` is reserved for addresses this service mints. `register` and `update_profile`
  both reject a caller-supplied address in that domain.

**Enforced by.** `verify_email_request`, `verify_email_confirm`, `issue_verification` in
`src/routes/email_verification.rs`; the staging branch of `update_profile` in `src/routes/user.rs`.

**Without it.** Writing an unconfirmed address straight into `email` means any account can point its
recovery mailbox at an address it does not control — or, worse, at an address someone else is about
to register. Every password reset issued afterwards goes to the attacker's chosen mailbox, so the
whole of I21 rests on this.

`REQUIRE_VERIFIED_EMAIL` gates password login on the flag. It is off by default and **must stay off
until a transport is wired into `src/email.rs`** — with no delivery, nobody can verify, and enabling
it locks out every account. Accounts holding a `@federated.invalid` placeholder are exempt, because
that address can never be verified (invariant I9).

---

## I23. Outbound webhooks are signed, and cannot be aimed inside the perimeter

**Rule.**
- Every security event is POSTed with `X-Hades-Signature: v1={HMAC-SHA256(secret, "{timestamp}.{body}")}`.
  The timestamp is inside the signed string, so a captured request expires rather than replaying
  forever.
- The signing secret is 32 bytes of `OsRng`, returned **once** from the call that registers the URL,
  and never logged, listed, or read back. `Client` is never serialised straight into a response;
  admin handlers return `ClientResponse`.
- A webhook URL is validated when it is registered **and again before every send**: `https` only,
  no embedded credentials, no IP literal, no `localhost` / `.local` / `.internal` / `.home.arpa`, no
  bare hostname. `DEV_MODE=true` relaxes the transport checks, never the signing.
- Redirects are not followed, so the receiver cannot redirect a request to a target that would have
  failed validation.
- Dispatch is spawned. No admin route waits on a receiver, and no delivery failure changes the
  response the admin sees.

**Enforced by.** `validate_webhook_url`, `sign_payload`, `deliver_one` in `src/webhooks.rs`; the
redirect policy on the shared client in `src/main.rs`; `set_client_webhook` and `ClientResponse` in
`src/routes/admin.rs`.

**Without it.** An unsigned event is a URL anyone who has seen one can forge — "unban this user" is
not something a relying service should accept from an unauthenticated POST. Unvalidated URLs turn a
superadmin typo, or a stolen superadmin token, into an SSRF: this service sits inside the perimeter
and will happily fetch a cloud metadata endpoint on request. Following redirects hands that decision
back to whoever controls the receiver.

Delivery is at-least-once and can fail outright — a receiver that was down misses the event. The
webhook is a notification; `/internal/validate-session` (invariant I16) remains the authoritative
check, and must not be removed on the strength of this one. See
[api/webhooks.md](api/webhooks.md).
