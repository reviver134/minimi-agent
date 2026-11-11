import type { ModelProvider, StreamRequest, StreamResult } from './provider.ts';

export interface MockModelOptions {
  /** Text pieces to stream, in order. */
  chunks?: string[];
  /** Wait before each piece, in milliseconds. */
  delayMs?: number;
  /** Throw this after the pieces have been sent. */
  failWith?: Error;
}

/** A scripted model for tests: no network, no key. Records every request. */
export class MockModel implements ModelProvider {
  readonly requests: StreamRequest[] = [];

  constructor(private readonly options: MockModelOptions = {}) {}

  streamText(request: StreamRequest): StreamResult {
    this.requests.push(request);
    const { chunks = ['Hello', ' from', ' the', ' mock', ' model.'], delayMs = 0, failWith } =
      this.options;

    async function* text(): AsyncGenerator<string> {
      for (const chunk of chunks) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        if (request.signal?.aborted) return;
        yield chunk;
      }
      if (failWith) throw failWith;
    }

    const tokensIn = request.messages.reduce((n, m) => n + m.content.length, 0);
    return {
      textStream: text(),
      usage: Promise.resolve({ tokensIn, tokensOut: chunks.join('').length }),
    };
  }
}
