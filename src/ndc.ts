/**
 * What an NDC (National Drug Code) looks like, in one place for the reader (`./label-read`), the
 * parser (`./medicine-label`) and the lookup (`./medicine-lookup`). Server-safe, no imports.
 */

/** The shapes an NDC is printed in: digits per segment. */
export const NDC_SHAPES = ['4-4-2', '5-3-2', '5-4-1', '5-4-2'];

/** A run of digits shorter than this is not an NDC's (ten or eleven digits), even half read. */
export const MIN_CODE_DIGITS = 8;

export const digitCount = (s: string) => (s.match(/\d/g) ?? []).length;

/** Whether a dashed code is in one of the NDC shapes ("59390-217-02"). */
export function isNdcShape(code: string): boolean {
  const parts = code.split('-');
  return parts.length === 3 && parts.every((p) => /^\d+$/.test(p)) && NDC_SHAPES.includes(parts.map((p) => p.length).join('-'));
}

const NDC_PREFIX = String.raw`(?:N\s?D\s?C|NOC|MDC|NDG|KDC|HDC|NBC)\s*(?:#|No\.?|number)?\s*[:#]?\s*`;
const DASH = String.raw`\s?[-‐‑–—_~]\s?`;

/**
 * The NDC on a label, as printed: 4-4-2, 5-3-2, 5-4-1 or 5-4-2 digits. Digits run together after
 * "NDC" are split by their count (5-5 as 5-3-2, 4-6 as 4-4-2, 11 as 5-4-2). Phone numbers (3-3-4),
 * Rx numbers and dates never match.
 */
export function findNdc(text: string): string | undefined {
  const t = text.replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, '0');
  const dashed = new RegExp(String.raw`(?<![\d-])(\d{4,5})${DASH}(\d{3,4})${DASH}(\d{1,2})(?![\d-])`, 'g');
  const candidates: { ndc: string; prefixed: boolean; maker?: boolean }[] = [];
  for (let m; (m = dashed.exec(t)); ) {
    const [a, b, c] = [m[1], m[2], m[3]];
    const shape = `${a.length}-${b.length}-${c.length}`;
    if (!NDC_SHAPES.includes(shape)) continue;
    const before = t.slice(Math.max(0, m.index - 24), m.index);
    const prefixed = new RegExp(`${NDC_PREFIX}$`, 'i').test(before);
    candidates.push({ ndc: `${a}-${b}-${c}`, prefixed, maker: prefixed && /\b(?:mfg|mfr|source|manufacturer'?s?)\b[\s.:]*\S*\s*$/i.test(before.replace(new RegExp(`${NDC_PREFIX}$`, 'i'), '')) });
  }
  const loose = new RegExp(String.raw`${NDC_PREFIX}(\d{4,5})${DASH}(\d{5,6})(?!\d)|${NDC_PREFIX}(\d{10,11})(?!\d)`, 'gi');
  for (let m; (m = loose.exec(t)); ) {
    if (m[1]) {
      const [a, rest] = [m[1], m[2]];
      if (a.length === 5 && rest.length === 5) candidates.push({ ndc: `${a}-${rest.slice(0, 3)}-${rest.slice(3)}`, prefixed: true });
      else if (a.length === 4 && rest.length === 6) candidates.push({ ndc: `${a}-${rest.slice(0, 4)}-${rest.slice(4)}`, prefixed: true });
      else if (a.length === 5 && rest.length === 6) candidates.push({ ndc: `${a}-${rest.slice(0, 4)}-${rest.slice(4)}`, prefixed: true });
    } else if (m[3].length === 11) {
      const d = m[3];
      candidates.push({ ndc: `${d.slice(0, 5)}-${d.slice(5, 9)}-${d.slice(9)}`, prefixed: true });
    }
  }
  // "MFG NDC" or "Source NDC" (the maker's code on a repackager's label) loses to the label's own.
  const own = candidates.filter((c) => c.prefixed && !c.maker);
  return (own[0] ?? candidates.find((c) => c.prefixed) ?? candidates[0])?.ndc;
}
