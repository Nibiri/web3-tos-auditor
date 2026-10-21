import type { ParsedDoc } from "./parse.js";
import { verifyQuote } from "./verify.js";

const PLACEHOLDER = /\[[^\]\n]{2,80}\]|\bTBD\b|\[\s*[●_.…]+\s*\]|_{4,}/g;

/** R-30: unfilled fields such as [Operator name] or TBD. Pure code, no model. Returns verified quotes. */
export function findPlaceholders(doc: ParsedDoc): { text: string; location: string }[] {
  const found: { text: string; location: string }[] = [];
  const seen = new Set<string>();
  for (const s of doc.sections) {
    for (const para of s.text.split("\n\n")) {
      for (const m of para.matchAll(PLACEHOLDER)) {
        const frag = m[0];
        if (/https?:|www\.|^\[\d+\]$|^\[[a-z]\]$/i.test(frag)) continue; // links, footnotes
        if (seen.has(frag.toLowerCase())) continue;
        seen.add(frag.toLowerCase());
        // quote a window around the placeholder so verify_quote has enough text
        const at = m.index ?? 0;
        const win = para.slice(Math.max(0, at - 60), at + frag.length + 60).trim();
        const v = verifyQuote(doc, win);
        if (v.verified) found.push({ text: v.canonicalText!, location: v.location! });
        else found.push({ text: frag, location: s.title });
      }
    }
  }
  return found;
}
