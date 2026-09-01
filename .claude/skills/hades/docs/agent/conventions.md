# Code Conventions

## Errors

`AppError` in `src/errors.rs` is the only error type crossing a handler boundary.

| Variant | Status | Body | Use for |
|---|---|---|---|
| `Internal(anyhow::Error)` | 500 | `"Internal server error"` | Bugs, unreachable states |
| `Database(mongodb::error::Error)` | 500 | `"Database error"` | Driver failures (`?` converts automatically) |
| `Redis(redis::RedisError)` | 500 | `"Redis error"` | Cache failures that are not recoverable |
| `Unauthorized` | 401 | `"Unauthorized"` | Bad or missing credentials |
| `Forbidden` | 403 | `"Forbidden"` | Authenticated but not permitted; suspended account |
| `BadRequest(String)` | 400 | The string | Malformed input, rate limits |
| `Conflict(String)` | 409 | The string | Uniqueness violations |
| `NotFound(String)` | 404 | The string | Missing resource |

Rules:

- **The 500 variants log the detail and return a fixed string.** Never put an internal error into a
  400 message. `webauthn_register_finish` logs the library error in full and returns a bare
  `"Registration failed"` — follow that pattern.
- **Authentication failures are `Unauthorized`, uniformly.** Do not distinguish "no such user" from
  "wrong password" from "wrong TOTP code" in the response.
- **`Forbidden` means the caller is known.** Use it for suspension and for missing roles, not for a
  bad password.

## Logging

Two systems, used for different things:

- **`iris::{info,warn,error,success}!`** — security-relevant events. Always pass `sys = "hades"`, and
  `trace_id = &user_id` whenever a user is known. `iris` is an alias for `crates/lethe`, which writes
  these to an embedded SQLite file (`LOG_DB_PATH`) on a batching background thread and archives them
  to text after `LOG_RETENTION_DAYS`. The macros, levels, and arguments are unchanged from the Iris
  client, so switching back is one line in `Cargo.toml`. Read them with
  `cargo run -p lethe --bin lethe-tail`.
- **`tracing::{info,warn,error}!`** — operational detail: startup, cache backend degradation,
  configuration.

Log the *reason* at the server and return the *generic* message to the client:

```rust
iris::warn!(sys = "hades", trace_id = &user.id,
    "Login failed: Invalid password for user '{}'", user.username);
return Err(AppError::Unauthorized);
```

Escalate to `iris::error!` for anything that indicates an attack rather than a mistake — refresh token
reuse, challenge context mismatch, a rejected Steam assertion, an invalid internal key.

**Never log a secret.** Not passwords, TOTP secrets, recovery codes, refresh tokens, PASETO keys, or
provider access tokens. Logging a *username* is fine; logging the value being tested against it is not.

## Validation

Input is normalised, then validated, then used. Shared helpers live in `src/routes/auth.rs`:

```rust
normalize_identity(s)          // trim + lowercase — apply before storing OR comparing an identity
validate_username(s)           // length, no '@', no whitespace/control chars
is_plausible_email(s)          // shape check, not RFC 5322
case_insensitive_collation()   // must match the collation on the unique indexes
crate::auth::validate_password_strength(pw, min_len)
```

Bound every caller-supplied string that reaches a query or a token. Existing caps: device id 128,
username 64, email 254, admin search 128, MFA token 128, OAuth state 128, Steam nonce 256.

## Database access

Direct driver use. **No ORM** — this is a hard rule.

- Type collections where a model exists: `db.collection::<User>("users")`.
- Use `Document` for the `cache` collection and other schemaless writes.
- **Uniqueness is settled by the index, not by a prior read.** Read-then-write is a courtesy check
  that loses to a concurrent request; always handle the duplicate-key error from the write too:

  ```rust
  if let Err(e) = users_col.insert_one(&new_user).await {
      if crate::state::is_duplicate_key_error(&e) {
          return Err(AppError::Conflict("...".to_string()));
      }
      return Err(e.into());
  }
  ```

- **Contested state transitions use a conditional update and check the modified count.** This is how
  refresh rotation and recovery-code redemption avoid double-spend:

  ```rust
  let claimed = col.update_one(
      doc! { "_id": &id, &field: false },
      doc! { "$set": { &field: true } },
  ).await?;
  if claimed.modified_count == 1 { /* we won */ }
  ```

- Identity lookups **must** carry `.collation(case_insensitive_collation())` or they will not agree
  with the unique indexes.
- Escape user input before it reaches `$regex` (`regex_escape` in `src/routes/admin.rs`).

## Performance posture

From `GEMINI.md`: minimise allocations and CPU. In practice, for this codebase:

- Argon2 dominates every password path. Do not add a second hash to a request that already does one.
- Prefer one query with the right filter over fetching a document and filtering in Rust — except
  where a conditional write is needed for atomicity (above), which is worth the extra round trip.
- Clone only what outlives the borrow. Most handlers can pass `&str`.
- Do not add a dependency for string manipulation, validation, or encoding that a short function
  covers. Cryptography, protocol implementations, and the runtime are the exceptions.

## Adding an endpoint

1. **Decide what authenticates it.** `AuthenticatedUser` extractor, `MfaDisableRequest { password }`
   re-auth, `X-Internal-Key`, or genuinely public — and be able to say why.
2. **If it issues tokens**, call `request_context()` first and `issue_tokens()` last, with a
   `global_status` check and a rate limit in between. Read invariants I1, I2, I5, I6.
3. **If it weakens authentication**, take `MfaDisableRequest` and call `require_password_reauth()`
   (invariant I12).
4. **If it consumes a single-use artifact**, delete it before the operation it guards, not after
   (invariants I4, I10, I13).
5. Define request/response structs next to the handler. `#[derive(Deserialize)]` for requests,
   `#[derive(Serialize)]` for responses. Use `#[serde(skip_serializing_if = "Option::is_none")]` for
   optional response fields.
6. Register in `src/routes/mod.rs` under the right section comment.
7. Add a spec file section under `docs/agent/api/`.
8. If it changes an invariant's surface, update `docs/agent/invariants.md` in the same change.
9. Unit-test any new pure validator in a `#[cfg(test)] mod tests` beside it.
10. Run `cargo check`, `cargo clippy`, `cargo test`.

## Testing

Unit tests live beside the code in `#[cfg(test)] mod tests`. Current coverage is the pure functions:
password policy, email shape, username rules, identity normalisation, hashing round-trip.

There is **no integration test harness** — no test database, no HTTP-level tests. Anything requiring
MongoDB or Redis is currently verified by reading. If you add a harness, it needs a disposable
database; do not point tests at a configured `MONGODB_URI`.

## Windows note

`cargo build` fails to link while the server binary is running (`Access is denied. (os error 5)`).
That is a file lock, not a compile error. Use `cargo check` for the fast signal and `cargo test`
(which builds its own binary) to confirm.
