import mongoose, { type Connection, type Model } from "mongoose";

/**
 * The AuthZ data model. Hades owns identity; this owns what an identity may DO here.
 *
 * Deliberate boundaries:
 *  - `_id` of a principal IS the Hades `sub` (a UUID string), not an ObjectId. One
 *    identifier across services; no mapping table, no chance of divergence.
 *  - No credential material, no email, no username as an identity. `displayName` is
 *    a nullable convenience cache and is never used to resolve anyone.
 *    (Hades invariant I22: an address this service did not verify is not an identity.)
 *  - Permissions are strings, resolved in authorize.ts. The database stores grants,
 *    not policy logic.
 *
 * PORTABILITY: these factories take a Connection instead of importing one, so the
 * module can be lifted into a package without dragging a database singleton along.
 * A non-Mongo port replaces this file plus store.ts and nothing else.
 */

export interface PrincipalDoc {
  _id: string;
  roles: string[];
  directPermissions: string[];
  deniedPermissions: string[];
  status: "active" | "disabled";
  displayName?: string;
  revokedBefore?: Date;
  lastSeenAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoleDoc {
  _id: string;
  permissions: string[];
  description?: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookEventDoc {
  _id: string;
  type: string;
  userId: string;
  occurredAt: Date;
  receivedAt: Date;
}

export interface RevocationDoc {
  userId: string;
  revokedBefore: Date;
  reason: string;
  createdAt: Date;
}

const principalSchema = new mongoose.Schema<PrincipalDoc>(
  {
    // The Hades global user id. Supplied, never generated here.
    _id: { type: String, required: true },
    roles: { type: [String], default: [] },
    directPermissions: { type: [String], default: [] },
    deniedPermissions: { type: [String], default: [] },
    status: { type: String, enum: ["active", "disabled"], default: "active", required: true },
    displayName: { type: String, required: false },
    // Access tokens with `iat` at or before this are refused. Raised by security
    // webhooks and by local admin action; never lowered automatically.
    revokedBefore: { type: Date, required: false },
    lastSeenAt: { type: Date, required: false },
  },
  { timestamps: true, _id: false, collection: "auth_principals" },
);

principalSchema.index({ roles: 1 });
principalSchema.index({ status: 1 });

const roleSchema = new mongoose.Schema<RoleDoc>(
  {
    // The role name is the key. Uniqueness is the index's job, not a prior read.
    _id: { type: String, required: true },
    permissions: { type: [String], default: [] },
    description: { type: String, required: false },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true, _id: false, collection: "auth_roles" },
);

roleSchema.index({ isDefault: 1 });

const webhookEventSchema = new mongoose.Schema<WebhookEventDoc>(
  {
    // `X-Hades-Event-Id`, stable across retries and identical for every recipient.
    // The unique _id is what makes at-least-once delivery safe to apply.
    _id: { type: String, required: true },
    type: { type: String, required: true },
    userId: { type: String, required: true },
    occurredAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false, collection: "auth_webhook_events" },
);

// Dedupe only needs to outlive the sender's retry window by a wide margin.
webhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
webhookEventSchema.index({ userId: 1, occurredAt: -1 });

const revocationSchema = new mongoose.Schema<RevocationDoc>(
  {
    userId: { type: String, required: true },
    revokedBefore: { type: Date, required: true },
    reason: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "auth_revocations" },
);

revocationSchema.index({ userId: 1, createdAt: -1 });

export interface AuthModels {
  Principal: Model<PrincipalDoc>;
  Role: Model<RoleDoc>;
  WebhookEvent: Model<WebhookEventDoc>;
  Revocation: Model<RevocationDoc>;
}

/** Idempotent: re-uses an already-compiled model on the same connection. */
export function createAuthModels(connection: Connection): AuthModels {
  return {
    Principal:
      (connection.models.auth_principal as Model<PrincipalDoc>) ??
      connection.model<PrincipalDoc>("auth_principal", principalSchema),
    Role:
      (connection.models.auth_role as Model<RoleDoc>) ??
      connection.model<RoleDoc>("auth_role", roleSchema),
    WebhookEvent:
      (connection.models.auth_webhook_event as Model<WebhookEventDoc>) ??
      connection.model<WebhookEventDoc>("auth_webhook_event", webhookEventSchema),
    Revocation:
      (connection.models.auth_revocation as Model<RevocationDoc>) ??
      connection.model<RevocationDoc>("auth_revocation", revocationSchema),
  };
}
