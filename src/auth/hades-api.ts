import type { HadesAuthConfig } from "./config.ts";
import { AuthError } from "./errors.ts";

/**
 * Calls this service makes to Hades as itself (the client's API key), not on behalf of
 * a user. Mirrors `charon/src/hades_api.rs`.
 */

export interface ReportRequest {
  /** Hades user id of the person the report is about. */
  subject_user_id: string;
  /** Short machine-readable kind, e.g. `board_ban`. Hades caps it at 64 characters. */
  kind: string;
  /** Hades caps this at 4000 characters. */
  reason: string;
  /** Opaque pointer back into the host product (a sanction id, say). */
  reference?: string;
}

/**
 * Files a report in Hades' review queue (`POST /internal/reports`).
 * @throws AuthError("validator_unavailable") when it cannot be filed.
 */
export async function fileReport(config: HadesAuthConfig, report: ReportRequest): Promise<void> {
  if (!config.clientId || !config.clientApiKey) {
    throw new AuthError(
      "validator_unavailable",
      "HADES_CLIENT_ID and HADES_CLIENT_API_KEY are required to file reports",
    );
  }
  let response: Response;
  try {
    response = await fetch(`${config.hadesBaseUrl}/internal/reports`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-ID": config.clientId,
        Authorization: `Bearer ${config.clientApiKey}`,
      },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(Math.max(config.sessionValidateTimeoutMs, 5000)),
    });
  } catch (cause) {
    throw new AuthError("validator_unavailable", undefined, cause);
  }
  if (!response.ok) {
    throw new AuthError(
      "validator_unavailable",
      `Hades rejected the report: ${response.status}`,
    );
  }
}
