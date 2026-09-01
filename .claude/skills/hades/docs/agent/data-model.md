# Data Model

MongoDB, accessed through the driver directly. Types are in `src/models.rs`.

All timestamps use `chrono_datetime_as_bson_datetime`, i.e. real BSON dates — **not** RFC 3339
strings. Legacy string dates are a migration failure, not something to work around at read time
(invariant I19).

---

## `users`

```rust
User {
    #[serde(rename = "_id")] id: String,   // UUID v4
    username: String,                       // normalised: trimmed, lowercase, no '@'
    email: String,                          // normalised: trimmed, lowercase
    email_verified: bool,                   // proven by a confirmation link
    pending_email: Option<String>,          // staged address, not yet an identity
    password_hash: String,                  // Argon2id PHC string
    global_status: String,                  // "active" | "suspended_global"
    global_roles: Vec<String>,              // e.g. ["g_subscriber"], ["g_superadmin", "g_subscriber"]
    presence_registry: Vec<PresenceEntry>,
    mfa: MfaState,
    federated_identities: Vec<FederatedIdentity>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
```

`global_roles` is copied verbatim into the access token's `scope`. Only global roles belong here —
per-application permissions are the relying application's concern.

Known role values: `g_subscriber` (assigned on every signup), `g_superadmin` (gates every `/admin`
route).

`pending_email` holds an address the account has asked to move to. It is **not** an identity: login
never resolves against it, it carries no unique index, and two accounts may hold the same value. It is
promoted into `email` only by `POST /auth/verify-email/confirm`, where the unique index on `email` is
the arbiter (invariants I8, I22). Both fields are `#[serde(default)]`, so a document written before
this existed reads back as `email_verified: false` with no pending address — see the migration note
below.

### `MfaState`

```rust
MfaState {
    totp_secret: Option<String>,        // base32, present only once enrolment is confirmed
    passkeys: Vec<Passkey>,             // webauthn_rs Passkey, serialised whole
    is_enabled: bool,                   // derived: any factor present
    recovery_codes: Vec<RecoveryCode>,
}

RecoveryCode { code_hash: String, is_used: bool, created_at: DateTime<Utc> }
```

`is_enabled` is recomputed on every factor change — `!passkeys.is_empty() || totp_secret.is_some()`.
It drives whether `login` returns an MFA challenge, so a stale value silently disables MFA. Recompute
it in any handler that adds or removes a factor.

Recovery codes are stored as Argon2 hashes and redeemed by conditional update on
`mfa.recovery_codes.{i}.is_used` (see invariant I4 and the conventions on contested writes).

`Passkey` is stored in full because the `danger-allow-state-serialisation` feature is enabled. It
carries the signature counter, which must be written back after authentication (invariant I13).

### `FederatedIdentity`

```rust
FederatedIdentity {
    provider: String,          // "twitch" | "discord" | "epic" | "steam"
    provider_user_id: String,  // the provider's stable id — the join key
    username: String,          // cached provider handle, display only
    linked_at: DateTime<Utc>,
}
```

The lookup on social login is `federated_identities.$elemMatch { provider, provider_user_id }`.
**Accounts are never linked by email.** A provider handle is attacker-controlled (invariant I9).

### `PresenceEntry`

```rust
PresenceEntry {
    realm_id: String, client_id: String, client_status: String,
    first_seen: DateTime<Utc>, last_active: DateTime<Utc>,
}
```

Maintained by `update_presence()`, keyed on `realm_id` — one entry per realm, its `client_id`
overwritten by the most recent activity. Telemetry, not a security control.

### Indexes

| Key | Options | Why |
|---|---|---|
| `email: 1` | unique, collation `en` strength 2 | Invariant I8 |
| `username: 1` | unique, collation `en` strength 2 | Invariant I8 |
| `presence_registry.realm_id: 1` | — | Presence updates |

**No index on `pending_email`.** Deliberate. It is a staging field, not an identity, and a unique
index would let one account block another from ever staging an address.

The collation is not optional. Identity queries must pass a matching one or they will not use the
index and will not agree with its uniqueness semantics. `ensure_unique_identity_index` in
`src/main.rs` drops and rebuilds a pre-existing index whose options conflict (error 85/86), and
**refuses to start** when existing documents collide (error 11000).

---

## `refresh_tokens`

```rust
RefreshToken {
    #[serde(rename = "_id")] id: String,   // == the access token's `jti` (invariant I17)
    family_id: Option<String>,             // session lineage; None => the token is its own family
    user_id: String,
    realm_id: String, client_id: String, device_id: String,
    is_revoked: bool,
    expires_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
}
```

Lifecycle:

- **Login / MFA completion / social callback** — new document, new `family_id` (equal to its own id).
- **Refresh** — the presented token is revoked conditionally; the replacement keeps the `family_id`.
- **Reuse of a revoked token** — every document in the family is revoked (invariant I3).
- **Logout** — the whole family is revoked.
- **Ban / admin revoke / password change** — every document for the user is revoked.
- **Account deletion** — documents are deleted.

Revoked documents are **retained** until `expires_at`. That retention is what makes reuse detection
possible; do not "clean up" revoked tokens early.

| Index | Options |
|---|---|
| `expires_at: 1` | TTL, `expireAfterSeconds: 0` |
| `user_id, realm_id, client_id, device_id` | compound |

Adding an index on `family_id` is reasonable if family revocation shows up in profiling.

---

## `realms` and `clients`

```rust
Realm  { #[serde(rename = "_id")] id: String, name: String, created_at: DateTime<Utc> }
Client {
    #[serde(rename = "_id")] id: String,
    realm_id: String,
    name: String,
    webhook_url: Option<String>,     // where security events are POSTed
    webhook_secret: Option<String>,  // HMAC key for those deliveries
    created_at: DateTime<Utc>,
}
```

Both ids are UUIDs generated at creation. `realms.name` is uniquely indexed; client names are unique
per realm by an application-level check only.

Both webhook fields are absent on a client that has never registered one, and are `$unset` together
when it is cleared — a URL without a secret is a broken state and deliveries to it are skipped. No
migration is needed for existing documents; both fields are `#[serde(default)]`.

`webhook_secret` must never reach a response. Admin handlers return `ClientResponse`, which omits it;
anything new that serialises a `Client` directly leaks a key that can forge security events.

Deleting a realm cascades to its clients. Bootstrapped defaults:

```
realm  b4547987-b6fc-4315-bdcc-ba0af96bb0d7  "Hades"
client 3f951450-252e-4de5-94ac-7d57e6ac8cd6  "Tartarus (System Admin)"
```

---

## `oidc_keys`

```rust
OidcKey {
    #[serde(rename = "_id")] kid: String,   // UUID, becomes the JWT `kid` header
    private_key_pem: String,                // ECDSA P-256, PKCS#8 PEM
    public_key_jwk: serde_json::Value,      // served verbatim at /oauth/jwks
    is_active: bool,
    created_at: DateTime<Utc>,
}
```

`create_oidc_jwt` signs with the first document where `is_active: true`. `/oauth/jwks` publishes every
active key.

Rotation is not implemented. The shape supports it: add a new active key, let both be published so
existing ID tokens still verify, then deactivate the old one after the TTL lapses. `private_key_pem`
is stored unencrypted — treat database access as equivalent to holding the signing key.

---

## `cache`

Schemaless fallback for Redis. Documents carry `key`, `expires_at`, and either `value` (string) or
`count` (integer, for `incr_cache`).

| Index | Options |
|---|---|
| `expires_at: 1` | TTL, `expireAfterSeconds: 0` |
| `key: 1` | unique — this is what makes `set_cache_if_absent` atomic |

The TTL monitor runs about once a minute, so reads check `expires_at` inline rather than trusting
that expired documents are gone.

---

## Migrations

There is no migration framework. Schema changes are handled by:

- `#[serde(default)]` on new fields (`family_id`, `mfa`, `federated_identities`, `is_enabled`,
  `recovery_codes`, `email_verified`, `pending_email` all use it).
- `ensure_indexes()` at startup, which is idempotent and rebuilds conflicting indexes.

When adding a field to an existing document type, give it `#[serde(default)]` or a deserialization
failure will take down every read of that collection.
