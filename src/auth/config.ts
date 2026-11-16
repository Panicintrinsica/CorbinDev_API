/**
 * Configuration, read once. Mirrors Hades' own posture: a misconfigured auth layer
 * should refuse to start rather than serve requests with a hole in it.
 *
 * PORTABILITY: `process.env` rather than `Bun.env` — identical in Bun, works in Node
 * and Deno. This is the only file in the module that reads the environment.
 */

import { parseTrusted } from "./client-ip.ts";

export interface HadesAuthConfig {
  /** Base URL of the Hades service, no trailing slash. Defaults to production. */
  hadesBaseUrl: string;
  /** Hex or PEM Ed25519 public key matching Hades' `PASETO_PUBLIC_KEY`. */
  pasetoPublicKey: string;

  /**
   * The client/realm pair this API presents to Hades. Required to mount the
   * gateway (the frontend never speaks to Hades directly, so it is effectively
   * always required here). Token verification alone does not need them — see
   * `allowedClients` / `allowedRealms`, which default to these values.
   */
  clientId?: string;
  realmId?: string;

  /** Realms this API serves. Empty = accept any realm. */
  allowedRealms: string[];
  /** Clients this API accepts tokens from. Empty = accept any. */
  allowedClients: string[];
  clockSkewSeconds: number;

  /**
   * `required` — every authenticated request confirms the session with
   *   `POST /internal/validate-session` (cached). Needs `clientApiKey` and `clientId`.
   * `off` — trust the signature, the expiry and locally-recorded revocations only.
   *   An access token then stays usable for its full TTL after a logout or ban that
   *   this API never got a webhook for. Must be chosen explicitly.
   */
  sessionValidation: "required" | "off";
  clientApiKey?: string;
  /** How long a *live* session verdict is reused. Keep well under the token TTL. */
  sessionCacheTtlSeconds: number;
  /** How long a *dead* verdict is reused. Safe to cache: it only ever denies. */
  sessionNegativeCacheTtlSeconds: number;
  /** Timeout on the call to Hades. */
  sessionValidateTimeoutMs: number;
  /**
   * What to do when Hades cannot be reached. Hades' own revocation check fails
   * closed (invariant I7) and this mirrors it. Flipping to `open` means a Hades
   * outage degrades to signature-only auth instead of a 503 — a deliberate,
   * documented tradeoff, not a default.
   */
  onValidatorError: "closed" | "open";

  /** Shared secret from `PUT /admin/clients/{id}/webhook`, for the receiver route. */
  webhookSecret?: string;
  /** Delivery age beyond which a signed webhook is refused. */
  webhookToleranceSeconds: number;

  /** Roles given to a principal provisioned on first sight, if no role is `isDefault`. */
  fallbackDefaultRoles: string[];
  /** Create a local principal automatically on first valid token. */
  autoProvision: boolean;
  /** Cache TTL for role definitions. Role edits take effect within this window. */
  roleCacheTtlSeconds: number;

  /** Name this API reports from `GET /auth/meta`. */
  domainName: string;
  /** Social providers enabled in Hades for this client, reported by `/auth/meta`. */
  socialProviders: string[];
  /** Placeholder display names read `<prefix>#<id>` until the person chooses one. */
  displayNamePrefix: string;
  /**
   * Proxies in front of this process (addresses or CIDR ranges). `X-Forwarded-For` is
   * believed only from these; see client-ip.ts. Empty = callers are identified by the
   * socket address alone, which behind a reverse proxy is the proxy.
   */
  trustedProxies: string[];
}

export interface HadesAuthConfigOverrides extends Partial<HadesAuthConfig> {}

/** Hades' deployed address. Overridable, but this is the one in production. */
export const DEFAULT_HADES_BASE_URL = "https://auth.impetusstudios.com";

const DEFAULTS = {
  clockSkewSeconds: 30,
  sessionValidation: "required" as const,
  sessionCacheTtlSeconds: 60,
  sessionNegativeCacheTtlSeconds: 30,
  sessionValidateTimeoutMs: 3000,
  onValidatorError: "closed" as const,
  webhookToleranceSeconds: 300,
  fallbackDefaultRoles: ["member"],
  autoProvision: true,
  roleCacheTtlSeconds: 60,
  domainName: "corbin.dev",
  displayNamePrefix: "Vanguard",
};

export function loadAuthConfig(
  overrides: HadesAuthConfigOverrides = {},
  env: Record<string, string | undefined> = process.env,
): HadesAuthConfig {
  const config: HadesAuthConfig = {
    hadesBaseUrl: stripTrailingSlash(env.HADES_BASE_URL || DEFAULT_HADES_BASE_URL),
    pasetoPublicKey: env.HADES_PASETO_PUBLIC_KEY ?? "",
    clientId: env.HADES_CLIENT_ID || undefined,
    realmId: env.HADES_REALM_ID || undefined,
    allowedRealms: csv(env.HADES_ALLOWED_REALMS),
    allowedClients: csv(env.HADES_ALLOWED_CLIENTS),
    clockSkewSeconds: num(env.HADES_CLOCK_SKEW_SECONDS, DEFAULTS.clockSkewSeconds),
    sessionValidation:
      env.HADES_SESSION_VALIDATION === "off" ? "off" : DEFAULTS.sessionValidation,
    clientApiKey: env.HADES_CLIENT_API_KEY || undefined,
    sessionCacheTtlSeconds: num(
      env.HADES_SESSION_CACHE_TTL_SECONDS,
      DEFAULTS.sessionCacheTtlSeconds,
    ),
    sessionNegativeCacheTtlSeconds: num(
      env.HADES_SESSION_NEGATIVE_CACHE_TTL_SECONDS,
      DEFAULTS.sessionNegativeCacheTtlSeconds,
    ),
    sessionValidateTimeoutMs: num(
      env.HADES_SESSION_TIMEOUT_MS,
      DEFAULTS.sessionValidateTimeoutMs,
    ),
    onValidatorError:
      env.HADES_ON_VALIDATOR_ERROR === "open" ? "open" : DEFAULTS.onValidatorError,
    webhookSecret: env.HADES_WEBHOOK_SECRET || undefined,
    webhookToleranceSeconds: num(
      env.HADES_WEBHOOK_TOLERANCE_SECONDS,
      DEFAULTS.webhookToleranceSeconds,
    ),
    fallbackDefaultRoles: csv(env.AUTH_DEFAULT_ROLES, DEFAULTS.fallbackDefaultRoles),
    autoProvision: bool(env.AUTH_AUTO_PROVISION, DEFAULTS.autoProvision),
    roleCacheTtlSeconds: num(env.AUTH_ROLE_CACHE_TTL_SECONDS, DEFAULTS.roleCacheTtlSeconds),
    domainName: env.AUTH_DOMAIN_NAME?.trim() || DEFAULTS.domainName,
    socialProviders: csv(env.AUTH_SOCIAL_PROVIDERS),
    displayNamePrefix: env.AUTH_DISPLAY_NAME_PREFIX?.trim() || DEFAULTS.displayNamePrefix,
    trustedProxies: csv(env.AUTH_TRUSTED_PROXIES),
    ...overrides,
  };

  // A service that knows its own client/realm should not accept tokens minted for
  // another one by default. Explicit allow-lists still win.
  if (config.allowedClients.length === 0 && config.clientId) {
    config.allowedClients = [config.clientId];
  }
  if (config.allowedRealms.length === 0 && config.realmId) {
    config.allowedRealms = [config.realmId];
  }

  assertUsable(config);
  return config;
}

/** Startup failure modes, all intentional. */
export function assertUsable(config: HadesAuthConfig): void {
  const problems: string[] = [];

  if (!config.pasetoPublicKey) {
    problems.push("HADES_PASETO_PUBLIC_KEY is required — without it no token can be verified");
  }
  if (config.sessionValidation === "required") {
    if (!config.hadesBaseUrl) {
      problems.push(
        "HADES_BASE_URL is required when session validation is on (set HADES_SESSION_VALIDATION=off to opt out, knowingly)",
      );
    }
    if (!config.clientId) {
      problems.push(
        "HADES_CLIENT_ID is required when session validation is on",
      );
    }
    if (!config.clientApiKey) {
      problems.push(
        "HADES_CLIENT_API_KEY is required when session validation is on — an unset key would silently disable revocation checking. " +
          "(HADES_INTERNAL_API_KEY is no longer read: Hades authenticates /internal/* with a per-client key, generated by POST /admin/clients/{id}/api-key)",
      );
    }
  }
  try {
    parseTrusted(config.trustedProxies);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length > 0) {
    throw new Error(`Auth configuration is unusable:\n  - ${problems.join("\n  - ")}`);
  }
}

function csv(value: string | undefined, fallback: string[] = []): string[] {
  if (!value) return fallback;
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
