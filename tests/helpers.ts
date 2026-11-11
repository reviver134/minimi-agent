import type { ModelProvider } from '../src/llm/provider.ts';
import { Store } from '../src/memory/store.ts';
import { MockSearch } from '../src/search/mock.ts';
import type { SearchProvider } from '../src/search/provider.ts';
import { createApp } from '../src/server/app.ts';
import { type Clock, systemClock } from '../src/temporal/clock.ts';

export interface SseEvent {
  event: string;
  data: any;
  atMs: number;
}

export const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** An app on an in-memory database with the mock model given. */
export function setup(
  model: ModelProvider,
  clock: Clock = systemClock,
  search: SearchProvider = new MockSearch(),
) {
  const store = new Store(':memory:');
  const app = createApp({
    model,
    search,
    store,
    clock,
    systemPrompt: 'You are a test.',
    titlePrompt: 'Write a title.',
  });
  const signIn = async (name: string, timezone = 'Asia/Kolkata') => {
    const response = await app.request('/api/users', json({ name, timezone }));
    return (await response.json()) as { user_id: string; user_name: string; timezone: string };
  };
  const chat = (body: unknown) => app.request('/api/chat', json(body));
  return { app, store, signIn, chat };
}

/** Reads the event stream, noting when each event arrived. */
export async function readEvents(
  response: Response,
  onEvent?: (event: SseEvent) => void,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const t0 = performance.now();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const name = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!data) continue;
      const event = { event: name, data: JSON.parse(data), atMs: performance.now() - t0 };
      events.push(event);
      onEvent?.(event);
    }
  }
  return events;
}
