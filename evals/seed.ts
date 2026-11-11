// The history the evals run against (evals/questions.md, "Seeded history").
// User `demo`, timezone Asia/Kolkata. Times are the user's local time.
// The stored answers are what the agent "said then": plausible figures made
// for the evals, not checked facts.
import type { Source } from '../src/agent/webSearch.ts';
import type { Store } from '../src/memory/store.ts';

export const SEED_USER = { name: 'demo', timezone: 'Asia/Kolkata' };

interface SeedTurn {
  turnId: string;
  session: string;
  /** Local time in Asia/Kolkata, with its offset. */
  at: string;
  question: string;
  answer: string;
  sources?: Omit<Source, 'n'>[];
}

export const SEED_TURNS: SeedTurn[] = [
  {
    turnId: 'seed-postgres',
    session: 'Postgres hosting',
    at: '2026-11-03T11:00:00+05:30',
    question: 'Compare managed Postgres hosting for a small SaaS',
    answer: [
      'For a small SaaS, three managed Postgres hosts stand out. Prices are the entry paid plans as of 3 November 2026.',
      '',
      '| Provider | Entry paid plan | Price | Notes |',
      '|---|---|---|---|',
      '| Neon | Launch | $19/month [1] | Serverless, scales to zero, branching |',
      '| Supabase | Pro | $25/month [2] | Postgres plus auth, storage and realtime |',
      '| Render | Basic-1gb | $19/month [3] | Plain managed Postgres next to your web service |',
      '',
      'Pick Neon if you want the lowest idle cost, Supabase if you also need auth and storage, and Render if your app already runs there.',
    ].join('\n'),
    sources: [
      { url: 'https://neon.com/pricing', title: 'Neon pricing' },
      { url: 'https://supabase.com/pricing', title: 'Supabase pricing' },
      { url: 'https://render.com/pricing', title: 'Render pricing' },
    ],
  },
  {
    turnId: 'seed-test-runners',
    session: 'Test runners',
    at: '2026-11-03T16:30:00+05:30',
    question: 'Which test runner should I use for a new Node project?',
    answer: [
      'Use Vitest for a new Node project: it is fast, runs TypeScript and ES modules without setup, and its API matches Jest.',
      '',
      'Two alternatives:',
      '- Jest: the largest ecosystem, a good choice if your team already knows it, but slower and it needs configuration for ES modules.',
      '- The built-in node:test runner: no dependency at all, enough for small libraries, with fewer features for mocking and watch mode.',
    ].join('\n'),
  },
  {
    turnId: 'seed-laptops',
    session: 'Laptops',
    at: '2026-11-07T01:15:00+05:30',
    question: 'Good laptop for local model work under $2,000?',
    answer: [
      'Three laptops under $2,000 that suit running local models, with prices as of 7 November 2026:',
      '',
      '| Laptop | Price | Why |',
      '|---|---|---|',
      '| Apple MacBook Air 15-inch (M4, 24 GB) | $1,599 [1] | Unified memory lets mid-size models run on the GPU; silent |',
      '| Lenovo Legion 5i (RTX 5060, 32 GB) | $1,449 [2] | 8 GB of dedicated video memory, best for CUDA tools |',
      '| ASUS Zenbook 14 OLED (Core Ultra 7, 32 GB) | $1,199 [3] | Lightest and cheapest; fine for small models on the CPU |',
      '',
      'For most local model work the MacBook Air is the easiest choice; choose the Legion if you need CUDA.',
    ].join('\n'),
    sources: [
      { url: 'https://www.apple.com/shop/buy-mac/macbook-air', title: 'Buy MacBook Air' },
      { url: 'https://www.lenovo.com/us/en/legion/', title: 'Lenovo Legion laptops' },
      { url: 'https://www.asus.com/laptops/for-home/zenbook/', title: 'ASUS Zenbook' },
    ],
  },
  {
    turnId: 'seed-crm',
    session: 'CRM shortlist',
    at: '2026-11-09T14:00:00+05:30',
    question: 'Shortlist 5 CRM tools for a 20-person sales team',
    answer: [
      'Five CRM tools that fit a 20-person sales team. Prices are per seat per month on annual billing, as of 9 November 2026.',
      '',
      '| CRM | Plan | Price per seat | Best for |',
      '|---|---|---|---|',
      '| HubSpot Sales Hub | Starter | $20 [1] | Teams that also want marketing tools |',
      '| Pipedrive | Growth | $39 [2] | Pipeline-first selling, quick to learn |',
      '| Zoho CRM | Professional | $23 [3] | Lowest cost with wide features |',
      '| Salesforce | Starter Suite | $25 [4] | Room to grow into a larger setup |',
      '| Close | Growth | $99 [5] | Teams that sell mostly by phone and email |',
      '',
      'Start trials with Pipedrive and Zoho CRM: they are the quickest to set up for 20 people.',
    ].join('\n'),
    sources: [
      { url: 'https://www.hubspot.com/pricing/sales', title: 'HubSpot Sales Hub pricing' },
      { url: 'https://www.pipedrive.com/en/pricing', title: 'Pipedrive pricing' },
      { url: 'https://www.zoho.com/crm/zohocrm-pricing.html', title: 'Zoho CRM pricing' },
      { url: 'https://www.salesforce.com/sales/pricing/', title: 'Salesforce Sales pricing' },
      { url: 'https://www.close.com/pricing', title: 'Close pricing' },
    ],
  },
  {
    turnId: 'seed-preference',
    session: 'CRM shortlist',
    at: '2026-11-09T14:20:00+05:30',
    question: 'Keep answers short and use tables for comparisons',
    answer: 'Understood. I will keep answers short and use tables when I compare things.',
  },
];

/** Loads the eval history for `demo`. Does nothing if it is already there. Returns how many turns were added. */
export function seedDemo(store: Store): { userId: string; added: number } {
  const first = new Date(SEED_TURNS[0]!.at);
  const user = store.getOrCreateUser(SEED_USER.name, SEED_USER.timezone, first);
  if (store.hasTurn(SEED_TURNS[0]!.turnId)) return { userId: user.userId, added: 0 };

  const sessions = new Map<string, string>();
  for (const turn of SEED_TURNS) {
    const at = new Date(turn.at);
    let sessionId = sessions.get(turn.session);
    if (!sessionId) {
      sessionId = store.createSession(user.userId, at, turn.session).sessionId;
      sessions.set(turn.session, sessionId);
    }
    store.addTurn(
      {
        turnId: turn.turnId,
        sessionId,
        userId: user.userId,
        userMessage: turn.question,
        assistantMessage: turn.answer,
        createdAt: at,
        userTimezone: SEED_USER.timezone,
      },
      (turn.sources ?? []).map((s, i) => ({ n: i + 1, ...s })),
    );
  }
  return { userId: user.userId, added: SEED_TURNS.length };
}
