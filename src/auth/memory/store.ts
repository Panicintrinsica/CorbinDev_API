import type { AuthStore } from "../ports.ts";
import type { Principal, RoleDefinition } from "../types.ts";
import { AuthError } from "../errors.ts";
import { displayNameKey, type Account, type VerificationTier } from "../account.ts";

/**
 * An in-process AuthStore with no database. Mirrors `charon`'s `InMemoryAuthStore`:
 * for tests, for local development without Mongo, and as the executable statement of
 * what each port method must do. Not for production — nothing survives a restart and
 * nothing is shared between instances.
 */
export class InMemoryAuthStore implements AuthStore {
  principals = new Map<string, Principal>();
  roles = new Map<string, RoleDefinition>();
  accounts = new Map<string, Account>();
  events = new Set<string>();
  /** Make every principal read fail, to exercise the fail-closed paths. */
  failReads = false;

  async getPrincipal(userId: string) {
    if (this.failReads) throw new Error("store is down");
    return this.principals.get(userId) ?? null;
  }

  async provisionPrincipal(input: { userId: string; roles: string[]; displayName?: string }) {
    const existing = this.principals.get(input.userId);
    if (existing) return existing;
    const now = new Date();
    const principal: Principal = {
      userId: input.userId,
      roles: input.roles,
      directPermissions: [],
      deniedPermissions: [],
      status: "active",
      displayName: input.displayName,
      createdAt: now,
      updatedAt: now,
    };
    this.principals.set(input.userId, principal);
    return principal;
  }

  async getRoles(names: string[]) {
    return names.map((n) => this.roles.get(n)).filter((r): r is RoleDefinition => !!r);
  }

  async getDefaultRoles() {
    return [...this.roles.values()].filter((r) => r.isDefault);
  }

  async revokeBefore(userId: string, at: Date) {
    const existing = this.principals.get(userId) ?? (await this.provisionPrincipal({ userId, roles: [] }));
    // $max: an out-of-order event can never lower an existing watermark.
    if (!existing.revokedBefore || at > existing.revokedBefore) existing.revokedBefore = at;
  }

  async setStatus(userId: string, status: Principal["status"]) {
    const existing = this.principals.get(userId) ?? (await this.provisionPrincipal({ userId, roles: [] }));
    existing.status = status;
  }

  async touchLastSeen(userId: string, at: Date) {
    const principal = this.principals.get(userId);
    if (principal) principal.lastSeenAt = at;
    for (const account of this.accounts.values()) {
      if (account.hadesUserId === userId) account.lastSeenAt = at;
    }
  }

  async deletePrincipal(userId: string) {
    return this.principals.delete(userId);
  }

  // --- Realm accounts ----------------------------------------------------------

  async getAccountByHadesId(hadesUserId: string) {
    for (const account of this.accounts.values()) {
      if (account.hadesUserId === hadesUserId) return account;
    }
    return null;
  }

  async getAccount(accountId: string) {
    return this.accounts.get(accountId) ?? null;
  }

  async provisionAccount(input: { hadesUserId: string; displayName: string; level: number }) {
    const existing = await this.getAccountByHadesId(input.hadesUserId);
    if (existing) return existing;
    if (await this.displayNameTaken(input.displayName)) throw new AuthError("display_name_taken");
    const now = new Date();
    const account: Account = {
      accountId: crypto.randomUUID(),
      hadesUserId: input.hadesUserId,
      displayName: input.displayName,
      displayNameSet: false,
      accountLevel: input.level,
      verificationTier: "none",
      verificationUrl: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastSeenAt: null,
      extra: {},
    };
    this.accounts.set(account.accountId, account);
    return account;
  }

  async deleteAccountByHadesId(hadesUserId: string) {
    const account = await this.getAccountByHadesId(hadesUserId);
    return account ? this.accounts.delete(account.accountId) : false;
  }

  async setAccountVerification(hadesUserId: string, tier: VerificationTier, url: string | null) {
    const account = await this.getAccountByHadesId(hadesUserId);
    if (!account) return;
    account.verificationTier = tier;
    account.verificationUrl = url;
  }

  async updateAccountLevel(accountId: string, level: number) {
    const account = this.accounts.get(accountId);
    if (account) account.accountLevel = level;
  }

  async updateDisplayName(accountId: string, displayName: string) {
    const account = this.accounts.get(accountId);
    if (!account) return;
    const holder = await this.getAccountByDisplayName(displayName);
    if (holder && holder.accountId !== accountId) throw new AuthError("display_name_taken");
    account.displayName = displayName;
    account.displayNameSet = true;
  }

  async getAccountByDisplayName(displayName: string) {
    const key = displayNameKey(displayName);
    for (const account of this.accounts.values()) {
      if (displayNameKey(account.displayName) === key) return account;
    }
    return null;
  }

  async displayNameTaken(displayName: string) {
    return (await this.getAccountByDisplayName(displayName)) !== null;
  }

  async listAccounts() {
    return [...this.accounts.values()];
  }

  async recordWebhookEvent(event: { eventId: string }) {
    if (this.events.has(event.eventId)) return false;
    this.events.add(event.eventId);
    return true;
  }

  async forgetWebhookEvent(eventId: string) {
    this.events.delete(eventId);
  }
}
