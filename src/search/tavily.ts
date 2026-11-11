// Tavily search (https://docs.tavily.com). Checked against the live API on 2026-11-11:
// "basic" depth answers in about 1.8 s and returns page snippets with dates.
import type { SearchProvider, SearchResult } from './provider.ts';

const ENDPOINT = 'https://api.tavily.com/search';

export interface TavilyOptions {
  apiKey: string;
  maxResults?: number;
}

export class TavilySearch implements SearchProvider {
  constructor(private readonly options: TavilyOptions) {}

  async search(query: string, signal: AbortSignal): Promise<SearchResult[]> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: this.options.maxResults ?? 5,
        include_published_date: true,
      }),
    });
    const body: any = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = body?.detail?.error ?? body?.detail?.[0]?.msg ?? response.statusText;
      throw new Error(`Tavily answered ${response.status}: ${String(detail).slice(0, 200)}`);
    }
    const results: any[] = Array.isArray(body?.results) ? body.results : [];
    return results
      .filter((r) => typeof r?.url === 'string' && typeof r?.content === 'string')
      .map((r) => ({
        title: typeof r.title === 'string' ? r.title : r.url,
        url: r.url,
        content: r.content,
        ...(typeof r.published_date === 'string' ? { publishedAt: r.published_date } : {}),
      }));
  }
}
