# API — Federated Identity

`src/routes/social.rs`. Providers: `twitch`, `discord`, `epic` (OAuth 2.0 / OIDC) and `steam`
(OpenID 2.0).

Both routes require the full context headers (`X-Client-ID`, `X-Realm-ID`, `X-Device-ID`). The
redirect endpoint requires them too — the flow is bound to a validated client from the outset.

Two invariants govern this file: **I10** (state and PKCE) and **I11** (Steam assertion validation).
Read both before changing anything here.

---

## `GET /auth/social/{provider}/redirect`

Returns the URL to send the browser to, plus the `state` the client must retain.

```json
{
  "url": "https://discord.com/api/oauth2/authorize?client_id=...&state=xK3n...&code_challenge=...",
  "state": "xK3n9fQ2..."
}
```

`state` is 32 random bytes, base64url. It keys a 600-second cache entry holding:

```rust
OauthFlowState { provider, client_id, realm_id, device_id, code_verifier: Option<String> }
```

PKCE (S256) is applied to **Discord and Epic**. Twitch is excluded because its authorization endpoint
rejects unknown parameters — see `supports_pkce()`. Steam has no equivalent.

Steam has no `state` parameter in OpenID 2.0, so the value is carried in `openid.return_to`, which is
covered by the signature and verified on the way back.

`400` if the provider is unknown or its credentials are unset.

---

## `POST /auth/social/{provider}/callback`

```json
{ "state": "xK3n9fQ2...", "code": "authorization code (OAuth providers)", "steam_params": {} }
```

`state` is **required for every provider, Steam included.**

1. `request_context()`.
2. Fetch `oauth_state:{state}` and **delete it immediately** — single use regardless of outcome.
3. The stored provider, client, realm, and device must all match the current request. Any mismatch is
   `400` at error level.
4. Provider handshake (below).
5. Look up `federated_identities.$elemMatch { provider, provider_user_id }`.
   - **Found** → `403` if suspended, else `update_presence()` and `issue_tokens()`.
   - **Not found** → provision a new account (below).

### Provisioning a new federated account

Accounts are **never linked by email.** Only `provider_user_id` joins a provider account to a local
one. A provider handle is chosen by its owner and is therefore attacker-controlled (invariant I9).

**Username** — `allocate_username()`: filter to `[A-Za-z0-9_.-]`, truncate to 40, lowercase. Empty
falls back to the provider name. Then probe for collisions and append a random suffix, up to 6
attempts, before `409`.

**Email** — `resolve_local_email()`: the provider address is adopted **only** if the provider asserts
it verified *and* it is unclaimed. Otherwise `{provider}.{social_id}@federated.invalid` is stored
(`.invalid` is reserved by RFC 2606 and can never receive mail).

| Provider | Verified-email signal |
|---|---|
| Twitch | `email_verified` on the userinfo response |
| Discord | `verified` on `/users/@me` |
| Epic | none — `basic_profile` asserts no address |
| Steam | none |

The account gets a random UUID as its password, Argon2-hashed, since authentication is federated.
Roles are `["g_subscriber"]`.

---

## Provider handshakes

### Twitch

`POST https://id.twitch.tv/oauth2/token` → `GET https://id.twitch.tv/oauth2/userinfo`.
Identity from `sub`, handle from `preferred_username`. No PKCE.

### Discord

`POST https://discord.com/api/oauth2/token` (with `code_verifier`) → `GET /api/users/@me`.
Identity from `id`, handle from `username`.

### Epic

`POST https://api.epicgames.dev/epic/oauth/v1/token` (with `code_verifier`) → `.../userInfo`.
Identity from `sub`; handle from `preferred_username`, falling back to `EpicUser_{sub}`.

### Steam — OpenID 2.0

`steam_params` is the full query string Steam redirected back with, as a JSON object of strings.

Every field feeding an authorization decision is checked explicitly, **before** and after asking Steam
to verify the signature:

| Check | Why |
|---|---|
| `openid.ns` is `http://specs.openid.net/auth/2.0` | Protocol sanity |
| `openid.op_endpoint` is `https://steamcommunity.com/openid/login` | Another OP must not be able to assert a SteamID |
| `claimed_id`, `identity`, `op_endpoint`, `return_to`, `response_nonce` **all appear in `openid.signed`** | The signature covers only the fields the *caller* listed. A field read outside that list is attacker-controlled even when the assertion verifies |
| `claimed_id == identity` | Consistency |
| `claimed_id` matches `https://steamcommunity.com/openid/id/<digits>` | Prefix and shape, not `split('/').last()` |
| `return_to` equals the URL built for this flow's `state` | Binds the assertion to this flow |
| `response_nonce` unseen — claimed with `set_cache_if_absent` **before** contacting Steam | Replay guard; the pre-claim makes concurrent submissions safe |
| Steam's reply has a line equal to `is_valid:true` | Line-wise, so a value echoed elsewhere cannot satisfy it |

**The signed-fields check is load-bearing.** Do not remove it on the grounds that Steam verified the
signature.

Handle is `SteamUser_{steam_id}`; no email.

---

## Client flow

```
GET  /auth/social/discord/redirect   (context headers)
       -> { url, state }             ... store `state`
browser -> provider -> REDIRECT_URI_BASE/auth/callback/discord?code=...&state=...
POST /auth/social/discord/callback   (same context headers)
       { state, code }
       -> AuthResponse
```

The client must send the **same** `X-Client-ID` / `X-Realm-ID` / `X-Device-ID` on both calls.

`REDIRECT_URI_BASE` builds every redirect URI (`{base}/auth/callback/{provider}`) and must match what
is registered with each provider exactly.

| Status | Cause |
|---|---|
| `400` | Bad headers, missing/expired/mismatched `state`, missing code, unconfigured provider |
| `401` | Steam assertion rejected |
| `403` | Linked account is suspended |
| `409` | Could not allocate a unique username |
