import type { Connection } from "mongoose";
import type { AuthStore } from "../ports.ts";
import type { Principal, RoleDefinition } from "../types.ts";
import { createAuthModels, type AuthModels, type PrincipalDoc, type RoleDoc } from "./schemas.ts";

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
      { upsert: true, new: true, setDefaultsOnInsert: true },
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
      { new: true, upsert: true, setDefaultsOnInsert: true },
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
      { new: true, upsert: true, setDefaultsOnInsert: true },
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
      { new: true, upsert: true, setDefaultsOnInsert: true },
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
      { new: true },
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
      { new: true, upsert: true, setDefaultsOnInsert: true },
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
