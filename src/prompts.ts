import type { Agent, Config, JurisdictionRule, Risk } from "./config.js";
import type { Profile } from "./schema.js";
import { fewshotBlock } from "./fewshot.js";

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

const RISK_NOTES: Record<string, string> = {
  "R-04": "Достаточно, если запрещённые юрисдикции или санкционные ограничения прописаны в тексте (назови пункт) — это no_risk. Не требуй описания технического скрининга, геоблокировки или проверок; их отсутствие можно упомянуть в объяснении, но статус от этого не меняется.",
  "R-11": "Если указан лимит (сумма), вопрос закрыт: no_risk, пока исключения не обнуляют лимит. Отсутствие периода не считай дефектом (можно упомянуть в объяснении).",
  "R-28": "Политика конфиденциальности может быть вынесена в отдельный документ, её отсутствие в файле не нарушение. Есть ссылка на политику, а текста нет → insufficient_data. Ссылки нет → insufficient_data, а не risk_found, пока нет цитаты, показывающей реальное упущение (например, обработка данных без раскрытия).",
  "R-31": "Отдельные документы могут быть вынесены за файл: отсутствие их текста само по себе не нарушение. Ссылка есть, текста нет → insufficient_data (цитируй ссылку), не risk_found.",
  "R-22": "Оценивай только последствия для активов пользователя. Если активы остаются у пользователя (non-custodial) и та же оговорка о приостановке или прекращении доступа уже оценена в R-08, это не отдельный риск: no_risk с пояснением, на какой риск ссылаешься.",
  "R-23": "Если оператор не хранит и не контролирует активы пользователя (non-custodial), план возврата активов при закрытии продукта не требуется: no_risk. Отсутствие процедуры закрытия можно упомянуть в объяснении, но статус от этого не меняется.",
  "R-26": "Отсутствие права отказаться от арбитража или коллективных исков (opt-out) само по себе не риск. risk_found только если документ адресован потребителям из юрисдикции, где такой отказ недопустим или ограничен, и это видно из текста; если юрисдикция потребителей неясна, статус insufficient_data с пояснением, что нужна оценка юриста; иначе no_risk.",
  "R-33": "Достаточно, если есть оговорка об отдельности (severability) и о полноте соглашения (entire agreement). Отсутствие положений об уступке или о приоритете языковой версии не риск (можно упомянуть в объяснении). risk_found только если отсутствуют оба основных положения.",
  "R-27": "risk_found только если есть цитата, которая исключает или ограничивает права потребителей. Одно отсутствие оговорки без такой нормы → insufficient_data с пояснением, что нужна оценка юриста."
};

const riskBlock = (r: Risk, hints: JurisdictionRule[], shots = "") =>
  `[${r.id}] check_type=${r.check_type} | risk: ${r.risk}
  question: ${r.prompt}
  if risk found, fix: ${r.output_if_found}` +
  (RISK_NOTES[r.id] ? `\n  scope note (lawyer review): ${RISK_NOTES[r.id]}` : "") + shots +
  (r.jurisdiction_dependent
    ? `\n  jurisdiction-dependent: the verdict depends on the applicable law. If it cannot be determined from the text which law applies, or the answer turns on law you cannot establish, answer insufficient_data and say which law matters, not a categorical conclusion.`
    : "") +
  (hints.length
    ? `\n  jurisdiction hints (DRAFT, not verified by a lawyer, use as a lens only, never as a legal conclusion): ` +
      hints.map((h) => `[${h.jurisdiction}] ${h.note} (${h.source})`).join(" | ")
    : "");

export function agentPrompt(agent: Agent, risks: Risk[], profile: Profile, cfg: Config, docName = ""): string {
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
Hard rules: do not invent violations or legal consequences. Do not draw categorical conclusions when information is missing; use insufficient_data. Jurisdiction hints are drafts for a lawyer, never state them as law. The explanation must agree with the status: if it describes any deficiency named in the question (for example no notice period, no appeal route), the status is risk_found, not no_risk. Judge only what the question asks: do not require extra elements the question does not name, and do not mark a missing separate document as a violation. Report one root cause once: if several risks rest on the same clause, use the same quotes. Return exactly one result per risk id.

${needsConflict ? `CONFLICT TYPES (definition, example, and what NOT to count as a conflict):\n${cfg.conflictTypesMd}\n` : ""}
RISKS TO CHECK:
${risks.map((r) => riskBlock(r, hints(r.id), fewshotBlock(r.id, cfg.fewshot, docName, cfg.fewshotAllowSameDoc))).join("\n\n")}

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

export function consistencyPrompt(items: { riskId: string; risk: string; status: string; explanation: string }[]): string {
  return `You check legal check results for internal consistency. Each result has a status and an explanation written by an analyst.
- risk_found: the explanation describes a deficiency, gap, contradiction or risk named in the check.
- no_risk: the explanation says the provision exists and adequately covers the question, with no deficiency.
- insufficient_data: the explanation says the answer cannot be given from the text.
Find results whose status does NOT match what the explanation says (for example status no_risk while the explanation describes a missing notice period). Do not re-judge the document and do not change a status when the explanation supports it. Return only the inconsistent ones with the status the explanation supports. If none, return an empty list.

RESULTS:
${items.map((i) => `[${i.riskId}] check: ${i.risk}\n  status: ${i.status}\n  explanation: ${i.explanation}`).join("\n\n")}

Reply with JSON only: {"fixes":[{"riskId":"R-00","correctStatus":"risk_found"|"no_risk"|"insufficient_data","why":"<one sentence in ${lang()}>"}]}`;
}

export function validatorPrompt(cfg: Config, items: { riskId: string; risk: string; status: string; explanation: string; quotes: { role: string; location: string; text: string }[] }[]): string {
  return `${cfg.validatorMd.replaceAll("{{LANG}}", lang())}

${TOOLS}

RESULTS:
${items.map((i) => `[${i.riskId}] check: ${i.risk}\n  status: ${i.status}\n  explanation: ${i.explanation}\n  quotes: ${i.quotes.map((q) => `[${q.role}] (${q.location}) "${q.text}"`).join(" | ") || "none"}`).join("\n\n")}

Reply with JSON only: {"reviews":[{"riskId":"R-00","verdict":"confirm"|"change_status"|"duplicate"|"immaterial","correctStatus":"risk_found"|"no_risk"|"insufficient_data","legalBasis":"...","duplicateOf":"R-00 or empty","why":"one sentence"}]}`;
}
