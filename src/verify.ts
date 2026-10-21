import { normalize, normText } from "./normalize.js";
import type { ParsedDoc, Section } from "./parse.js";

export interface VerifyResult {
  verified: boolean;
  reason?: string;
  sectionId?: string;
  location?: string;
  /** Exact text from the document that matched (original spelling). */
  canonicalText?: string;
}

const MIN_NORM_CHARS = 25;
const TLDR = /^\s*tl;?\s*dr\b/i;

function locationOf(s: Section, paragraph: string): string {
  const clause = paragraph.match(/^(\d+(?:\.\d+)+)/);
  const parts = [s.title];
  if (s.page) parts.push(`p.${s.page}`);
  if (clause) parts.push(`cl. ${clause[1]}`);
  return parts.join(", ");
}

/** Normalized comparison of a quote against the whole document. Pure function, no model involved. */
export function verifyQuote(doc: ParsedDoc, quote: string): VerifyResult {
  const q = normText(quote);
  if (q.length < MIN_NORM_CHARS) return { verified: false, reason: "quote too short (min ~25 letters)" };
  let tldrHit = false;
  for (const s of doc.sections) {
    const n = normalize(s.text);
    let from = 0;
    for (;;) {
      const at = n.text.indexOf(q, from);
      if (at < 0) break;
      from = at + 1;
      const startOrig = n.map[at];
      const endOrig = n.map[at + q.length - 1] + 1;
      const paraStart = s.text.lastIndexOf("\n\n", startOrig) + 2 > 1 ? s.text.lastIndexOf("\n\n", startOrig) + 2 : 0;
      const paragraph = s.text.slice(Math.max(paraStart, 0));
      if (TLDR.test(paragraph)) { tldrHit = true; continue; }
      return {
        verified: true,
        sectionId: s.id,
        location: locationOf(s, paragraph),
        canonicalText: s.text.slice(startOrig, endOrig).replace(/\s+/g, " "),
      };
    }
  }
  return { verified: false, reason: tldrHit ? "quote is from a TL;DR summary, cite the main clause" : "quote not found in document" };
}
