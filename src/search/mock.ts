import type { SearchProvider, SearchResult } from './provider.ts';

export interface MockSearchOptions {
  /** Results for a query. Default: one result whose URL is made from the query. */
  results?: (query: string) => SearchResult[];
  /** How long each search takes, in milliseconds. A function can vary it by query. */
  delayMs?: number | ((query: string) => number);
  /** Queries that fail with an error. */
  failing?: (query: string) => boolean;
}

/** A scripted search for tests: no network, no key. Records every query. */
export class MockSearch implements SearchProvider {
  readonly queries: string[] = [];

  constructor(private readonly options: MockSearchOptions = {}) {}

  async search(query: string, signal: AbortSignal): Promise<SearchResult[]> {
    this.queries.push(query);
    const { delayMs = 0 } = this.options;
    const wait = typeof delayMs === 'function' ? delayMs(query) : delayMs;
    if (wait > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    }
    if (this.options.failing?.(query)) throw new Error('search provider is down');
    return (
      this.options.results?.(query) ?? [
        {
          title: `Result for ${query}`,
          url: `https://example.com/${encodeURIComponent(query)}`,
          content: `Facts about ${query}.`,
        },
      ]
    );
  }
}
