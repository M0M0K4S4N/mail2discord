import type { Ai } from '@cloudflare/workers-types';

export async function summarizedByWorkerAI(ai: Ai, model: string, prompt: string): Promise<string> {
  const res = await ai.run(model as never, {
    messages: [
      { role: 'system', content: 'You are a helpful assistant that summarizes emails concisely.' },
      { role: 'user', content: prompt },
    ],
  } as never);
  const text = (res as { response?: string }).response;
  if (typeof text !== 'string') {
    throw new Error('Empty Workers AI response');
  }
  return text.trim();
}

export async function summarizedByOpenAI(
  apiKey: string,
  completionsApi: string,
  model: string,
  prompt: string,
): Promise<string> {
  const res = await fetch(completionsApi, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant that summarizes emails concisely.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('Empty OpenAI response');
  }
  return text.trim();
}
