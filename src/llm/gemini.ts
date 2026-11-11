import { createGoogle } from '@ai-sdk/google';
import { type ModelMessage, Output, streamText, tool } from 'ai';
import { z } from 'zod';
import type {
  AgentMessage,
  AssistantStepMessage,
  ModelProvider,
  StreamPart,
  StreamRequest,
  StreamResult,
} from './provider.ts';

export interface GeminiOptions {
  apiKey: string;
  modelMain: string;
  modelFast: string;
  /** How much the main model reasons before it writes. Lower is faster. The fast model always uses 'minimal'. */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
  /** Give up if the model has sent nothing after this long. Default 20 s. */
  firstTokenTimeoutMs?: number;
}

const queriesInput = z.object({
  queries: z.array(z.string()).min(1).describe('Search queries, each a few specific words.'),
});

function toSdkMessages(messages: AgentMessage[]): ModelMessage[] {
  return messages.flatMap((m): ModelMessage[] => {
    if (m.role === 'assistant_step') return m.raw as ModelMessage[];
    if (m.role === 'tool') {
      return [
        {
          role: 'tool',
          content: m.results.map((r) => ({
            type: 'tool-result' as const,
            toolCallId: r.id,
            toolName: r.name,
            output: { type: 'text' as const, value: r.output },
          })),
        },
      ];
    }
    return [{ role: m.role, content: m.content }];
  });
}

export class GeminiModel implements ModelProvider {
  private readonly google;

  constructor(private readonly options: GeminiOptions) {
    this.google = createGoogle({ apiKey: options.apiKey });
  }

  stream(request: StreamRequest): StreamResult {
    const id = request.model === 'main' ? this.options.modelMain : this.options.modelFast;
    const timeoutMs = this.options.firstTokenTimeoutMs ?? 20_000;

    // Some model ids accept the request and then send nothing. Without this the
    // user would wait forever with no error.
    const silence = new AbortController();
    const timer = setTimeout(() => silence.abort(), timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, silence.signal]) : silence.signal;

    // Tools have no execute function, so the SDK stops after one step and the
    // agent loop runs them.
    const tools = Object.fromEntries(
      (request.tools ?? []).map((t) => [t.name, tool({ description: t.description, inputSchema: queriesInput })]),
    );
    const hasTools = Object.keys(tools).length > 0;

    let failure: unknown;
    const result = streamText({
      model: this.google(id),
      instructions: request.system,
      messages: toSdkMessages(request.messages),
      ...(hasTools ? { tools, toolChoice: request.toolChoice ?? 'auto' } : {}),
      ...(request.json ? { output: Output.object({ schema: request.json as z.ZodType }) } : {}),
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingLevel: request.model === 'main' ? (this.options.thinkingLevel ?? 'low') : 'minimal',
          },
        },
      },
      abortSignal: signal,
      // The SDK leaves errors out of the stream; keep the first one to rethrow.
      onError: ({ error }) => {
        failure ??= error;
      },
    });

    async function* parts(): AsyncGenerator<StreamPart> {
      try {
        for await (const part of result.stream as AsyncIterable<any>) {
          if (part.type === 'text' || part.type === 'text-delta') {
            clearTimeout(timer);
            if (part.text) yield { type: 'text', text: part.text };
          } else if (part.type === 'tool-call') {
            clearTimeout(timer);
            yield { type: 'tool_call', id: part.toolCallId, name: part.toolName, input: part.input };
          } else if (part.type === 'error') {
            failure ??= part.error;
          }
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
    const step = Promise.resolve(result.responseMessages).then(
      (raw): AssistantStepMessage => ({ role: 'assistant_step', raw }),
    );
    step.catch(() => {}); // only read after a successful step
    return { parts: parts(), usage, step };
  }
}
