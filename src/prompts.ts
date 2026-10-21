import type { Agent, Config, JurisdictionRule, Risk } from "./config.js";
import type { Profile } from "./schema.js";

export function lang(): string {
  return process.env.OUTPUT_LANG || "Russian";
}

const TOOLS = `Tools (the document is read-only and reachable only through them):
- list_sections(): ids, titles, pages of all sections.
- read_section(id): full text of one section.
- search_document(q): find passages by phrase or words.
- verify_quote(text): checks that a quote occurs in the document verbatim.`;

export function profilePrompt(): string {
  return `You classify a Web3 Terms of Service before it is checked. ${TOOLS}
Skim the document with list_sections / search_document / read_section and answer:
- tags: "custodial" if the operator holds or controls user assets or keys, or the text says so, or the mechanics show it (pooled or operational wallets, keys held by the operator), even if the text claims otherwise; "yield" if the product offers yield, rewards, staking, liquidity strategies or asset management. Both, one or none.
- projectType: one short phrase (for example "DEX interface", "custodial wallet bot", "yield platform").
- jurisdiction: governing law and operator's place if stated, else "unknown".
- jurisdictions: which of RU, EU/EEA, UK, US the document connects to (governing law, operator, targeted users, referenced statutes). Empty if none.
- operator: operator name or "not stated".
Do not guess beyond the text. Reply with JSON only. Write projectType in ${lang()}.`;
}

const riskBlock = (r: Risk, hints: JurisdictionRule[]) =>
  `[${r.id}] check_type=${r.check_type} | risk: ${r.risk}
  question: ${r.prompt}
  if risk found, fix: ${r.output_if_found}` +
  (hints.length
    ? `\n  jurisdiction hints (DRAFT, not verified by a lawyer, use as a lens only, never as a legal conclusion): ` +
      hints.map((h) => `[${h.jurisdiction}] ${h.note} (${h.source})`).join(" | ")
    : "");

export function agentPrompt(agent: Agent, risks: Risk[], profile: Profile, cfg: Config): string {
  const hints = (id: string) =>
    cfg.jurisdictionRules.filter((j) => j.risk_id === id && (j.jurisdiction === "ANY" || profile.jurisdictions.includes(j.jurisdiction as never)));
  const needsConflict = risks.some((r) => r.check_type === "conflict");
  return `You are a legal analyst checking a Web3 Terms of Service against a list of risks. Your area: "${agent.topic}". ${agent.description}
Project profile: type = ${profile.projectType}; tags = [${profile.tags.join(", ") || "none"}]; jurisdiction = ${profile.jurisdiction}; operator = ${profile.operator}.
Take Web3 specifics, the project type and the applicable jurisdiction into account where they are known.
${agent.watch_for ? `Hints: ${agent.watch_for}\n` : ""}
${TOOLS}

For EVERY risk below, do this:
1. Check whether the relevant provision exists, judged by its meaning, not by its heading or numbering.
2. Give an exact quote from the main text of the clause (never a TL;DR summary). If the provision is absent, say so and set provisionFound=false. Run verify_quote on every quote and drop any that fail.
3. Set the status:
   - risk_found: the risk is present (for a presence check: the provision is missing, empty, a placeholder or clearly inadequate; for a conflict check: two clauses cannot both be applied to the same situation).
   - no_risk: the provision exists and adequately covers the question, with no contradiction.
   - insufficient_data: the text does not allow a confident answer, or the answer depends on a document that was not provided.
4. Explain the risk briefly and propose a fix (leave suggestedFix empty unless the status is risk_found). Write explanation and suggestedFix in ${lang()}; quotes stay in the document's language.

Rules by check_type:
- presence: the required provision must exist AND answer every part of the question. If any part is left unanswered (no forum named, no limit amount given, the amount is a placeholder, only a cross-reference to "applicable law" instead of a rule, optional wording such as "may seek relief" instead of a binding rule), that is risk_found, even if the clause exists. Missing entirely = risk_found. no_risk only when every part is answered by a quoted clause.
- conflict: the risk is either (a) a CONTRADICTION: two clauses that cannot both be applied to the same situation. Then you need TWO verified quotes (the claim and the clause that contradicts it) and one conflictType from the list below; if you cannot quote both sides there is no contradiction finding. Or (b) a GAP or DEFECT named in the question (for example no limit amount, an unfilled value, an exception that cancels the limit, optional wording instead of a binding forum, an absent counterpart clause). Then answer risk_found with conflictType "none", quote the clause that shows the gap (or set provisionFound=false if it is entirely absent) and explain it.
- cross_doc: if the text relies on a document that is not provided (policy, appendix, another agreement) answer insufficient_data and quote the reference. If nothing is referenced, answer no_risk.
Hard rules: do not invent violations or legal consequences. Do not draw categorical conclusions when information is missing; use insufficient_data. Jurisdiction hints are drafts for a lawyer, never state them as law. Return exactly one result per risk id.

${needsConflict ? `CONFLICT TYPES (definition, example, and what NOT to count as a conflict):\n${cfg.conflictTypesMd}\n` : ""}
RISKS TO CHECK:
${risks.map((r) => riskBlock(r, hints(r.id))).join("\n\n")}

Reply with JSON only.`;
}

export function verifierPrompt(cfg: Config): string {
  return `You are the verifier. You receive a candidate contradiction between two clauses of a Web3 Terms of Service. Try to RECONCILE the two norms: find a reasonable, text-based reading under which both can hold (different scope or product, one clause qualifying the other, a standard legal carve-out, a defined term that resolves it).

${TOOLS}

Read the surrounding clauses and definitions first.
- reconcilable = true only if you can state a concrete reading under which both quotes hold; put it in reconcileNote.
- reconcilable = false if no honest reading makes both hold; in reconcileNote list the reconciliation attempts and why each fails.
A reconciliation is NOT valid if it (a) requires ignoring an absolute term in one clause ("exclusive", "at all times", "cannot", "fully", "never", "all"), (b) assumes a fact, scope or product split that the text does not state, or (c) only shows that the clauses could in theory apply to different situations while the text itself gives no such separation. A permission ("may") that covers the same act as an absolute prohibition does contradict it. Do not assume facts that are not in the document. Write reconcileNote in ${lang()}.

Types and exclusions for reference:
${cfg.conflictTypesMd}`;
}
