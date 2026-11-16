import type { Connection } from "mongoose";
import { loadAuthConfig, type HadesAuthConfig, type HadesAuthConfigOverrides } from "./config.ts";
import { AuthEngine } from "./engine.ts";
import { MongoAuthStore } from "./mongo/store.ts";
import { HadesSessionValidator, alwaysLiveSessionValidator } from "./session.ts";
import { consoleAuthLogger, type AuthLogger, type SessionValidator } from "./ports.ts";
import { createAuthMiddleware, type HonoAuthMiddleware } from "./hono/middleware.ts";
import { createAccountRouter, createAuthRouter } from "./hono/routes.ts";
import { createWebhookRouter } from "./hono/webhook.route.ts";
import { createHadesProxyRouter, type HadesProxyOptions } from "./hono/proxy.routes.ts";
import { fileReport, type ReportRequest } from "./hades-api.ts";
import type { HostEventHandler } from "./events.ts";
import type { RoleDefinition } from "./types.ts";

/**
 * hades-auth — a drop-in Hades integration for a Hono + MongoDB API.
 *
 * ```ts
 * const auth = createHadesAuth({ connection: Atlas, seedRoles: [...] });
 * app.route("/auth", auth.routes);
 * app.route("/hooks/hades", auth.webhookRoutes);
 * app.use("/articles/admin/*", auth.requirePermission("articles:write"));
 * ```
 *
 * The layering, in order of portability:
 *   paseto / claims / authorize / webhook  — pure TypeScript, no I/O
 *   engine / session / config              — I/O through ports, no framework
 *   mongo/*                                — the storage adapter
 *   hono/*                                 — the framework adapter (glue only)
 *
 * A port to another framework rewrites `hono/`. A port to another database
 * rewrites `mongo/`. Nothing else should need to change.
 */
export function createHadesAuth(options: {
  connection: Connection;
  config?: HadesAuthConfigOverrides;
  logger?: AuthLogger;
  /** Role definitions created if absent. Existing rows are never overwritten. */
  seedRoles?: RoleDefinition[];
  /** Supply your own, e.g. in tests. Defaults to the Hades internal endpoint. */
  sessionValidator?: SessionValidator;
  /**
   * Called for events only the host can act on: an account deleted, its level or
   * verification changed. At-least-once, so it must be idempotent. A throw is logged,
   * never propagated.
   */
  onEvent?: HostEventHandler;
  /** Gateway tuning, mainly for tests: how the caller's socket address is found. */
  gateway?: Pick<HadesProxyOptions, "peerAddress">;
}) {
  const logger = options.logger ?? consoleAuthLogger;
  const config = loadAuthConfig(options.config);
  const store = new MongoAuthStore(options.connection);

  const hadesValidator =
    config.sessionValidation === "off" ? undefined : new HadesSessionValidator(config, logger);
  const sessionValidator =
    options.sessionValidator ?? hadesValidator ?? alwaysLiveSessionValidator;

  const engine = new AuthEngine(config, store, sessionValidator, logger, options.onEvent);
  const middleware: HonoAuthMiddleware = createAuthMiddleware(engine);

  if (options.seedRoles?.length) {
    // Fire-and-forget: a seeding failure must not stop the process from serving
    // requests it can already authorize. It is logged loudly instead.
    void store
      .ensureRoles(options.seedRoles)
      .catch((error) => logger.error("role seeding failed", { error: String(error) }));
  }

  return {
    config,
    engine,
    store,
    logger,
    ...middleware,
    /** `/me`, `/meta`, `/verify`, account deletion, principal and role administration. Mount at `/auth`. */
    routes: createAuthRouter(engine, store, { logger }),
    /** `GET /me` and `PUT /me/display-name`, in Charon's wire format. Mount at `/account`. */
    accountRoutes: createAccountRouter(engine, store),
    /** Hades security-webhook receiver. Mount at the URL registered with Hades. */
    webhookRoutes: createWebhookRouter({
      config,
      store,
      logger,
      sessionValidator: hadesValidator,
      emit: (event) => engine.emit(event),
    }),
    /**
     * Hades gateway: the credential, MFA, social and self-service routes, forwarded
     * under their own Hades paths. Mount at the app root so the frontend never has
     * to reach Hades itself. Throws unless HADES_CLIENT_ID / HADES_REALM_ID are set.
     */
    gatewayRoutes: () =>
      createHadesProxyRouter(config, logger, { store, peerAddress: options.gateway?.peerAddress }),
    /** Files a report in Hades' review queue (`POST /internal/reports`). */
    fileReport: (report: ReportRequest) => fileReport(config, report),
  };
}

export type HadesAuth = ReturnType<typeof createHadesAuth>;

export { AuthEngine } from "./engine.ts";
export { AuthError, isAuthError, statusForAuthError, type AuthErrorCode } from "./errors.ts";
export {
  loadAuthConfig,
  assertUsable,
  DEFAULT_HADES_BASE_URL,
  type HadesAuthConfig,
} from "./config.ts";
export { MongoAuthStore } from "./mongo/store.ts";
export { createAuthModels } from "./mongo/schemas.ts";
export type { AuthStore, SessionValidator, AuthLogger } from "./ports.ts";
export type { AuthContext, Principal, RoleDefinition, HadesAccessClaims } from "./types.ts";
export type { HostEvent, HostEventHandler } from "./events.ts";
export type { ReportRequest } from "./hades-api.ts";
export {
  AccountLevel,
  tierName,
  baseTier,
  normaliseDisplayName,
  DEFAULT_DISPLAY_NAME_RULES,
  type Account,
  type VerificationTier,
} from "./account.ts";
export { AUTH_CONTRACT_VERSION } from "./contract.ts";
export { resolveClientIp, parseTrusted } from "./client-ip.ts";
export {
  permits,
  permitsAll,
  permitsAny,
  resolvePermissions,
  satisfies,
  type PermissionRequirement,
} from "./authorize.ts";
export {
  getAuth,
  tryGetAuth,
  assertPermission,
  authErrorResponse,
  type AuthEnv,
} from "./hono/middleware.ts";
export { AUTH_ADMIN_PERMISSIONS } from "./hono/routes.ts";
export { PROXIED_ROUTES, PROXIED_PARAM_ROUTES } from "./hono/proxy.routes.ts";
export { verifyWebhook, applySecurityEvent, type HadesSecurityEvent } from "./webhook.ts";
export { verifyPasetoV4Public, loadEd25519PublicKey } from "./paseto.ts";
