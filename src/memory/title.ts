// A short session title, made by the fast model after the first reply.
import { type ModelProvider, collectText } from '../llm/provider.ts';

const MAX_TITLE_CHARS = 60;

function tidy(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  const title = line.replace(/^["'“‘\s]+|["'”’.\s]+$/g, '');
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;
}

/** Never throws: if the model fails or says nothing, the title is the start of the message. */
export async function makeTitle(
  model: ModelProvider,
  prompt: string,
  userMessage: string,
): Promise<{ title: string; fromModel: boolean }> {
  try {
    const text = await collectText(
      model.stream({
        model: 'fast',
        system: prompt,
        messages: [{ role: 'user', content: userMessage.slice(0, 1000) }],
      }),
    );
    const title = tidy(text);
    if (title) return { title, fromModel: true };
  } catch (err) {
    console.error(`title call failed: ${err instanceof Error ? err.message : err}`);
  }
  return { title: tidy(userMessage), fromModel: false };
}
