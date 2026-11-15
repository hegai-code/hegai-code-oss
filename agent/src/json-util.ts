/** Small readers for untyped JSON — what an app-server, a transcript line or a hook handed us. */

/** A plain object, or `undefined` for anything else (arrays and `null` included). */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A non-empty string, or `undefined`: an empty string is as good as a missing field. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** At most `max` characters, the last of them `…` when the text had to be cut. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
