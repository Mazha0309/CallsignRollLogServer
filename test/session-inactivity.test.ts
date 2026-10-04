import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getRealtimeHub } from '../src/collaboration/realtime';
import { openDatabase } from '../src/db/database';
import { sweepInactiveSessions } from '../src/operations/session-inactivity';

const OWNER_ID = 'inactivity-owner';
const OLD = '2026-08-16T08:00:00.000Z';

function seedSession(
  db: ReturnType<typeof openDatabase>,
  id: string,
  updatedAt = OLD,
): void {
  db.prepare(`
    INSERT INTO sessions (
      id, title, status, owner_user_id, version, event_seq, min_retained_seq,
      created_at, updated_at
    ) VALUES (?, ?, 'active', ?, 1, 0, 0, ?, ?)
  `).run(id, `Session ${id}`, OWNER_ID, OLD, updatedAt);
  db.prepare(`
    INSERT INTO session_members (
      id, session_id, user_id, role, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'owner', 1, ?, ?)
  `).run(randomUUID(), id, OWNER_ID, OLD, updatedAt);
}

test('two-hour sweep closes only strictly inactive Sessions and broadcasts the close', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, 'inactivity-owner', 'hash', 'user', ?, ?)
    `).run(OWNER_ID, OLD, OLD);
    seedSession(db, 'stale');
    seedSession(db, 'boundary', '2026-08-16T10:00:00.000Z');
    seedSession(db, 'recent-session', '2026-08-16T10:00:01.000Z');
    seedSession(db, 'legacy-log-activity');
    seedSession(db, 'recent-draft');

    db.prepare(`
      INSERT INTO logs (
        sync_id, session_id, version, time, controller, callsign,
        created_at, updated_at, created_by, updated_by
      ) VALUES ('recent-log', 'legacy-log-activity', 1, ?, 'BG5CRL',
                'BG5LOG', ?, ?, ?, ?)
    `).run(
      '2026-08-16T10:30:00.000Z',
      OLD,
      '2026-08-16T10:30:00.000Z',
      OWNER_ID,
      OWNER_ID,
    );
    db.prepare(`
      INSERT INTO session_live_drafts (
        session_id, draft_id, version, callsign, rst_sent, rst_rcvd,
        field_revisions_json, last_updated_by, created_at, last_updated_at
      ) VALUES ('stale', 'stale-draft', 2, 'BG5STALE', '59', '59',
                '{}', ?, ?, '2026-08-16T09:59:59.000Z')
    `).run(OWNER_ID, OLD);
    db.prepare(`
      INSERT INTO session_live_drafts (
        session_id, draft_id, version, callsign, rst_sent, rst_rcvd,
        field_revisions_json, last_updated_by, created_at, last_updated_at
      ) VALUES ('recent-draft', 'recent-draft-id', 2, 'BG5ACTIVE', '59', '59',
                '{}', ?, ?, '2026-08-16T10:30:00.000Z')
    `).run(OWNER_ID, OLD);

    const events: unknown[] = [];
    const controls: unknown[] = [];
    const unsubscribe = getRealtimeHub(db).add({
      audience: 'member',
      sessionId: 'stale',
      userId: OWNER_ID,
      ipAddress: 'inactivity-test',
      deliver: (event) => events.push(event),
      deliverControl: (control) => controls.push(control),
      revoke() { /* probe */ },
      membershipChanged() { /* probe */ },
      sessionDeleted() { /* probe */ },
      close() { /* probe */ },
    });
    try {
      const result = sweepInactiveSessions(db, {
        now: new Date('2026-08-16T12:00:00.000Z'),
      });

      assert.equal(result.inspected, 5);
      assert.deepEqual(result.closedSessionIds, ['stale']);
      assert.equal(
        db.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get('stale'),
        'closed',
      );
      assert.equal(
        db.prepare('SELECT closed_at FROM sessions WHERE id = ?').pluck().get('stale'),
        '2026-08-16T12:00:00.000Z',
      );
      for (const id of ['boundary', 'recent-session', 'legacy-log-activity', 'recent-draft']) {
        assert.equal(
          db.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get(id),
          'active',
          id,
        );
      }
      assert.equal(
        db.prepare('SELECT COUNT(*) FROM session_live_drafts WHERE session_id = ?')
          .pluck().get('stale'),
        0,
      );
      assert.equal(events.length, 1);
      assert.equal((events[0] as { type: string }).type, 'session.closed');
      assert.equal(controls.length, 1);
      assert.deepEqual(
        {
          type: (controls[0] as { type: string }).type,
          terminal: (controls[0] as { terminal: boolean }).terminal,
          reason: (controls[0] as { reason: string }).reason,
        },
        { type: 'liveDraft.cleared', terminal: true, reason: 'inactivity' },
      );
    } finally {
      unsubscribe();
    }
  } finally {
    db.close();
  }
});
