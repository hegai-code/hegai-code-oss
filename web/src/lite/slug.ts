/**
 * A project's folder name, from the sentence that asked for it.
 *
 * The light shell never asks «как назвать проект»: the first message creates
 * it. But a project here IS a directory (`projects.create`), and the agent's
 * rule for the name is `^[a-z0-9][a-z0-9._-]{0,63}$` — so the sentence has to
 * become one, deterministically and offline. No model is asked: a directory
 * cannot be cheaply renamed afterwards, so a clever name that takes a second
 * and can fail is worse than a plain one that is instant. What the person
 * reads as the task's name is the session title, which the runtime writes.
 */

/** The agent's rule, as `NewProjectPanel` states it. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const RU: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Words that say «do it» or glue a sentence together, and name nothing. */
const STOP = new Set(
  (
    'сделай сделать сделаем создай создать создадим напиши написать собери собрать построй построить ' +
    'реализуй реализовать добавь добавить разработай разработать придумай запили накидай ' +
    'нужно нужен нужна надо хочу хотим давай можешь пожалуйста мне нам мой моя моё наш наша ' +
    'для на в во с со и или по из к от это этот эту эта новый новую новое простой простую простое ' +
    'который которая которое чтобы как что а но же бы ли под над при про о об у за до ' +
    'make build create write add implement please a an the for to of in on with and or i we ' +
    'need want new simple me us my our that this it is let lets can you some'
  ).split(' '),
);

const MAX_WORDS = 3;
const MAX_LEN = 32;

function latin(word: string): string {
  let out = '';
  for (const ch of word) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) out += ch;
    else if (ch in RU) out += RU[ch];
    // Anything else — another script, an emoji, punctuation inside a token —
    // has no place in a directory name and is dropped rather than guessed at.
  }
  return out;
}

function dated(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `project-${p(now.getFullYear() % 100)}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

/** `Сделай лендинг для школы танцев` → `lending-shkoly-tantsev`. */
export function projectSlug(prompt: string, now: Date = new Date()): string {
  const words = prompt
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP.has(w))
    .map(latin)
    .filter((w) => w.length > 1)
    .slice(0, MAX_WORDS);
  let slug = '';
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    // Cut on a word, never through one — unless the very first word is too
    // long to fit at all.
    if (next.length > MAX_LEN) {
      if (!slug) slug = w.slice(0, MAX_LEN);
      break;
    }
    slug = next;
  }
  return NAME_RE.test(slug) ? slug : dated(now);
}

/**
 * `base`, or `base-2` … `base-9` — the first one no project on that machine
 * already answers to. `null` when all of them are taken: nine folders from the
 * same three words is a person to ask, not a tenth name to invent.
 */
export function uniqueSlug(base: string, taken: Iterable<string>): string | null {
  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());
  if (!used.has(base)) return base;
  for (let n = 2; n <= 9; n++) {
    const next = `${base}-${n}`;
    if (!used.has(next)) return next;
  }
  return null;
}
