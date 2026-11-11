// The model sits behind this interface so tests run offline with MockModel.
// One call to stream() is one model step: it yields text and, if tools were
// offered, tool calls. The agent loop (src/agent/loop.ts) decides what happens next.

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** The assistant's own step, handed back unchanged so provider details (such as Gemini's thought signatures) survive. */
export interface AssistantStepMessage {
  role: 'assistant_step';
  raw: unknown[];
}

export interface ToolResultsMessage {
  role: 'tool';
  results: { id: string; name: string; output: string }[];
}

export type AgentMessage = ChatMessage | AssistantStepMessage | ToolResultsMessage;

export interface ToolSpec {
  name: string;
  description: string;
}

export interface StreamRequest {
  /** 'main' writes answers; 'fast' is for small helper calls. */
  model: 'main' | 'fast';
  system: string;
  messages: AgentMessage[];
  /** Tools the model knows about. Each takes {queries: string[]}. */
  tools?: ToolSpec[];
  /** Make the reply JSON that fits this zod schema. The caller still parses and checks it. */
  json?: unknown;
  /** 'none' keeps the tools declared but makes the model answer in text. Default 'auto'. */
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
}

export type StreamPart = { type: 'text'; text: string } | ({ type: 'tool_call' } & ToolCall);

export interface Usage {
  tokensIn: number | undefined;
  tokensOut: number | undefined;
}

export interface StreamResult {
  /** Text pieces and tool calls, in order. Throws if the model call fails. */
  parts: AsyncIterable<StreamPart>;
  /** Resolves once parts has been read to the end. */
  usage: Promise<Usage>;
  /** This step as a message for the next request. Read after parts has ended. */
  step: Promise<AssistantStepMessage>;
}

export interface ModelProvider {
  stream(request: StreamRequest): StreamResult;
}

/** Reads a whole reply as text, for helper calls that use no tools. */
export async function collectText(result: StreamResult): Promise<string> {
  let text = '';
  for await (const part of result.parts) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}
