import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

export const ACCOUNT_SHARE_AUDIT_ACTIONS = [
  'account_share.requested',
  'account_share.accepted',
  'account_share.rejected',
  'account_share.cancelled',
  'account_share.revoked',
  'account_share.updated',
  'account_share.blocked',
  'account_share.unblocked',
  'account_share.joined',
  'account_share.log_created',
  'account_share.log_updated',
  'account_share.log_deleted',
] as const;

export type AccountShareAuditAction = (typeof ACCOUNT_SHARE_AUDIT_ACTIONS)[number];

export function appendAccountShareAudit(
  db: Database.Database,
  input: {
    action: AccountShareAuditAction;
    actorUserId: string;
    requestId: string;
    mutationId: string;
    grantId?: string | null;
    targetUserId?: string | null;
    sessionId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    occurredAt: string;
  },
): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO account_share_audit_events (
      id, action, actor_user_id, grant_id, target_user_id, session_id,
      request_id, mutation_id, before_json, after_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.action,
    input.actorUserId,
    input.grantId ?? null,
    input.targetUserId ?? null,
    input.sessionId ?? null,
    input.requestId,
    input.mutationId,
    input.before == null ? null : JSON.stringify(input.before),
    input.after == null ? null : JSON.stringify(input.after),
    input.occurredAt,
  );
  return id;
}
