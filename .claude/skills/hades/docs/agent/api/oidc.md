# API — OIDC Discovery

`src/routes/oidc.rs`. Both routes are public and unauthenticated, as the specification requires.

> **Scope warning.** Hades issues an OIDC-shaped **ID token** and publishes a JWKS so relying services
> can verify it. It is **not** a conforming OpenID Provider: there is no authorization endpoint, no
> token endpoint, no `code` grant, no `nonce`, no `state`, no userinfo claims. The discovery document
> advertises endpoints that do not implement the OIDC contract. Do not point a generic OIDC client
> library at this and expect it to work — see "Conformance gaps" below.

---

## `GET /.well-known/openid-configuration`

```json
{
  "issuer": "https://auth.impetus.cloud",
  "jwks_uri": "https://auth.impetus.cloud/oauth/jwks",
  "authorization_endpoint": "https://auth.impetus.cloud/auth/login",
  "token_endpoint": "https://auth.impetus.cloud/auth/login",
  "userinfo_endpoint": "https://auth.impetus.cloud/user/profile",
  "response_types_supported": ["token", "id_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["ES256"],
  "claims_supported": ["iss", "sub", "aud", "exp", "iat", "rid", "did"]
}
```

The base URL comes from `OIDC_ISSUER`, falling back to `WEBAUTHN_RP_ORIGIN`. A bare domain is prefixed
with `https://`.

`OIDC_ISSUER` exists because the two were previously the same value — overloading the WebAuthn origin
as the issuer breaks as soon as they diverge. Set it explicitly in production.

---

## `GET /oauth/jwks`

```json
{ "keys": [{ "kty": "EC", "crv": "P-256", "x": "...", "y": "...", "use": "sig", "alg": "ES256", "kid": "uuid-v4" }] }
```

Every document in `oidc_keys` with `is_active: true`, served verbatim from `public_key_jwk`. Only
public parameters — no `d`.

If this ever returns an empty array, ID token verification fails everywhere. It is worth a health
check.

---

## The ID token

Minted by `create_oidc_jwt` in `src/auth.rs` alongside every access token.

**Header** — `alg: ES256`, `kid` from the active key.

**Claims:**

```json
{
  "iss": "https://auth.impetus.cloud",
  "sub": "uuid-v4 global user id",
  "aud": "client id from X-Client-ID",
  "exp": 1756468800,
  "iat": 1756467900,
  "rid": "realm id",
  "did": "device id"
}
```

`exp`/`iat` are numeric (seconds), unlike the access token's RFC 3339 strings.

`rid` and `did` are non-standard extensions. `rid` is the one a relying service usually cares about —
it says which realm the token was minted for.

### Verifying it

1. Fetch the JWKS; select by `kid`.
2. Verify the ES256 signature.
3. Check `iss` against your configured issuer.
4. Check `aud` equals your client id.
5. Check `exp`.
6. Check `rid` is a realm you serve.

Cache the JWKS and re-fetch on an unknown `kid`.

### What it does not carry

No `nonce`, `auth_time`, `acr`, `amr`, `azp`, `email`, `name`, or `picture`. In particular there is
**no `nonce`**, so an ID token cannot be bound to a specific authentication request. Do not use it as
a standalone assertion in a flow that needs replay protection — pair it with the access token, whose
session can be checked at [`/internal/validate-session`](admin.md).

---

## Conformance gaps

Known and deliberate, recorded so nobody assumes otherwise:

| Advertised | Reality |
|---|---|
| `authorization_endpoint` | `/auth/login` — takes JSON credentials, not a browser redirect with `response_type`, `scope`, `redirect_uri`, `state` |
| `token_endpoint` | The same route. There is no `code` exchange |
| `userinfo_endpoint` | `/user/profile` returns Hades's own shape, not OIDC standard claims, and authenticates with a PASETO rather than an OAuth bearer |
| `response_types_supported` | Not honoured; the response shape is fixed |
| `claims_supported` | Accurate for the ID token |

Closing these means implementing a real authorization code flow with PKCE, a `nonce`, and a separate
token endpoint. That is a substantial piece of work, not a patch — treat it as such if it comes up.
