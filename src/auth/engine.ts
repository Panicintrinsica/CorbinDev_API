import type { KeyObject } from "node:crypto";
import { loadEd25519PublicKey, verifyPasetoV4Public } from "./paseto.ts";
import { bearerFromHeader, parseClaims, validateClaims, type ClaimPolicy } from "./claims.ts";
import { AuthError } from "./errors.ts";
import type { AuthLogger, AuthStore, SessionValidator } from "./ports.ts";
import { consoleAuthLogger } from "./ports.ts";
import type { HadesAuthConfig } from "./config.ts";
import type { AuthContext, HadesAccessClaims, Principal, RoleDefinition } from "./types.ts";
import { permits, permitsAll, permitsAny, resolvePermissions } from "./authorize.ts";
import { TtlCache } from "./cache.ts";

/**
 * The whole authentication + authorization decision, framework-free.
 *
 * A Hono/Express/Fastify adapter does exactly two things: pull the Authorization
 * header out of its own request type, and turn an AuthError into a response. Every
 * rule lives here.
 *
 * Order of checks (each one can reject):
 *  1. Bearer header present and well-formed.
 *  2. PASETO v4.public signature.
 *  3. Claim validity: exp, iat, realm, client.
 *  4. Local revocation watermark (webhook-driven) — fails closed.
 *  5. Hades `/internal/validate-session` — fails closed unless configured otherwise.
 *  6. Local principal: provision on first sight, reject if locally disabled.
 *  7. Permission resolution.
 *
 * 4 runs before 5 on purpose: it is a local read and cheap, and a webhook we have
 * already processed is strictly fresher than a cached session verdict.
 */
export class AuthEngine {
  private readonly publicKey: KeyObject;
  private readonly claimPolicy: ClaimPolicy;
  private readonly roleCache = new TtlCache<RoleDefinition[]>(64);

  constructor(
    readonly config: HadesAuthConfig,
    private readonly store: AuthStore,
    private readonly sessionValidator: SessionValidator,
    private readonly logger: AuthLogger = consoleAuthLogger,
  ) {
    this.publicKey = loadEd25519PublicKey(config.pasetoPublicKey);
    this.claimPolicy = {
      allowedRealms: config.allowedRealms,
      allowedClients: config.allowedClients,
      clockSkewSeconds: config.clockSkewSeconds,
    };
  }

  /** Steps 1-3. Cryptography and claims only — no I/O, so it is cheap to call. */
  verifyToken(authorizationHeader: string | undefined | null, now = new Date()): HadesAccessClaims {
    const token = bearerFromHeader(authorizationHeader);

    let payload: string;
    try {
      payload = verifyPasetoV4Public(token, this.publicKey).payload;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      throw new AuthError(
        message.includes("signature") ? "invalid_signature" : "malformed_token",
        undefined,
        cause,
      );
    }

    const claims = parseClaims(payload);
    validateClaims(claims, this.claimPolicy, now);
    return claims;
  }

  /** Steps 1-7. The one call a middleware needs. */
  async authenticate(
    authorizationHeader: string | undefined | null,
    now = new Date(),
  ): Promise<AuthContext> {
    const claims = this.verifyToken(authorizationHeader, now);

    let principal = await this.loadPrincipal(claims);

    if (principal && principal.revokedBefore && claims.iat <= principal.revokedBefore) {
      throw new AuthError("session_revoked");
    }
    if (principal && principal.status === "disabled") {
      throw new AuthError("principal_disabled");
    }

    const sessionChecked = await this.checkSession(claims);

    if (!principal) {
      if (!this.config.autoProvision) throw new AuthError("principal_disabled");
      principal = await this.provision(claims);
    }

    // Presence is best-effort. A write failure here must never fail the request.
    void this.store
      .touchLastSeen(principal.userId, now)
      .catch((error) => this.logger.debug("touchLastSeen failed", { error: String(error) }));

    const permissions = await this.resolveFor(principal);
    return buildContext(claims, principal, permissions, sessionChecked);
  }

  /** Step 4's read, isolated so its failure mode is explicit. */
  private async loadPrincipal(claims: HadesAccessClaims): Promise<Principal | null> {
    try {
      return await this.store.getPrincipal(claims.sub);
    } catch (cause) {
      // Fails closed: we cannot see the revocation watermark, so we cannot honour it.
      this.logger.error("principal lookup failed", { error: String(cause) });
      throw new AuthError("store_unavailable", undefined, cause);
    }
  }

  /** Step 5. Returns whether the session was actually confirmed on this request. */
  private async checkSession(claims: HadesAccessClaims): Promise<boolean> {
    if (this.config.sessionValidation === "off") return false;
    try {
      const live = await this.sessionValidator.isSessionLive({
        jti: claims.jti,
        userId: claims.sub,
        deviceId: claims.did,
      });
      if (!live) throw new AuthError("session_revoked");
      return true;
    } catch (cause) {
      if (cause instanceof AuthError) throw cause;
      this.logger.error("session validation unavailable", { error: String(cause) });
      if (this.config.onValidatorError === "open") {
        // Explicitly configured degradation: signature + claims + local watermark only.
        this.logger.warn("failing open on validator error", { user: claims.sub });
        return false;
      }
      throw new AuthError("validator_unavailable", undefined, cause);
    }
  }

  private async provision(claims: HadesAccessClaims): Promise<Principal> {
    const defaults = await this.store.getDefaultRoles();
    const roles =
      defaults.length > 0 ? defaults.map((r) => r.name) : this.config.fallbackDefaultRoles;
    this.logger.debug("provisioning principal", { user: claims.sub, roles });
    return this.store.provisionPrincipal({ userId: claims.sub, roles });
  }

  private async resolveFor(principal: Principal): Promise<Set<string>> {
    const key = principal.roles.slice().sort().join("|");
    let definitions = this.roleCache.get(key);
    if (!definitions) {
      definitions = await this.store.getRoles(principal.roles);
      this.roleCache.set(key, definitions, this.config.roleCacheTtlSeconds);
    }
    return resolvePermissions(principal, definitions);
  }

  /** Drops cached role definitions. Call after editing a role. */
  invalidateRoleCache(): void {
    this.roleCache.clear();
  }
}

function buildContext(
  claims: HadesAccessClaims,
  principal: Principal,
  permissions: Set<string>,
  sessionChecked: boolean,
): AuthContext {
  return {
    claims,
    principal,
    permissions,
    sessionChecked,
    has: (permission) => permits(permissions, permission),
    hasAny: (...list) => permitsAny(permissions, list),
    hasAll: (...list) => permitsAll(permissions, list),
  };
}
