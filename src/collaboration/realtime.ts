import Database from 'better-sqlite3';
import { CollaborationEvent } from './events';
import { getRuntimeMetrics } from '../operations/metrics';
import { getSocialRealtimeHub } from '../social/realtime';

export interface CollaborationControlMessage {
  readonly type:
    | 'liveDraft.updated'
    | 'liveDraft.lockChanged'
    | 'liveDraft.cleared'
    | 'liveDraft.committed';
  readonly sessionId: string;
  readonly occurredAt: string;
  readonly [key: string]: unknown;
}

export interface RealtimeConnection {
  readonly audience?: 'member' | 'public';
  readonly sessionId: string;
  readonly userId?: string;
  readonly authSessionId?: string;
  readonly publicShareId?: string;
  readonly publicViewSessionHash?: string;
  readonly ipAddress: string;
  deliver(event: CollaborationEvent): void;
  deliverControl(message: CollaborationControlMessage): void;
  revoke(reason: string): void;
  membershipChanged(role: string, membershipVersion: number): void;
  sessionDeleted(): void;
  close(): void;
}

export class CollaborationRealtimeHub {
  private readonly connections = new Set<RealtimeConnection>();

  constructor(private readonly db: Database.Database) {}

  add(connection: RealtimeConnection): () => void {
    this.connections.add(connection);
    return () => this.connections.delete(connection);
  }

  publish(event: CollaborationEvent): void {
    if (event.type.startsWith('session.')) getSocialRealtimeHub(this.db).sessionChanged(event.sessionId);
    else if (event.type.startsWith('log.')) {
      const owner = this.db.prepare('SELECT owner_user_id FROM sessions WHERE id = ?').pluck().get(event.sessionId) as string | undefined;
      if (owner) getSocialRealtimeHub(this.db).sharedCatalogChanged(owner);
    }
    getRuntimeMetrics(this.db).recordEventCommitted(event.type);
    for (const connection of [...this.connections]) {
      if (connection.sessionId !== event.sessionId) continue;
      try {
        connection.deliver(event);
      } catch {
        this.connections.delete(connection);
        try {
          connection.close();
        } catch {
          // A broken transport must never escape into the committed mutation path.
        }
      }
    }
  }

  publishControl(message: CollaborationControlMessage): void {
    for (const connection of [...this.connections]) {
      if (connection.audience !== 'member' || connection.sessionId !== message.sessionId) continue;
      try {
        connection.deliverControl(message);
      } catch {
        this.connections.delete(connection);
        try {
          connection.close();
        } catch {
          // A broken member control transport is isolated from the API response.
        }
      }
    }
  }

  revoke(sessionId: string, userId: string, reason = 'MEMBERSHIP_REVOKED'): void {
    getSocialRealtimeHub(this.db).notify([userId]);
    getSocialRealtimeHub(this.db).sessionChanged(sessionId);
    this.db.prepare(`
      DELETE FROM ws_tickets
      WHERE session_id = ? AND user_id = ? AND consumed_at IS NULL
    `).run(sessionId, userId);
    for (const connection of [...this.connections]) {
      if (connection.sessionId === sessionId && connection.userId === userId) {
        this.connections.delete(connection);
        try {
          connection.revoke(reason);
        } catch {
          this.connections.delete(connection);
          try {
            connection.close();
          } catch {
            // Ignore transport cleanup errors.
          }
        }
      }
    }
  }

  revokeUser(userId: string, reason = 'AUTHENTICATION_CHANGED'): void {
    getSocialRealtimeHub(this.db).revokeUser(userId);
    this.db.prepare(`
      DELETE FROM ws_tickets WHERE user_id = ? AND consumed_at IS NULL
    `).run(userId);
    for (const connection of [...this.connections]) {
      if (connection.audience !== 'member' || connection.userId !== userId) continue;
      this.connections.delete(connection);
      try {
        connection.revoke(reason);
      } catch {
        try {
          connection.close();
        } catch {
          // Ignore transport cleanup errors.
        }
      }
    }
  }

  revokeAuthSession(
    userId: string,
    authSessionId: string,
    reason = 'DEVICE_SESSION_REVOKED',
  ): void {
    getSocialRealtimeHub(this.db).revokeUser(userId, authSessionId);
    this.db.prepare(`
      DELETE FROM ws_tickets
      WHERE user_id = ? AND auth_session_id = ? AND consumed_at IS NULL
    `).run(userId, authSessionId);
    for (const connection of [...this.connections]) {
      if (
        connection.audience !== 'member' ||
        connection.userId !== userId ||
        connection.authSessionId !== authSessionId
      ) continue;
      this.connections.delete(connection);
      try {
        connection.revoke(reason);
      } catch {
        try {
          connection.close();
        } catch {
          // Ignore transport cleanup errors.
        }
      }
    }
  }

  roleChanged(
    sessionId: string,
    userId: string,
    role: string,
    membershipVersion: number,
  ): void {
    getSocialRealtimeHub(this.db).notify([userId]);
    getSocialRealtimeHub(this.db).sessionChanged(sessionId);
    this.db.prepare(`
      DELETE FROM ws_tickets
      WHERE session_id = ? AND user_id = ? AND consumed_at IS NULL
    `).run(sessionId, userId);
    for (const connection of [...this.connections]) {
      if (connection.sessionId === sessionId && connection.userId === userId) {
        this.connections.delete(connection);
        try {
          connection.membershipChanged(role, membershipVersion);
        } catch {
          this.connections.delete(connection);
          try {
            connection.close();
          } catch {
            // Ignore transport cleanup errors.
          }
        }
      }
    }
  }

  sessionDeleted(sessionId: string): void {
    getSocialRealtimeHub(this.db).sessionChanged(sessionId);
    this.db.prepare(`
      DELETE FROM ws_tickets WHERE session_id = ? AND consumed_at IS NULL
    `).run(sessionId);
    for (const connection of [...this.connections]) {
      if (connection.sessionId !== sessionId) continue;
      this.connections.delete(connection);
      try {
        connection.sessionDeleted();
      } catch {
        try {
          connection.close();
        } catch {
          // Ignore transport cleanup errors after the final event was committed.
        }
      }
    }
  }

  revokePublicShare(publicShareId: string): void {
    for (const connection of [...this.connections]) {
      if (connection.publicShareId !== publicShareId) continue;
      this.connections.delete(connection);
      try {
        connection.revoke('PUBLIC_SHARE_REVOKED');
      } catch {
        try {
          connection.close();
        } catch {
          // Ignore transport cleanup errors after capability revocation committed.
        }
      }
    }
  }

  connectionCount(filter: {
    audience?: 'member' | 'public';
    sessionId?: string;
    userId?: string;
    authSessionId?: string;
    publicShareId?: string;
    ipAddress?: string;
  }): number {
    let count = 0;
    for (const connection of this.connections) {
      if (filter.audience !== undefined && connection.audience !== filter.audience) continue;
      if (filter.sessionId !== undefined && connection.sessionId !== filter.sessionId) continue;
      if (filter.userId !== undefined && connection.userId !== filter.userId) continue;
      if (
        filter.authSessionId !== undefined &&
        connection.authSessionId !== filter.authSessionId
      ) continue;
      if (
        filter.publicShareId !== undefined &&
        connection.publicShareId !== filter.publicShareId
      ) continue;
      if (filter.ipAddress !== undefined && connection.ipAddress !== filter.ipAddress) continue;
      count += 1;
    }
    return count;
  }

  publicShareConnectionCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const connection of this.connections) {
      if (connection.audience !== 'public' || !connection.publicShareId) continue;
      counts.set(
        connection.publicShareId,
        (counts.get(connection.publicShareId) ?? 0) + 1,
      );
    }
    return counts;
  }

  publicShareConnections(publicShareId: string): Array<{
    viewSessionHash?: string;
    ipAddress: string;
  }> {
    const result: Array<{ viewSessionHash?: string; ipAddress: string }> = [];
    for (const connection of this.connections) {
      if (
        connection.audience !== 'public' ||
        connection.publicShareId !== publicShareId
      ) continue;
      result.push({
        ...(connection.publicViewSessionHash
          ? { viewSessionHash: connection.publicViewSessionHash }
          : {}),
        ipAddress: connection.ipAddress,
      });
    }
    return result;
  }

  closeAll(): void {
    getSocialRealtimeHub(this.db).closeAll();
    for (const connection of [...this.connections]) {
      try {
        connection.close();
      } catch {
        // Best-effort shutdown of independently failing transports.
      }
    }
    this.connections.clear();
  }
}

const hubs = new WeakMap<Database.Database, CollaborationRealtimeHub>();

export function getRealtimeHub(db: Database.Database): CollaborationRealtimeHub {
  let hub = hubs.get(db);
  if (!hub) {
    hub = new CollaborationRealtimeHub(db);
    hubs.set(db, hub);
  }
  return hub;
}
