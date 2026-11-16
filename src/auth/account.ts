/**
 * The realm account: what this site knows about a person beyond their Hades identity
 * — the name shown to others, their account level, their verification signal.
 *
 * Pure: no I/O. Mirrors `charon/src/account/mod.rs` and `charon/src/types.rs`; the wire
 * shape (`AccountWire`) is Charon's published contract, which `hades-ng` is written
 * against, so its field names are snake_case on purpose.
 */

import type { PrincipalStatus } from "./types.ts";

/** Hades' account level scale. Tiers are bands of ten. */
export const AccountLevel = {
  IRON: 0, // Free users
  COPPER: 10, // Tier 1 subscriber
  SILVER: 20,
  ELECTRUM: 30,
  GOLD: 40,
  PLATINUM: 50, // Tier 5 subscriber
  DIAMOND: 60, // Reserved
  SAPPHIRE: 70, // Reserved
  EMERALD: 80, // Reserved
  RUBY: 90, // Reserved
  ALEXANDRITE: 100, // Developers
} as const;

const TIER_NAMES = [
  "Iron",
  "Copper",
  "Silver",
  "Electrum",
  "Gold",
  "Platinum",
  "Diamond",
  "Sapphire",
  "Emerald",
  "Ruby",
] as const;

export function tierName(level: number): string {
  const band = Math.floor(level / 10);
  return band >= TIER_NAMES.length ? "Alexandrite" : TIER_NAMES[Math.max(band, 0)]!;
}

export function baseTier(level: number): number {
  return Math.floor(level / 10) * 10;
}

export type VerificationTier = "none" | "self" | "staff";

export function isVerificationTier(value: unknown): value is VerificationTier {
  return value === "none" || value === "self" || value === "staff";
}

/** This API's record of a person, one per Hades user. */
export interface Account {
  /** Stable id for this site's own data (a UUID). Not the Hades id. */
  accountId: string;
  hadesUserId: string;
  displayName: string;
  /** False while `displayName` is a placeholder the system chose. */
  displayNameSet: boolean;
  accountLevel: number;
  verificationTier: VerificationTier;
  verificationUrl: string | null;
  status: PrincipalStatus;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date | null;
  /** Room for the host product; never interpreted here. */
  extra: Record<string, unknown>;
}

// --- Display names -----------------------------------------------------------------

export interface DisplayNameRules {
  min: number;
  max: number;
  /** Placeholder names read `<prefix>#<six characters of the user id>`. */
  generatedPrefix: string;
}

export const DEFAULT_DISPLAY_NAME_RULES: DisplayNameRules = {
  min: 1,
  max: 64,
  generatedPrefix: "Vanguard",
};

/**
 * Trims, collapses runs of whitespace to a single space and bounds the length in
 * characters (code points, as Charon counts them). Control characters are refused: the
 * name is shown to other people and written to logs. Returns `null` when unacceptable.
 */
export function normaliseDisplayName(
  raw: string,
  rules: Pick<DisplayNameRules, "min" | "max"> = DEFAULT_DISPLAY_NAME_RULES,
): string | null {
  // Same order as Charon: whitespace (tabs and newlines included) is folded to a single
  // space first, and only the controls that survive that are refused.
  const name = raw.split(/\s+/u).filter(Boolean).join(" ");
  const length = [...name].length;
  if (length < rules.min || length > rules.max || /\p{Cc}/u.test(name)) return null;
  return name;
}

/**
 * The form uniqueness is judged on: "Nova" and "nova" are the same name. Lookalike
 * characters (Cyrillic "а" for Latin "a") are deliberately NOT folded together.
 * Call on a name already passed through `normaliseDisplayName`.
 */
export function displayNameKey(name: string): string {
  return name.toLowerCase();
}

/**
 * The placeholder a new account gets until its owner chooses a name. Attempt 0 is
 * derived from the user id; later attempts are random, for the rare collision.
 */
export function placeholderDisplayName(
  userId: string,
  attempt: number,
  prefix = DEFAULT_DISPLAY_NAME_RULES.generatedPrefix,
): string {
  const suffix =
    attempt === 0
      ? [...userId].slice(0, 6).join("")
      : crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  return `${prefix}#${suffix}`;
}

// --- Wire shapes (Charon's published contract) -------------------------------------

export interface AccountWire {
  account_id: string;
  hades_user_id: string;
  display_name: string;
  display_name_set: boolean;
  account_level: number;
  verification_tier: string;
  verification_url: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  extra: Record<string, unknown>;
}

export interface AccountResponseWire extends AccountWire {
  tier_name: string;
  base_tier: number;
  roles: string[];
  effective_permissions: string[];
}

export function toAccountWire(account: Account): AccountWire {
  return {
    account_id: account.accountId,
    hades_user_id: account.hadesUserId,
    display_name: account.displayName,
    display_name_set: account.displayNameSet,
    account_level: account.accountLevel,
    verification_tier: account.verificationTier,
    verification_url: account.verificationUrl,
    status: account.status,
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
    last_seen_at: account.lastSeenAt ? account.lastSeenAt.toISOString() : null,
    extra: account.extra,
  };
}

export function toAccountResponseWire(
  account: Account,
  roles: string[],
  effectivePermissions: string[],
): AccountResponseWire {
  return {
    ...toAccountWire(account),
    tier_name: tierName(account.accountLevel),
    base_tier: baseTier(account.accountLevel),
    roles,
    effective_permissions: effectivePermissions,
  };
}
