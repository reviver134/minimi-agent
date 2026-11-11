import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store, normaliseName } from '../src/memory/store.ts';

const at = (iso: string) => new Date(iso);

describe('store', () => {
  // S2-T1
  it('maps "Jayant" and " jayant " to one user', () => {
    const store = new Store(':memory:');
    const a = store.getOrCreateUser('Jayant', 'Asia/Kolkata', at('2026-11-11T04:30:00Z'));
    const b = store.getOrCreateUser(' jayant ', 'Asia/Kolkata', at('2026-11-11T05:00:00Z'));
    expect(b.userId).toBe(a.userId);
    expect(a.userName).toBe('jayant');
    expect(normaliseName('  Jayant   DUBEY ')).toBe('jayant dubey');
    expect(store.getOrCreateUser('someone else', 'UTC', at('2026-11-11T05:00:00Z')).userId).not.toBe(
      a.userId,
    );
    expect(() => store.getOrCreateUser('   ', 'UTC', at('2026-11-11T05:00:00Z'))).toThrow();
  });

  // S2-T2
  it('keeps turns, in order, after the database is reopened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'minimi-'));
    const path = join(dir, 'nested', 'test.db');
    try {
      let store = new Store(path);
      const user = store.getOrCreateUser('demo', 'Asia/Kolkata', at('2026-11-03T05:00:00Z'));
      const session = store.createSession(user.userId, at('2026-11-03T05:30:00Z'));
      for (let i = 1; i <= 4; i++) {
        store.addTurn({
          turnId: `turn-${i}`,
          sessionId: session.sessionId,
          userId: user.userId,
          userMessage: `question ${i}`,
          assistantMessage: `answer ${i}`,
          // Turns 2 and 3 share a timestamp: insertion order must still hold.
          createdAt: at(`2026-11-03T05:3${i === 3 ? 2 : i}:00Z`),
          userTimezone: 'Asia/Kolkata',
        });
      }
      store.close();

      store = new Store(path);
      const again = store.getOrCreateUser('demo', 'Asia/Kolkata', at('2026-11-04T05:00:00Z'));
      expect(again.userId).toBe(user.userId);
      const turns = store.listTurns(user.userId, session.sessionId);
      expect(turns.map((t) => t.userMessage)).toEqual([
        'question 1',
        'question 2',
        'question 3',
        'question 4',
      ]);
      expect(turns.map((t) => t.assistantMessage)).toEqual(['answer 1', 'answer 2', 'answer 3', 'answer 4']);
      expect(store.listTurns(user.userId, session.sessionId, 2).map((t) => t.turnId)).toEqual([
        'turn-3',
        'turn-4',
      ]);
      expect(store.listSessions(user.userId)[0]!.updatedAt).toBe('2026-11-03T05:34:00.000Z');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // S2-T6
  it('stores created_at in UTC and keeps the timezone', () => {
    const store = new Store(':memory:');
    const user = store.getOrCreateUser('demo', 'Asia/Kolkata', at('2026-11-01T00:00:00Z'));
    const session = store.createSession(user.userId, at('2026-11-07T01:15:00+05:30'));
    store.addTurn({
      turnId: 'laptops',
      sessionId: session.sessionId,
      userId: user.userId,
      userMessage: 'Good laptop for local model work under $2,000?',
      assistantMessage: 'Three options.',
      createdAt: at('2026-11-07T01:15:00+05:30'),
      userTimezone: 'Asia/Kolkata',
    });
    const turn = store.listTurns(user.userId, session.sessionId)[0]!;
    expect(turn.createdAt).toBe('2026-11-06T19:45:00.000Z');
    expect(turn.userTimezone).toBe('Asia/Kolkata');
  });
});
