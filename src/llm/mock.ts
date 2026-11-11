import type { ModelProvider, StreamPart, StreamRequest, StreamResult } from './provider.ts';

export interface MockScript {
  /** Text pieces to stream, in order. */
  chunks?: string[];
  /** Wait before each piece, in milliseconds. */
  delayMs?: number;
  /** Throw this after the pieces have been sent. */
  failWith?: Error;
  /**
   * Searches to ask for instead of answering. Like a real model, the mock only
   * calls a tool it was offered, and answers with chunks when toolChoice is 'none'.
   */
  searches?: string[][];
}

export interface MockModelOptions extends MockScript {
  /** What the 'fast' model does. Defaults to a one-piece reply with no delay. */
  fast?: MockScript;
  /** Decides each 'main' step from the request; n counts main steps from 0. Overrides the fixed script. */
  respond?: (request: StreamRequest, n: number) => MockScript;
}

/** A scripted model for tests: no network, no key. Records every request. */
export class MockModel implements ModelProvider {
  readonly requests: StreamRequest[] = [];
  private mainSteps = 0;

  constructor(private readonly options: MockModelOptions = {}) {}

  stream(request: StreamRequest): StreamResult {
    this.requests.push(request);
    const script: MockScript =
      request.model === 'fast'
        ? { chunks: ['Mock title'], ...this.options.fast }
        : (this.options.respond?.(request, this.mainSteps++) ?? this.options);
    const { chunks = ['Hello', ' from', ' the', ' mock', ' model.'], delayMs = 0, failWith } = script;
    const canCall = (request.tools?.length ?? 0) > 0 && request.toolChoice !== 'none';
    const searches = canCall ? (script.searches ?? []) : [];
    const calls = searches.map((queries, i) => ({
      id: `call-${this.requests.length}-${i}`,
      name: request.tools![0]!.name,
      input: { queries },
    }));

    async function* parts(): AsyncGenerator<StreamPart> {
      if (calls.length > 0) {
        for (const call of calls) yield { type: 'tool_call', ...call };
        return;
      }
      for (const chunk of chunks) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        if (request.signal?.aborted) return;
        yield { type: 'text', text: chunk };
      }
      if (failWith) throw failWith;
    }

    const tokensIn = JSON.stringify(request.messages).length;
    return {
      parts: parts(),
      usage: Promise.resolve({ tokensIn, tokensOut: chunks.join('').length }),
      step: Promise.resolve({ role: 'assistant_step', raw: calls }),
    };
  }
}
