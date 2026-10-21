/**
 * Normalization for quote verification: NFKC, lowercase, keep only letters and digits.
 * This drops whitespace, hyphens, soft hyphens, zero-width chars and punctuation,
 * so glued words from PDF extraction still match.
 */
export interface Normalized {
  text: string;
  /** map[i] = index in the original string of normalized char i */
  map: number[];
}

export function normalize(input: string): Normalized {
  let text = "";
  const map: number[] = [];
  let idx = 0;
  for (const ch of input) {
    const n = ch.normalize("NFKC").toLowerCase();
    for (const c of n) {
      if (/[\p{L}\p{N}]/u.test(c)) {
        text += c;
        map.push(idx);
      }
    }
    idx += ch.length;
  }
  return { text, map };
}

export const normText = (s: string) => normalize(s).text;
