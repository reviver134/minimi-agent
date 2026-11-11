import { createGoogle } from '@ai-sdk/google';
import { streamText } from 'ai';
import type { ModelProvider, StreamRequest, StreamResult } from './provider.ts';

export interface GeminiOptions {
  apiKey: string;
  modelMain: string;
  modelFast: string;
  /** Give up if the model has sent nothing after this long. Default 20 s. */
  firstTokenTimeoutMs?: number;
}

export class GeminiModel implements ModelProvider {
  private readonly google;

  constructor(private readonly options: GeminiOptions) {
    this.google = createGoogle({ apiKey: options.apiKey });
  }

  streamText(request: StreamRequest): StreamResult {
    const id = request.model === 'main' ? this.options.modelMain : this.options.modelFast;
    const timeoutMs = this.options.firstTokenTimeoutMs ?? 20_000;

    // Some model ids accept the request and then send nothing. Without this the
    // user would wait forever with no error.
    const silence = new AbortController();
    const timer = setTimeout(() => silence.abort(), timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, silence.signal]) : silence.signal;

    let failure: unknown;
    const result = streamText({
      model: this.google(id),
      instructions: request.system,
      messages: request.messages,
      abortSignal: signal,
      // The SDK leaves errors out of textStream; keep the first one to rethrow.
      onError: ({ error }) => {
        failure ??= error;
      },
    });

    async function* text(): AsyncGenerator<string> {
      try {
        for await (const piece of result.textStream) {
          clearTimeout(timer);
          yield piece;
        }
      } finally {
        clearTimeout(timer);
      }
      if (silence.signal.aborted) {
        throw new Error(`model ${id} sent nothing within ${timeoutMs / 1000} s`);
      }
      if (failure !== undefined) throw failure;
    }

    const usage = Promise.resolve(result.usage).then(
      (u) => ({ tokensIn: u.inputTokens, tokensOut: u.outputTokens }),
      () => ({ tokensIn: undefined, tokensOut: undefined }),
    );
    return { textStream: text(), usage };
  }
}
