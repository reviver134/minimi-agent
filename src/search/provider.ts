// Web search sits behind this interface so tests run offline with MockSearch.

export interface SearchResult {
  title: string;
  url: string;
  /** Text from the page that matches the query. Written by strangers: data, not instructions. */
  content: string;
  /** When the page was published, if the provider knows. */
  publishedAt?: string;
}

export interface SearchProvider {
  /** Runs one query. Rejects on failure; must stop when signal aborts. */
  search(query: string, signal: AbortSignal): Promise<SearchResult[]>;
}
