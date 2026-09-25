import Anthropic from '@anthropic-ai/sdk';

// Pay-per-use backup, used only when the subscriptions are out of quota (and under the owner's
// monthly cap). Prices are USD per million tokens.
export const API_MODELS = {
  strong: { id: 'claude-opus-5', input: 5, output: 25, search: 'web_search_20260209' },
  worker: { id: 'claude-sonnet-5', input: 2, output: 10, search: 'web_search_20260209' },
  bulk: { id: 'claude-haiku-4-5', input: 1, output: 5, search: 'web_search_20250305' },
};

const costOf = (m, usage) => ((usage?.input_tokens ?? 0) * m.input + (usage?.output_tokens ?? 0) * m.output) / 1_000_000;

export async function runAnthropicApi({ apiKey, prompt, system, grade, web, signal }) {
  const m = API_MODELS[grade] ?? API_MODELS.worker;
  const client = new Anthropic({ apiKey, maxRetries: 1 });
  const messages = [{ role: 'user', content: prompt }];
  const tools = web ? [{ type: m.search, name: 'web_search', max_uses: 5 }] : undefined;
  let cost = 0;
  let text = '';

  try {
    // Server-side web search can pause a long turn; continue it a few times.
    for (let turn = 0; turn < 4; turn++) {
      const params = { model: m.id, max_tokens: 16000, system, messages, ...(tools ? { tools } : {}) };
      // Opus 5 may decline some requests; server-side fallbacks retry them on another model.
      const response =
        m.id === 'claude-opus-5'
          ? await client.beta.messages.create(
              { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
              { signal },
            )
          : await client.messages.create(params, { signal });
      cost += costOf(m, response.usage);
      if (response.stop_reason === 'refusal') {
        return { ok: false, text: '', costUsd: cost, limited: false, error: 'The model declined this request.' };
      }
      text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (response.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: response.content });
    }
    return { ok: Boolean(text.trim()), text, costUsd: cost, limited: false, model: m.id, error: text.trim() ? '' : 'Empty answer' };
  } catch (err) {
    if (signal?.aborted) return { ok: false, aborted: true, text: '', costUsd: cost, error: 'Cancelled' };
    if (err instanceof Anthropic.RateLimitError) {
      return { ok: false, limited: true, resetAt: null, text: '', costUsd: cost, error: 'API rate limit reached' };
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return { ok: false, limited: false, text: '', costUsd: cost, error: 'The Anthropic API key was rejected. Check it in Settings.' };
    }
    if (err instanceof Anthropic.APIError) {
      return { ok: false, limited: err.status === 529, text: '', costUsd: cost, error: `API error ${err.status}: ${err.message}` };
    }
    return { ok: false, limited: false, text: '', costUsd: cost, error: `Could not reach the Anthropic API: ${err.message}` };
  }
}
