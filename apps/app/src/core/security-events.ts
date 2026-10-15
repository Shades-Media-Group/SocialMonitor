import type { DB } from './db.ts'

/**
 * Something that changed how a person signs in, or a sign-in itself. Called where it happens;
 * the audit log and the security alert emails pick these up.
 */
export type SecurityEventType =
  | 'signed_in'
  | 'session_revoked'
  | 'sessions_ended'
  | 'password_changed'
  | 'second_factor_added'
  | 'second_factor_removed'
  | 'recovery_code_used'
  | 'recovery_codes_new'

export interface SecurityEvent {
  type: SecurityEventType
  userId: number
  ip: string
  ua: string
  /** Small plain values only: a method name, a passkey's name, "new device". */
  detail?: Record<string, string | number | boolean | null>
}

// TODO: write to the audit log (core/audit.ts) and send the matching security alert email.
export function securityEvent(_db: DB, _event: SecurityEvent) {}
