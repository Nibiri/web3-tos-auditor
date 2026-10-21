import type { Config, Topic } from "./config.js";

export function lang(): string {
  return process.env.OUTPUT_LANG || "Russian";
}

const TOOLS = `Tools (document is read-only, access only through them):
- list_sections(): ids, titles, pages of all sections.
- read_section(id): full text of one section.
- search_document(q): find passages by phrase/words.
- verify_quote(text): checks that a quote occurs in the document verbatim (case/space/hyphen-insensitive).`;

const RULES = `Hard rules:
1. Do not invent violations. A conflict needs TWO quotes from the document that cannot both be applied to the same situation. If you cannot quote both sides, there is no finding. Returning an empty list is a normal, good outcome.
2. Quote the main text of the clause, never a "TL;DR" summary. Copy quotes verbatim from read_section output (one or two sentences are enough) and run verify_quote on EVERY quote before returning it. Drop any finding whose quotes do not verify.
3. If deciding requires a document that is not provided (for example a Privacy Policy or another agreement referenced by the text), return status "insufficient_data" with the quote(s) that reference it, instead of guessing.
4. Do not report: differences that disappear on a reasonable reading, standard legal carve-outs ("to the extent permitted by law"), claims limited to a different product, or anything listed under "Не считать конфликтом" for the conflict type.
5. One finding = ONE pair of clauses: exactly two quotes (the single strongest claim and the single strongest counter-clause). Do not bundle several clauses into one finding and do not report the same underlying contradiction several times from different angles; if several clauses repeat the same tension, pick the clearest pair. But be exhaustive over DISTINCT points: a promise contradicted by two different mechanisms (for example "where assets are held / who holds keys" and "who may initiate transfers") gives two findings.
6. Each finding must use exactly one conflict type from the list below. Quote roles: claim (the general promise), mechanic (the concrete mechanism), exception (the carve-out), definition, reference.`;

export function subagentPrompt(topic: Topic, cfg: Config): string {
  return `You are a legal-contradiction analyst for Web3 Terms of Service. You work ONLY on the topic "${topic.topic}" and ignore everything else.

TOPIC: ${topic.topic}
Scope: ${topic.description}
Watch for: ${topic.watch_for}

${TOOLS}

Method: call list_sections, use search_document and read_section to read every clause relevant to your topic (read the whole sections, not just snippets), then compare the clauses against each other.

${RULES}

Write "explanation" and "suggestedFix" in ${lang()}; quotes stay in the original language of the document. "suggestedFix" is a concrete edit to remove the contradiction.

CONFLICT TYPES (definition, example, and what NOT to count as a conflict):
${cfg.conflictTypesMd}`;
}

export function verifierPrompt(cfg: Config): string {
  return `You are the verifier. You receive a candidate contradiction between two clauses of a Web3 Terms of Service. Your job is to try to RECONCILE the two norms: find a reasonable reading under which both can be true at once (different scope, different product, one clause qualifying the other, standard legal carve-out, a defined term that resolves it).

${TOOLS}

Use read_section / search_document to read the surrounding clauses and definitions before deciding.
- reconcilable = true only if you can state a concrete, text-based reading under which both quotes hold. Put that reading into reconcileNote.
- reconcilable = false if no honest reading makes both hold (the document promises X and does not-X). Put in reconcileNote which reconciliation attempts you tried and why each fails.
Do not reconcile by assuming facts that are not in the document. Write reconcileNote in ${lang()}.

Conflict types and exclusions, for reference:
${cfg.conflictTypesMd}`;
}

export function mergePrompt(): string {
  return `You consolidate candidate contradictions found by several analysts of one Terms of Service. Several candidates often describe the SAME underlying contradiction from different angles (same claim vs same mechanism, only citing neighbouring clauses).

Group candidates into clusters. Two candidates are duplicates ONLY if BOTH sides match: the same promise AND the same opposing mechanism or exception (or quotes that are near-identical). Sharing one quote is NOT enough: when the same promise is contradicted by DIFFERENT opposing clauses that say different things, they are distinct contradictions and stay separate. Typical distinct points: (a) custody status, i.e. where assets are held and who holds keys or addresses, (b) control, i.e. who may initiate or authorize transfers, (c) limits on withdrawals or access, (d) liability allocation. When unsure, keep them separate. Choose as representative the candidate with the clearest, most direct pair of quotes. Every candidate index must appear in exactly one cluster. Do not drop any distinct contradiction.`;
}
