# hades-auth

Hades integration for a Hono + MongoDB API. Authentication is Hades'; **authorization
is this API's**, and lives in the collections below.

## The management split

| | Where |
|---|---|
| Accounts, credentials, MFA, global roles, account suspension and deletion | **The Hades application.** This API has no route that reaches any of it |
| Signup, login, profile, password, MFA enrolment, account deletion | The user's own, driven through the **gateway** below — Hades' routes, forwarded unchanged |
| Roles and permissions *for this site*, site ban, local record deletion | **This API**, under `/auth/principals` and `/auth/roles` |

A ban issued here is a site ban: the account, its session, and every other service in
the realm carry on as before. Suspending the account itself is an operator action in
the Hades application, and this API deliberately offers no way to ask for it.

## Install into an app

```ts
import Atlas from "./database.ts";
import { createHadesAuth } from "./auth/index.ts";
import type { AuthEnv } from "./auth/index.ts";

export const auth = createHadesAuth({
  connection: Atlas,
  seedRoles: [
    { name: "member", permissions: [], isDefault: true },
    { name: "editor", permissions: ["articles:*"], isDefault: false },
  ],
});

const app = new Hono<AuthEnv>();
app.route("/", auth.gatewayRoutes());      // Hades' own paths, forwarded
app.route("/auth", auth.routes);           // /auth/me, /auth/verify, role admin
app.route("/hooks/hades", auth.webhookRoutes);
app.use("/articles/admin/*", auth.requirePermission("articles:write"));
```

Inside a handler:

```ts
import { getAuth } from "./auth/index.ts";
const { principal, claims, has } = getAuth(c);
```

Configuration is environment-driven — see `.env.example`. `createHadesAuth` **throws
at startup** if it cannot verify tokens or cannot check revocation; that is
deliberate (see DECISIONS.md, D-11).

## Middleware

| Call | Meaning |
|---|---|
| `auth.requireAuth()` | Valid token, live session, locally enabled |
| `auth.optionalAuth()` | Anonymous allowed; a *bad* token is still rejected |
| `auth.requirePermission(...p)` | All of `p` |
| `auth.requireAnyPermission(...p)` | Any of `p` |
| `auth.requireGlobalRole(...r)` | A Hades global role, e.g. `g_superadmin` |
| `auth.require({ allOf, anyOf, globalRoles })` | The general form |

Permission grants may use `*` or a `prefix:*` wildcard. Requirements are always
literal.

## Collections

| Collection | Holds |
|---|---|
| `auth_principals` | `_id` = Hades `sub`. Local roles, direct/denied permissions, status, revocation watermark |
| `auth_roles` | `_id` = role name. Permission list, `isDefault` |
| `auth_webhook_events` | Delivered event ids, for at-least-once de-duplication. TTL 30 days |
| `auth_revocations` | Audit trail of why a watermark moved |

No credentials, no email, no username. Hades owns identity.

## Endpoints this module adds

| Route | Auth | Purpose |
|---|---|---|
| `GET /auth/me` | bearer | Local roles, resolved permissions, token context |
| `GET /auth/verify` | bearer | Cheap liveness probe for a frontend |
| `GET /auth/principals` | `auth:principals:read` | List local principals |
| `GET /auth/principals/:userId` | `auth:principals:read` | One principal |
| `PUT /auth/principals/:userId/roles` | `auth:principals:write` | Absolute role set |
| `PUT /auth/principals/:userId/permissions` | `auth:principals:write` | Direct grants / denials |
| `PUT /auth/principals/:userId/status` | `auth:principals:write` | Local enable/disable |
| `POST /auth/principals/:userId/ban` | `auth:principals:write` | Site ban: disable + void tokens here |
| `POST /auth/principals/:userId/unban` | `auth:principals:write` | Lift a site ban |
| `POST /auth/principals/:userId/revoke` | `auth:principals:write` | Raise the local watermark |
| `DELETE /auth/principals/:userId` | `auth:principals:write` | Forget the local record (not a ban) |
| `GET /auth/roles` | `auth:roles:read` | List roles |
| `PUT /auth/roles/:name` | `auth:roles:write` | Create/replace a role |
| `DELETE /auth/roles/:name` | `auth:roles:write` | Delete a role |
| `POST /hooks/hades` | HMAC signature | Hades security webhook receiver |

## The gateway

`auth.gatewayRoutes()` forwards Hades' credential, MFA, social and self-service
routes under **their own Hades paths**, so the frontend never reaches Hades and the
client/realm ids are never published to a browser:

```
POST /auth/register  /auth/login  /auth/refresh  /auth/logout
POST /auth/reset-password[/confirm]   /auth/verify-email[/confirm]
POST /mfa/verify/totp   /mfa/webauthn/auth/start|finish          (login completion)
POST /mfa/totp/setup|verify  /mfa/webauthn/register/start|finish (enrolment, bearer)
POST /mfa/totp/disable  /mfa/disable  /mfa/recovery/regenerate   (bearer + password)
POST /mfa/passkeys/{credId}/revoke
GET  /auth/social/{provider}/redirect   POST /auth/social/{provider}/callback
GET|PUT /user/profile   POST /user/password   DELETE /user/account
```

`/admin/*` and `/internal/*` are **not** forwarded, by policy rather than oversight —
Hades-level management belongs in the Hades application.

Client code is therefore written straight from the Hades API docs; only the base URL
differs. `X-Client-ID` / `X-Realm-ID` are stamped by the gateway on the routes that
need them, `X-Device-ID` is passed through from the caller, and `Authorization` is
forwarded on the bearer-authenticated routes. Bodies and status codes pass through
untouched.

`g_superadmin` in the token's `scope` satisfies every one of the admin permissions.

## Wiring it to Hades

1. Create a client for this API: `POST /admin/clients { realm_id, name }`.
   Put the ids in `HADES_CLIENT_ID` / `HADES_REALM_ID`.
2. Copy Hades' `PASETO_PUBLIC_KEY` into `HADES_PASETO_PUBLIC_KEY`.
3. Copy Hades' `INTERNAL_API_KEY` into `HADES_INTERNAL_API_KEY`, and make sure
   `/internal/*` is reachable from this API but not from the internet.
4. Register the webhook:
   `PUT /admin/clients/{client_id}/webhook { "url": "https://api.corbin.dev/hooks/hades" }`
   and store the returned `webhook_secret` in `HADES_WEBHOOK_SECRET`. It is shown once.
5. Give yourself a role: `PUT /auth/principals/{your hades sub}/roles { "roles": ["owner"] }`,
   authenticated with a token whose `scope` contains `g_superadmin`.

## Extracting it as a package

`src/auth/` has no imports from the rest of the app. To publish it:

- move the directory, add `hono` and `mongoose` as peer dependencies,
- drop `.ts` from the relative import specifiers if the consumer is not on Bun's
  `allowImportingTsExtensions`,
- keep `DECISIONS.md` with it.
