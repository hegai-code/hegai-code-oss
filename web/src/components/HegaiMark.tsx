/**
 * Hegai "flash" mark (brand book v2): eight rounded rays radiating from an
 * EMPTY center — the emptiness is what separates the mark from generic star
 * glyphs. Rays alternate long/short every 45°; two-color (clay long / amber
 * short) by default, or single-color via `mono` — the brand mandates mono at
 * 24px and below. Geometry follows the spec: empty center Ø 0.18, ray width
 * 0.11, long 0.42 / short 0.29 of the mark size (viewBox 102 = 2·(9+42)).
 */
export function HegaiMark({ size = 24, mono }: { size?: number; mono?: string }) {
  const rays = [];
  for (let i = 0; i < 8; i++) {
    const long = i % 2 === 0;
    rays.push(
      <rect
        key={i}
        x={-5.5}
        y={9}
        width={11}
        height={long ? 42 : 29}
        rx={5.5}
        fill={mono ?? (long ? 'var(--action)' : 'var(--orange)')}
        transform={`rotate(${i * 45})`}
      />,
    );
  }
  return (
    <svg width={size} height={size} viewBox="-51 -51 102 102" aria-hidden focusable="false">
      {rays}
    </svg>
  );
}
