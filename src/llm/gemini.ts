import { createGoogle } from '@ai-sdk/google';
import { streamText } from 'ai';
import type { ModelProvider, StreamRequest, StreamResult } from './provider.ts';

export interface GeminiOptions {
  apiKey: string;
  modelMain: string;
  modelFast: string;
}

export class GeminiModel implements ModelProvider {
  private readonly google;

  constructor(private readonly options: GeminiOptions) {
    this.google = createGoogle({ apiKey: options.apiKey });
  }

  streamText(request: StreamRequest): StreamResult {
    const id = request.model === 'main' ? this.options.modelMain : this.options.modelFast;
    let failure: unknown;
    const result = streamText({
      model: this.google(id),
      instructions: request.system,
      messages: request.messages,
      abortSignal: request.signal,
      // The SDK leaves errors out of textStream; keep the first one to rethrow.
      onError: ({ error }) => {
        failure ??= error;
      },
    });

    async function* text(): AsyncGenerator<string> {
      for await (const piece of result.textStream) yield piece;
      if (failure !== undefined) throw failure;
    }

    const usage = Promise.resolve(result.usage).then(
      (u) => ({ tokensIn: u.inputTokens, tokensOut: u.outputTokens }),
      () => ({ tokensIn: undefined, tokensOut: undefined }),
    );
    return { textStream: text(), usage };
  }
}
