import { loadConfig } from "./config.js";
import fs from "node:fs";
import path from "node:path";
import { applies, type Config, type Risk } from "./config.js";
import { parseDocument, type ParsedDoc } from "./parse.js";
import { MODEL, runAgent, type RunStats } from "./agent.js";
import { agentPrompt, validatorPrompt, profilePrompt, verifierPrompt } from "./prompts.js";
import { ValidatorSchema, makeAgentSchema, ProfileSchema, STATUS_RU, VerdictSchema, type AgentResult, type Profile, type Result, type Status } from "./schema.js";
import { verifyQuote } from "./verify.js";
import { normText } from "./normalize.js";
import { isScannedPdf, ocrPdf } from "./ocr.js";
import { findPlaceholders } from "./mechanical.js";
import type { ToolCallRecord } from "./tools.js";

export interface AuditResult {
  document: string;
  profile: Profile;
  results: Result[];
  skipped: { riskId: string; reason: string }[];
  dropped: { riskId: string; reason: string }[];
  audit: {
    runId: string; configHash: string; configFiles: Record<string, string>; model: string;
    startedAt: string; finishedAt: string; totalCostUsd: number; runs: RunStats[]; toolCalls: ToolCallRecord[];
  };
}

const mk = (r: Risk, p: Partial<Result> & { status: Status }): Result => ({
  riskId: r.id, topic: r.topic, checkType: r.check_type, risk: r.risk, statusRu: STATUS_RU[p.status],
  provisionFound: false, conflictType: null, quotes: [], explanation: "", reconcileNote: "", suggestedFix: "", needsReview: false, ...p,
});

/** Code-level checks on one agent answer: every quote is verified against the document; claims without proof are downgraded. */
function finalize(doc: ParsedDoc, r: Risk, a: AgentResult, dropped: AuditResult["dropped"]): Result {
  const quotes: Result["quotes"] = [];
  for (const q of a.quotes) {
    const v = verifyQuote(doc, q.text);
    if (!v.verified) { dropped.push({ riskId: r.id, reason: `quote not verified (${v.reason}): "${q.text.slice(0, 80)}"` }); continue; }
    quotes.push({ text: v.canonicalText!, location: v.location!, role: q.role });
  }
  const distinct = new Set(quotes.map((q) => normText(q.text))).size;
  const base = { provisionFound: a.provisionFound, conflictType: a.conflictType === "none" ? null : a.conflictType, quotes, explanation: a.explanation, suggestedFix: a.suggestedFix };
  const downgrade = (why: string) => mk(r, { ...base, status: "insufficient_data", explanation: `${a.explanation} [Проверка кодом: ${why}]`, suggestedFix: "" });

  const isContradiction = r.check_type === "conflict" && base.conflictType !== null;
  if (isContradiction && a.status === "risk_found" && distinct < 2) return downgrade("не найдены две подтверждённые цитаты, конфликт не принят");
  if (a.status === "no_risk" && a.provisionFound && distinct < 1) return downgrade("положение не подтверждено цитатой");
  if (a.status === "risk_found" && a.provisionFound && !isContradiction && distinct < 1) return downgrade("положение не подтверждено цитатой");
  if (r.check_type === "cross_doc" && a.status === "insufficient_data" && distinct < 1) return mk(r, { ...base, status: "insufficient_data" });
  return mk(r, { ...base, status: a.status });
}

/** Several risks resting on the same quote describe one problem; keep the first and point the rest to it. */
function markDuplicates(results: any[]) {
  const seen = new Map<string, string>();
  for (const r of [...results].sort((a, b) => a.riskId.localeCompare(b.riskId))) {
    if (r.status !== "risk_found" || r.dupOf) continue;
    const keys: string[] = r.quotes.map((q: any) => normText(q.text)).filter((k: string) => k.length >= 25);
    const hit = keys.map((k) => seen.get(k)).find(Boolean);
    if (hit) r.dupOf = hit;
    else keys.forEach((k) => seen.set(k, r.riskId));
  }
}

/** Report language follows the document unless OUTPUT_LANG is set explicitly. */
export function detectLang(text: string): "Russian" | "English" {
  const t = text.slice(0, 20000);
  const cy = (t.match(/[А-Яа-яЁё]/g) ?? []).length, la = (t.match(/[A-Za-z]/g) ?? []).length;
  return cy > la ? "Russian" : "English";
}

export async function auditDocument(file: string, cfg: Config, onProgress: (s: string) => void = () => {}): Promise<AuditResult> {
  const startedAt = new Date().toISOString();
  const ocrText = isScannedPdf(file) ? await ocrPdf(file, onProgress) : undefined;
  const doc = parseDocument(file, ocrText);
  if (!process.env.OUTPUT_LANG_FIXED && !process.env.OUTPUT_LANG_EXPLICIT) {
    process.env.OUTPUT_LANG = detectLang(doc.sections.map((x) => x.text).join("\n"));
    cfg = loadConfig();
  }
  const log: ToolCallRecord[] = [];
  const stats: RunStats[] = [];
  const dropped: AuditResult["dropped"] = [];
  onProgress(`${doc.name}: ${doc.sections.length} sections`);

  const profile = await runAgent({
    label: "profile", system: profilePrompt(), prompt: `Classify the document "${doc.name}".`,
    schema: ProfileSchema, doc, log, stats, maxTurns: 20,
  });
  onProgress(`${doc.name}: profile ${profile.projectType} [${profile.tags.join(",")}] ${profile.jurisdictions.join(",")}`);

  const skipped: AuditResult["skipped"] = [];
  const active = cfg.risks.filter((r) => (applies(r, profile.tags) ? true : (skipped.push({ riskId: r.id, reason: `applies_to=${r.applies_to.join(";")}, project tags=[${profile.tags.join(",")}]` }), false)));

  const out = new Map<string, Result>();

  // Mechanical checks: code only.
  for (const r of active.filter((x) => x.check_type === "mechanical")) {
    const ph = findPlaceholders(doc);
    out.set(r.id, ph.length
      ? mk(r, { status: "risk_found", provisionFound: true, quotes: ph.slice(0, 6).map((p) => ({ ...p, role: "reference" as const })),
          explanation: `В тексте найдены незаполненные поля (${ph.length}).`, suggestedFix: r.output_if_found })
      : mk(r, { status: "no_risk", explanation: "Незаполненных полей не найдено." }));
  }

  // One agent per area, each with its own prompt and its own subset of risks.
  await Promise.all(cfg.agents.map(async (ag) => {
    const risks = active.filter((r) => r.check_type !== "mechanical" && ag.risk_topics.includes(r.topic));
    if (!risks.length) return;
    const Schema = makeAgentSchema(risks.map((r) => r.id), cfg.conflictTypes);
    const res = await runAgent({
      label: `agent:${ag.topic}`, system: agentPrompt(ag, risks, profile, cfg),
      prompt: `Check the document "${doc.name}" against your ${risks.length} risks and return one result per risk.`,
      schema: Schema, doc, log, stats,
    });
    for (const r of risks) {
      const a = res.results.find((x) => x.riskId === r.id);
      out.set(r.id, a ? finalize(doc, r, a, dropped) : mk(r, { status: "insufficient_data", explanation: "Агент не вернул ответ по этой проверке." }));
    }
    onProgress(`${doc.name}: ${ag.topic} done (${risks.length} checks)`);
  }));

  // Final validator: whole-document re-check with legal basis, dedup, materiality. Prompt is shared project-wide (config/validator_prompt.md).
  const judged = [...out.values()].filter((x) => x.explanation && x.checkType !== "mechanical");
  if (judged.length) {
    const vr = await runAgent({
      label: "validator", system: "You are a careful senior legal reviewer.",
      prompt: validatorPrompt(cfg, judged),
      schema: ValidatorSchema, doc, log, stats, maxTurns: 40,
    });
    for (const f of vr.reviews) {
      const x = out.get(f.riskId);
      if (!x) continue;
      x.legalBasis = f.legalBasis;
      if (f.verdict === "change_status" && x.status !== f.correctStatus) {
        const risk = cfg.risks.find((r) => r.id === f.riskId)!;
        onProgress(`${doc.name}: ${f.riskId} status ${x.status} -> ${f.correctStatus}`);
        x.status = f.correctStatus; x.statusRu = STATUS_RU[f.correctStatus];
        x.explanation += ` [${f.why}]`;
        if (f.correctStatus === "risk_found" && !x.suggestedFix) x.suggestedFix = risk.output_if_found;
        if (f.correctStatus !== "risk_found") x.suggestedFix = "";
      } else if (f.verdict === "duplicate" && f.duplicateOf && f.duplicateOf !== f.riskId && out.has(f.duplicateOf)) x.dupOf = f.duplicateOf;
      else if (f.verdict === "immaterial") { x.immaterial = true; x.explanation += ` [${f.why}]`; }
    }
  }

  // Verifier: try to reconcile every conflict-type finding.
  await Promise.all([...out.values()].filter((x) => x.checkType === "conflict" && x.status === "risk_found" && x.conflictType !== null).map(async (c) => {
    const v = await runAgent({
      label: `verifier:${c.riskId}`, system: verifierPrompt(cfg),
      prompt: `Risk ${c.riskId}: ${c.risk}\nAnalyst explanation: ${c.explanation}\nQuotes:\n${c.quotes.map((q, i) => `${i + 1}. [${q.role}] (${q.location}) "${q.text}"`).join("\n")}\n\nTry to reconcile the norms.`,
      schema: VerdictSchema, doc, log, stats, maxTurns: 25,
    });
    c.reconcileNote = v.reconcileNote;
    if (v.reconcilable) { c.status = "insufficient_data"; c.statusRu = STATUS_RU.insufficient_data; c.needsReview = true; }
    onProgress(`${doc.name}: ${c.riskId} verifier -> ${v.reconcilable ? "needs review" : "risk confirmed"}`);
  }));

  const results = cfg.risks.map((r) => out.get(r.id)).filter((x): x is Result => !!x);
  markDuplicates(results);
  const finishedAt = new Date().toISOString();
  return {
    document: doc.name, profile, results, skipped, dropped,
    audit: { runId: startedAt.replace(/[:.]/g, "-"), configHash: cfg.hash, configFiles: cfg.files, model: MODEL(), startedAt, finishedAt,
      totalCostUsd: stats.reduce((a, s) => a + s.costUsd, 0), runs: stats, toolCalls: log },
  };
}

export function writeResult(r: AuditResult, outDir = "out") {
  const dir = path.resolve(outDir, r.audit.runId);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, r.document);
  fs.writeFileSync(base + ".result.json", JSON.stringify({ document: r.document, profile: r.profile, results: r.results, skipped: r.skipped, dropped: r.dropped }, null, 2));
  fs.writeFileSync(base + ".audit.json", JSON.stringify(r.audit, null, 2));
  return dir;
}
