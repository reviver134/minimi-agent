import { describe, expect, it } from 'vitest';
import { describeDay, localDay, resolveDates, utcBounds } from '../src/temporal/dates.ts';

const TZ = 'Asia/Kolkata';
// The eval clock: Wednesday 11 November 2026, 10:00 in Kolkata.
const NOW = new Date('2026-11-11T10:00:00+05:30');

/** The candidates of the only date phrase in the message, as "from" or "from..to". */
function days(message: string, now = NOW, timezone = TZ): string[] {
  const mentions = resolveDates(message, now, timezone);
  expect(mentions, message).toHaveLength(1);
  return mentions[0]!.candidates.map((c) => (c.from === c.to ? c.from : `${c.from}..${c.to}`));
}

describe('date resolution', () => {
  // S4-T1
  it('resolves "on Monday" to the Monday just past', () => {
    expect(days('What did we talk about on Monday?')).toEqual(['2026-11-09']);
    expect(describeDay('2026-11-09')).toBe('Monday 9 November 2026');
  });

  // S4-T2
  it('resolves "3 November" to this year, not last or next', () => {
    expect(days('What did I ask you on 3 November?')).toEqual(['2026-11-03']);
    expect(days('what did I ask on Nov 3rd')).toEqual(['2026-11-03']);
    expect(days('what did I ask on the 3rd of November?')).toEqual(['2026-11-03']);
    expect(days('and on 3 November 2025?')).toEqual(['2025-11-03']);
  });

  // S4-T3
  it('offers both readings of "last Tuesday" when yesterday was a Tuesday', () => {
    expect(days('What did I ask you last Tuesday about Postgres?')).toEqual(['2026-11-10', '2026-11-03']);
    // On a Monday, "last Friday" can only be three days ago.
    expect(days('what did I ask last Friday?', new Date('2026-11-09T10:00:00+05:30'))).toEqual(['2026-11-06']);
  });

  // S4-T4
  it('resolves "3 November" on 2 January 2027 to 2026', () => {
    expect(days('What did I ask you on 3 November?', new Date('2027-01-02T10:00:00+05:30'))).toEqual(['2026-11-03']);
  });

  it('treats a date with no year as the most recent past one (E3)', () => {
    expect(days('What did I ask you on 25 December?')).toEqual(['2025-12-25']);
    expect(days('What did I ask you on 1 October?')).toEqual(['2026-10-01']);
    expect(days('What did I ask you on 11 November?')).toEqual(['2026-11-11']);
  });

  it('resolves relative days and ranges', () => {
    expect(days('what did I ask yesterday?')).toEqual(['2026-11-10']);
    expect(days('what did I ask the day before yesterday?')).toEqual(['2026-11-09']);
    expect(days('what did we cover today')).toEqual(['2026-11-11']);
    expect(days('what did I ask 3 days ago')).toEqual(['2026-11-08']);
    expect(days('what did I ask a week ago')).toEqual(['2026-11-04', '2026-11-02..2026-11-08']);
    expect(days('What have I asked you this month?')).toEqual(['2026-11-01..2026-11-11']);
    expect(days('Are those laptop prices from last week still right?')).toEqual(['2026-11-02..2026-11-08']);
    expect(days('what did we discuss this week')).toEqual(['2026-11-09..2026-11-11']);
    expect(days('what did I ask last month?')).toEqual(['2026-10-01..2026-10-31']);
    expect(days('what did I ask in the past 3 days')).toEqual(['2026-11-08..2026-11-11']);
    expect(days('what did I ask in October?')).toEqual(['2026-10-01..2026-10-31']);
    expect(days('what did I ask in December?')).toEqual(['2025-12-01..2025-12-31']);
    expect(days('on 2026-11-07 I asked about laptops')).toEqual(['2026-11-07']);
    // Said on a Wednesday, "Wednesday" is today or a week ago.
    expect(days('what did I ask on Wednesday')).toEqual(['2026-11-11', '2026-11-04']);
  });

  it('marks phrases about the future', () => {
    for (const message of ['What will I ask you next Tuesday?', 'what about tomorrow', 'on 25 December 2026', 'next week']) {
      const mentions = resolveDates(message, NOW, TZ);
      expect(mentions, message).toHaveLength(1);
      expect(mentions[0]!.future, message).toBe(true);
    }
    expect(days('What will I ask you next Tuesday?')).toEqual(['2026-11-17']);
  });

  it('finds several phrases in order and ignores words that only look like dates', () => {
    const mentions = resolveDates('What did I ask you on 3 November? Is your answer still correct today?', NOW, TZ);
    expect(mentions.map((m) => m.text)).toEqual(['3 November', 'today']);

    for (const message of [
      'The top 5 may change soon',
      'I sat in the sun and they wed; we may march on',
      'Explain what a database index is in two sentences.',
      'Compare the entry paid plans of Vercel, Netlify and Render.',
      'Shortlist 5 CRM tools for a 20-person sales team',
      'Is there a free tier for Supabase right now?',
    ]) {
      expect(resolveDates(message, NOW, TZ), message).toEqual([]);
    }
    expect(days('what did I ask on 5 May?')).toEqual(['2026-05-05']);
  });

  it('uses the user\'s calendar day, not the server\'s', () => {
    // 20:30 UTC on the 10th: already the 11th in Kolkata, still the 10th in New York.
    const instant = new Date('2026-11-10T20:30:00Z');
    expect(localDay(instant, 'Asia/Kolkata')).toBe('2026-11-11');
    expect(localDay(instant, 'America/New_York')).toBe('2026-11-10');
    expect(days('what did I ask yesterday?', instant, 'Asia/Kolkata')).toEqual(['2026-11-10']);
    expect(days('what did I ask yesterday?', instant, 'America/New_York')).toEqual(['2026-11-09']);
  });
});

describe('day boundaries', () => {
  it('turns a local day into UTC instants', () => {
    expect(utcBounds({ from: '2026-11-07', to: '2026-11-07' }, 'Asia/Kolkata')).toEqual({
      from: '2026-11-06T18:30:00.000Z',
      to: '2026-11-07T18:30:00.000Z',
    });
    expect(utcBounds({ from: '2026-11-03', to: '2026-11-09' }, 'UTC')).toEqual({
      from: '2026-11-03T00:00:00.000Z',
      to: '2026-11-10T00:00:00.000Z',
    });
  });

  it('handles days where the clocks change', () => {
    // New York: clocks go back on 1 November 2026 (a 25-hour day) and forward on 8 March 2026 (23 hours).
    expect(utcBounds({ from: '2026-11-01', to: '2026-11-01' }, 'America/New_York')).toEqual({
      from: '2026-11-01T04:00:00.000Z',
      to: '2026-11-02T05:00:00.000Z',
    });
    expect(utcBounds({ from: '2026-03-08', to: '2026-03-08' }, 'America/New_York')).toEqual({
      from: '2026-03-08T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
    });
  });
});
