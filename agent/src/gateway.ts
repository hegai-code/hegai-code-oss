import { isExternal } from './edition.js';
import { isTrustedGateway, normalizeGatewayUrl } from './gateway-url.js';

export { isTrustedGateway };

/** The Hegai gateway: the default of the INTERNAL edition only. */
const INTERNAL_GATEWAY_URL = 'https://llm.acme.test/v1';

/**
 * The ONE gateway this machine trusts with credentials and internal jobs. The
 * machine owner names it in the agent's service environment
 * (`CC_REMOTE_GATEWAY_URL`) - never the hub (it never sends one) and never a
 * file a session could write (sessions run as the same user, so policy.json is
 * not a trust root for a credential's destination). Unset: the internal
 * edition uses the Hegai gateway, the external edition has none (empty string:
 * gateway-only sessions and the journal are refused). A configured value that
 * is not an acceptable URL (see normalizeGatewayUrl) counts as none, loudly.
 */
export function gatewayUrl(
  env: NodeJS.ProcessEnv = process.env,
  external: boolean = isExternal(),
): string {
  // Set but empty = gateway off, not the default.
  const fromEnv = env['CC_REMOTE_GATEWAY_URL'];
  if (fromEnv !== undefined) {
    const named = fromEnv.trim();
    const ok = named ? normalizeGatewayUrl(named) : undefined;
    if (named && !ok) console.error('[agent] CC_REMOTE_GATEWAY_URL must be https (http only on loopback) without credentials, query or fragment - gateway disabled');
    return ok ?? '';
  }
  return external ? '' : INTERNAL_GATEWAY_URL;
}

const NO_GATEWAY = 'No gateway is configured (set CC_REMOTE_GATEWAY_URL in the agent service environment of this machine).';

/** config/read must be resolved with the run's cwd (including project layers).
 * Return only the provider id; credentials and config never leave this process. */
export function gatewayProvider(config: Record<string, unknown> | undefined, trusted: string = gatewayUrl()): string {
  if (!trusted) throw new Error(NO_GATEWAY);
  const id = config?.['model_provider'];
  const providers = config?.['model_providers'] as Record<string, unknown> | undefined;
  const provider = typeof id === 'string' && providers?.[id];
  if (typeof id !== 'string' || !id || id === 'openai' || !provider || typeof provider !== 'object') {
    throw new Error('Internal job requires a configured gateway provider.');
  }
  const settings = provider as Record<string, unknown>;
  if (!isTrustedGateway(settings['base_url'], trusted) || settings['requires_openai_auth'] === true
      || settings['wire_api'] !== 'responses') {
    throw new Error('Internal job requires the configured Responses gateway without personal OpenAI authentication.');
  }
  return id;
}

/** No tools or subprocess: the journal only needs a bounded text completion. */
export async function journalCompletion(
  prompt: string,
  model?: string,
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): Promise<string> {
  const base = gatewayUrl(env);
  if (!base) throw new Error(NO_GATEWAY);
  const url = env['LLM_JOURNAL_URL']?.trim() || base;
  const key = env['LLM_JOURNAL_KEY']?.trim();
  if (!isTrustedGateway(url, base)) throw new Error('LLM_JOURNAL_URL must be the configured gateway.');
  if (!key) throw new Error('LLM_JOURNAL_KEY is required for consolidation.');
  let response: Response;
  try {
    response = await request(`${base}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(90_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || env['LLM_JOURNAL_MODEL']?.trim() || 'gpt-5.6-sol',
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: 6000,
        stream: false,
      }),
    });
  } catch {
    throw new Error('Journal gateway request failed or timed out.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Journal gateway returned HTTP ${response.status}.`);
  }
  // Bound even a misbehaving upstream; never print its body in an error.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Journal gateway returned no body.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 128_000) throw new Error('oversized');
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const choice = body?.choices?.[0];
    if (choice?.finish_reason !== 'stop' || choice?.message?.tool_calls?.length
        || choice?.message?.refusal || typeof choice?.message?.content !== 'string'
        || !choice.message.content.trim()) throw new Error('incomplete');
    return choice.message.content;
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error('Journal gateway returned an invalid, oversized or incomplete completion.');
  } finally {
    reader.releaseLock();
  }
}
