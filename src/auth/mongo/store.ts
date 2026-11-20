import type { Connection } from "mongoose";
import type { AuthStore } from "../ports.ts";
import type { Principal, RoleDefinition } from "../types.ts";
import { AuthError } from "../errors.ts";
import { displayNameKey, type Account, type VerificationTier } from "../account.ts";
import {
  createAuthModels,
  type AccountDoc,
  type AuthModels,
  type PrincipalDoc,
  type RoleDoc,
} from "./schemas.ts";

/**
 * MongoDB implementation of the AuthStore port. This file and schemas.ts are the
 * only Mongo-aware code in the module.
 */
export class MongoAuthStore implements AuthStore {
  readonly models: AuthModels;

  constructor(connection: Connection) {
    this.models = createAuthModels(connection);
  }

  async getPrincipal(userId: string): Promise<Principal | null> {
    const doc = await this.models.Principal.findById(userId).lean<PrincipalDoc>().exec();
    return doc ? toPrincipal(doc) : null;
  }

  async provisionPrincipal(input: {
    userId: string;
    roles: string[];
    displayName?: string;
  }): Promise<Principal> {
    // Upsert with $setOnInsert so two concurrent first requests converge instead of
    // one clobbering the other's roles. The index settles the race, not a prior read.
    const now = new Date();
    const doc = await this.models.Principal.findOneAndUpdate(
      { _id: input.userId },
      {
        $setOnInsert: {
          roles: input.roles,
          directPermissions: [],
          deniedPermissions: [],
          status: "active",
          displayName: input.displayName,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    )
      .lean<PrincipalDoc>()
      .exec();
    return toPrincipal(doc);
  }

  async getRoles(names: string[]): Promise<RoleDefinition[]> {
    if (names.length === 0) return [];
    const docs = await this.models.Role.find({ _id: { $in: names } })
      .lean<RoleDoc[]>()
      .exec();
    return docs.map(toRole);
  }

  async getDefaultRoles(): Promise<RoleDefinition[]> {
    const docs = await this.models.Role.find({ isDefault: true }).lean<RoleDoc[]>().exec();
    return docs.map(toRole);
  }

  async revokeBefore(userId: string, at: Date, reason: string): Promise<void> {
    // $max so an out-of-order webhook can never lower an existing watermark.
    await this.models.Principal.updateOne(
      { _id: userId },
      { $max: { revokedBefore: at }, $setOnInsert: { status: "active", roles: [] } },
      { upsert: true },
    ).exec();
    // Kept as an audit trail: Hades logs webhook dispatch but persists no delivery
    // record, so this is the only queryable history of why a session died here.
    await this.models.Revocation.create({ userId, revokedBefore: at, reason });
  }

  async setStatus(userId: string, status: Principal["status"]): Promise<void> {
    await this.models.Principal.updateOne(
      { _id: userId },
      { $set: { status } },
      { upsert: true },
    ).exec();
  }

  async touchLastSeen(userId: string, at: Date): Promise<void> {
    await this.models.Principal.updateOne({ _id: userId }, { $set: { lastSeenAt: at } }).exec();
    await this.models.Account.updateOne({ hadesUserId: userId }, { $set: { lastSeenAt: at } }).exec();
  }

  async recordWebhookEvent(event: {
    eventId: string;
    type: string;
    userId: string;
    occurredAt: Date;
  }): Promise<boolean> {
    try {
      await this.models.WebhookEvent.create({
        _id: event.eventId,
        type: event.type,
        userId: event.userId,
        occurredAt: event.occurredAt,
        receivedAt: new Date(),
      });
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false; // Already delivered. Not an error.
      throw error;
    }
  }

  async forgetWebhookEvent(eventId: string): Promise<void> {
    await this.models.WebhookEvent.deleteOne({ _id: eventId }).exec();
  }

  // --- Realm accounts ----------------------------------------------------------

  async getAccountByHadesId(hadesUserId: string): Promise<Account | null> {
    const doc = await this.models.Account.findOne({ hadesUserId }).lean<AccountDoc>().exec();
    return doc ? toAccount(doc) : null;
  }

  async getAccount(accountId: string): Promise<Account | null> {
    const doc = await this.models.Account.findById(accountId).lean<AccountDoc>().exec();
    return doc ? toAccount(doc) : null;
  }

  async provisionAccount(input: {
    hadesUserId: string;
    displayName: string;
    level: number;
  }): Promise<Account> {
    const existing = await this.getAccountByHadesId(input.hadesUserId);
    if (existing) return existing;

    const now = new Date();
    try {
      const created = await this.models.Account.create({
        _id: crypto.randomUUID(),
        hadesUserId: input.hadesUserId,
        displayName: input.displayName,
        displayNameKey: displayNameKey(input.displayName),
        displayNameSet: false,
        accountLevel: input.level,
        verificationTier: "none",
        verificationUrl: null,
        status: "active",
        lastSeenAt: null,
        extra: {},
        createdAt: now,
        updatedAt: now,
      });
      return toAccount(created.toObject() as AccountDoc);
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // Either someone else holds the placeholder name, or a concurrent request for
      // this same user won the race on `hadesUserId`. Only the latter is not an error.
      const winner = await this.getAccountByHadesId(input.hadesUserId);
      if (winner) return winner;
      throw new AuthError("display_name_taken", undefined, error);
    }
  }

  async deleteAccountByHadesId(hadesUserId: string): Promise<boolean> {
    const result = await this.models.Account.deleteOne({ hadesUserId }).exec();
    return result.deletedCount === 1;
  }

  async setAccountVerification(
    hadesUserId: string,
    tier: VerificationTier,
    url: string | null,
  ): Promise<void> {
    await this.models.Account.updateOne(
      { hadesUserId },
      { $set: { verificationTier: tier, verificationUrl: url ?? null } },
    ).exec();
  }

  async updateAccountLevel(accountId: string, level: number): Promise<void> {
    await this.models.Account.updateOne({ _id: accountId }, { $set: { accountLevel: level } }).exec();
  }

  async updateDisplayName(accountId: string, displayName: string): Promise<void> {
    try {
      // The unique index decides a race between two people picking the same name.
      await this.models.Account.updateOne(
        { _id: accountId },
        { $set: { displayName, displayNameKey: displayNameKey(displayName), displayNameSet: true } },
      ).exec();
    } catch (error) {
      if (isDuplicateKey(error)) throw new AuthError("display_name_taken", undefined, error);
      throw error;
    }
  }

  async getAccountByDisplayName(displayName: string): Promise<Account | null> {
    const doc = await this.models.Account.findOne({ displayNameKey: displayNameKey(displayName) })
      .lean<AccountDoc>()
      .exec();
    return doc ? toAccount(doc) : null;
  }

  async displayNameTaken(displayName: string): Promise<boolean> {
    return (await this.getAccountByDisplayName(displayName)) !== null;
  }

  async listAccounts(): Promise<Account[]> {
    const docs = await this.models.Account.find()
      .sort({ createdAt: -1 })
      .limit(500)
      .lean<AccountDoc[]>()
      .exec();
    return docs.map(toAccount);
  }

  // --- Local administration, beyond the port ---------------------------------
  //
  // Everything below acts on THIS API's record only. None of it reaches Hades: a
  // principal banned here can still authenticate, hold a valid token, and use every
  // other service in the realm. Account-level suspension is Hades' own app's job.
  //
  // The writes upsert, so a principal can be banned or granted a role before their
  // first request — the record simply exists ahead of the token that will match it.

  async setRoles(userId: string, roles: string[]): Promise<Principal | null> {
    const doc = await this.models.Principal.findOneAndUpdate(
      { _id: userId },
      { $set: { roles } },
      { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
    )
      .lean<PrincipalDoc>()
      .exec();
    return doc ? toPrincipal(doc) : null;
  }

  /** Grants and withholdings made straight to the user, on top of their roles. */
  async setPermissions(
    userId: string,
    permissions: { directPermissions?: string[]; deniedPermissions?: string[] },
  ): Promise<Principal | null> {
    const update: Record<string, string[]> = {};
    if (permissions.directPermissions) update.directPermissions = permissions.directPermissions;
    if (permissions.deniedPermissions) update.deniedPermissions = permissions.deniedPermissions;

    const doc = await this.models.Principal.findOneAndUpdate(
      { _id: userId },
      { $set: update },
      { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
    )
      .lean<PrincipalDoc>()
      .exec();
    return doc ? toPrincipal(doc) : null;
  }

  /**
   * Site ban: disables the principal here and raises the revocation watermark so
   * tokens already in the user's hands stop working against this API immediately.
   * Their Hades session is untouched.
   */
  async banPrincipal(userId: string, reason: string): Promise<Principal | null> {
    const now = new Date();
    const doc = await this.models.Principal.findOneAndUpdate(
      { _id: userId },
      { $set: { status: "disabled" }, $max: { revokedBefore: now } },
      { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
    )
      .lean<PrincipalDoc>()
      .exec();
    await this.models.Revocation.create({ userId, revokedBefore: now, reason });
    return doc ? toPrincipal(doc) : null;
  }

  /**
   * Lifts a site ban. The watermark deliberately stays where it is, matching Hades'
   * own unban semantics: the user may authenticate again, but the sessions that were
   * killed are not resurrected.
   */
  async unbanPrincipal(userId: string): Promise<Principal | null> {
    const doc = await this.models.Principal.findOneAndUpdate(
      { _id: userId },
      { $set: { status: "active" } },
      { returnDocument: "after" },
    )
      .lean<PrincipalDoc>()
      .exec();
    return doc ? toPrincipal(doc) : null;
  }

  /**
   * Forgets this API's record of a user: roles, grants, status, watermark. It is not
   * a ban — with auto-provisioning on, the next valid token recreates the record with
   * the default roles. Use it to reset someone to a clean slate, or to erase a
   * principal for a user who has been deleted in Hades.
   */
  async deletePrincipal(userId: string): Promise<boolean> {
    const result = await this.models.Principal.deleteOne({ _id: userId }).exec();
    return result.deletedCount === 1;
  }

  async upsertRole(role: RoleDefinition): Promise<RoleDefinition> {
    const doc = await this.models.Role.findOneAndUpdate(
      { _id: role.name },
      {
        $set: {
          permissions: role.permissions,
          description: role.description,
          isDefault: role.isDefault,
        },
      },
      { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
    )
      .lean<RoleDoc>()
      .exec();
    return toRole(doc);
  }

  async listRoles(): Promise<RoleDefinition[]> {
    const docs = await this.models.Role.find().lean<RoleDoc[]>().exec();
    return docs.map(toRole);
  }

  async deleteRole(name: string): Promise<boolean> {
    const result = await this.models.Role.deleteOne({ _id: name }).exec();
    return result.deletedCount === 1;
  }

  async listPrincipals(limit = 100, skip = 0): Promise<Principal[]> {
    const docs = await this.models.Principal.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Math.min(limit, 500))
      .lean<PrincipalDoc[]>()
      .exec();
    return docs.map(toPrincipal);
  }

  /**
   * Seeds role definitions that do not exist yet. Existing roles are left alone so
   * a deploy never silently reverts a permission edit made in the database.
   */
  async ensureRoles(roles: RoleDefinition[]): Promise<void> {
    for (const role of roles) {
      await this.models.Role.updateOne(
        { _id: role.name },
        {
          $setOnInsert: {
            permissions: role.permissions,
            description: role.description,
            isDefault: role.isDefault,
          },
        },
        { upsert: true },
      ).exec();
    }
  }
}

function toPrincipal(doc: PrincipalDoc): Principal {
  return {
    userId: doc._id,
    roles: doc.roles ?? [],
    directPermissions: doc.directPermissions ?? [],
    deniedPermissions: doc.deniedPermissions ?? [],
    status: doc.status ?? "active",
    displayName: doc.displayName,
    revokedBefore: doc.revokedBefore,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    lastSeenAt: doc.lastSeenAt,
  };
}

function toAccount(doc: AccountDoc): Account {
  return {
    accountId: doc._id,
    hadesUserId: doc.hadesUserId,
    displayName: doc.displayName,
    displayNameSet: doc.displayNameSet ?? false,
    accountLevel: doc.accountLevel ?? 0,
    verificationTier: doc.verificationTier ?? "none",
    verificationUrl: doc.verificationUrl ?? null,
    status: doc.status ?? "active",
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    lastSeenAt: doc.lastSeenAt ?? null,
    extra: doc.extra ?? {},
  };
}

function toRole(doc: RoleDoc): RoleDefinition {
  return {
    name: doc._id,
    permissions: doc.permissions ?? [],
    description: doc.description,
    isDefault: doc.isDefault ?? false,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}
