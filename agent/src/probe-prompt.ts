/**
 * A prompt a script or an agent sent to check that something works — not
 * work anyone comes back to. Matched ANYWHERE in the FIRST prompt, not at the
 * start of the title: «Проверка выбора модели после правки. Ответь одним
 * словом: ок» got the AI title «Проверка выбора модели», and the clients'
 * title rule (`isProbeTitle`, anchored at the start) let five of them into
 * the crm shelf (07.10.2026). Machine markers only — the same list as the
 * clients', none of them something a person opens a real chat with.
 */
const PROBE_PROMPT =
  /(echo probe|Ответь (только )?одним словом|reply with (the |a |one )?single word|Run exactly this bash command|Оцени каждую сессию ниже по рубрике)/i;

export function isProbePrompt(prompt?: string): boolean {
  return !!prompt && PROBE_PROMPT.test(prompt.slice(0, 2000));
}
