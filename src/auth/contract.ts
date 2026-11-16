/**
 * The wire contract this module shares with `hades-ng` (the Angular client) and with
 * Charon, the Rust implementation of the same gateway. These shapes mirror
 * `charon/contract/ts/*.ts`, which is generated from the Rust types; if one side
 * changes, bump `AUTH_CONTRACT_VERSION` and `HADES_SUPPORTED_CONTRACTS` in hades-ng.
 *
 * Field names are snake_case on purpose. Routes that predate Charon's contract
 * (`GET /auth/me`, the principal and role administration) keep their original
 * camelCase shapes, because the deployed frontend reads them.
 */

export const AUTH_CONTRACT_VERSION = 1;

export type { AccountWire as Account, AccountResponseWire as AccountResponse } from "./account.ts";

export interface AuthFeaturesWire {
  register: boolean;
  passkeys: boolean;
  passwordless: boolean;
  delete_account: boolean;
}

export interface AuthDisplayNameRulesWire {
  min: number;
  max: number;
}

export interface AuthMetaWire {
  contract_version: number;
  domain_name: string;
  social_providers: string[];
  features: AuthFeaturesWire;
  display_name_rules: AuthDisplayNameRulesWire;
}

export interface ErrorBody {
  error: string;
  field?: string | null;
}
