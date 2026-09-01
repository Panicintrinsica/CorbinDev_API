# Security Webhooks

`src/webhooks.rs`, registered from `src/routes/admin.rs`.

Hades is the only place that knows an account has been banned. Relying services otherwise find out
at their next `POST /internal/validate-session` call, which may be a whole access-token TTL away.
This is the push side of that: when an account's authority changes, every client with a registered
endpoint is POSTed a signed JSON envelope.

It is a **notification, not an authorization decision**. `/internal/validate-session` remains the
authoritative check — delivery is at-least-once and can fail entirely.

---

## Registering an endpoint

### `PUT /admin/clients/{client_id}/webhook`

Superadmin, like every `/admin/*` route.

```json
{ "url": "https://guildhall.example.com/hooks/hades" }
```

```json
{
  "client_id": "3f951450-...",
  "webhook_url": "https://guildhall.example.com/hooks/hades",
  "webhook_secret": "whsec_9f2c..."
}
```

**`webhook_secret` is returned here and nowhere else.** It is the HMAC key; anyone holding it can
forge events for that client, so it is never logged, never listed, and not readable back. Store it
where the receiving service can reach it before you make the call.

Setting a URL always mints a fresh secret, so this is also the rotation operation — there is a window
during which the receiver must accept both, or a few events will be rejected.

`{ "url": null }` (or an empty string) unregisters the endpoint and discards the secret. `404` if the
client does not exist.

The URL is validated on registration **and again before every send**:

- `https` only. `http` is accepted only when `DEV_MODE=true`.
- No credentials in the URL.
- No IP literals, no `localhost`, no `.local` / `.internal` / `.home.arpa`, no bare hostname without a
  dot. Outside dev mode these are all rejected as SSRF targets.

Redirects are **not** followed. A `3xx` from the receiver is a failed delivery, not a hop.

`GET /admin/clients` reports `webhook_url` and a boolean `webhook_configured`; it never returns the
secret.

---

## The request

```
POST {webhook_url}
Content-Type: application/json
X-Hades-Event: user_banned
X-Hades-Event-Id: 0f0e...-...
X-Hades-Timestamp: 1756500000
X-Hades-Signature: v1=3ad4...
```

```json
{
  "id": "0f0e...-...",
  "type": "user_banned",
  "occurred_at": "2026-08-29T14:03:11.482Z",
  "user_id": "8c1d...",
  "actor_id": "b02f..."
}
```

`actor_id` is the admin who caused it, and is absent when there was none.

The body is deliberately thin. It carries no email address, no roles, and no token material — a
receiver that needs the current state of the account asks for it.

### Events

| `type` | Emitted by | Means |
|---|---|---|
| `user_banned` | `ban_user`; `update_user_admin` moving the account into `suspended_global` | Every session is revoked and the account cannot authenticate by any route |
| `user_unbanned` | `update_user_admin` moving the account out of `suspended_global` | The account can authenticate again. Existing sessions are **not** restored |
| `sessions_revoked` | `revoke_user_tokens`; `update_user_admin` when roles changed | Every token held for this user is void. Roles ride in the access token, so a role change is a revocation |

A single call emits at most one event. `update_user_admin` compares the document as it was against
what was written, so re-banning an already-banned account is silent.

---

## Verifying a delivery

The signature is `HMAC-SHA256(secret, "{X-Hades-Timestamp}.{raw request body}")`, hex-encoded, and
prefixed `v1=`. Sign the **raw bytes** of the body — reserialising a parsed JSON object will not
reproduce them.

The timestamp is inside the signed string, which is what makes a captured request expire. Reject a
delivery whose timestamp is more than **300 seconds** from your own clock, and compare signatures in
constant time.

```python
import hashlib, hmac, time

def verify(secret: str, body: bytes, timestamp: str, signature: str) -> bool:
    if abs(time.time() - int(timestamp)) > 300:
        return False
    expected = hmac.new(
        secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(f"v1={expected}", signature)
```

`X-Hades-Event-Id` is stable across retries and identical for every recipient of the same event.
**Deduplicate on it** — delivery is at-least-once.

Answer `2xx` as soon as the event is durably recorded, and do the work afterwards. The sender's
timeout is `WEBHOOK_TIMEOUT_SECONDS` (default 5).

---

## Delivery behaviour

- **Off the response path.** `dispatch_security_event` spawns and returns; the admin's `POST
  /admin/users/{id}/ban` never waits on a receiver and never fails because of one.
- **One task per client**, so a slow receiver does not delay the others.
- **Retries** up to `WEBHOOK_MAX_ATTEMPTS` (default 3) with a 2s, 4s, … backoff capped at 30s.
- **A 4xx other than 408 or 429 stops the retries.** The receiver understood the request and rejected
  it; repeating it is only load.
- **After the last attempt the event is dropped** and an `iris` warning is logged naming the event,
  the client, and the attempt count. There is no queue and no replay endpoint — this is why
  `/internal/validate-session` stays load-bearing.
- **A client with a URL but no secret is skipped**, loudly. That combination can only come from a
  hand-edited document.

Nothing about a delivery is persisted. The audit trail is `iris` logging — since that now lands in
the embedded store (`crates/lethe`) it is at least queryable — which is the gap tracked as
N5 in `SECURITY_AUDIT.md`.

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `WEBHOOK_TIMEOUT_SECONDS` | `5` | Per-request timeout on the shared outbound HTTP client |
| `WEBHOOK_MAX_ATTEMPTS` | `3` | Attempts per event per recipient. `0` is treated as `1` |

`DEV_MODE=true` relaxes URL validation to allow `http` and loopback, so a local receiver can be used.
It does not weaken signing.

See also invariant I23 in [invariants.md](../invariants.md).
