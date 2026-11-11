// The model sits behind this interface so tests run offline with MockModel.

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamRequest {
  /** 'main' writes answers; 'fast' is for small helper calls. */
  model: 'main' | 'fast';
  system: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export interface Usage {
  tokensIn: number | undefined;
  tokensOut: number | undefined;
}

export interface StreamResult {
  /** Text pieces in order. Throws if the model call fails. */
  textStream: AsyncIterable<string>;
  /** Resolves once textStream has been read to the end. */
  usage: Promise<Usage>;
}

export interface ModelProvider {
  streamText(request: StreamRequest): StreamResult;
}
