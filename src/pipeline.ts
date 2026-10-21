import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { parseDocument, type ParsedDoc } from "./parse.js";
import { MODEL, runAgent, type RunStats } from "./agent.js";
import { mergePrompt, subagentPrompt, verifierPrompt } from "./prompts.js";
import { makeFindingsSchema, MergeSchema, VerdictSchema, type Conflict, type Finding } from "./schema.js";
import { verifyQuote } from "./verify.js";
import { normText } from "./normalize.js";
import type { ToolCallRecord } from "./tools.js";

export interface AuditResult {
  document: string;
  conflicts: Conflict[];
  dropped: { topic: string; reason: string; finding: Finding }[];
  audit: {
    runId: string;
    configHash: string;
    configFiles: Record<string, string>;
    model: string;
    startedAt: string;
    finishedAt: string;
    totalCostUsd: number;
    runs: RunStats[];
    toolCalls: ToolCallRecord[];
  };
}

type Checked = { topic: string; finding: Finding; quotes: Conflict["quotes"] };

/** Code-level quote verification. Drops findings without two verified quotes (one for insufficient_data). */
function checkFinding(doc: ParsedDoc, topic: string, f: Finding): { ok: Checked } | { drop: string } {
  const quotes: Conflict["quotes"] = [];
  for (const q of f.quotes) {
    const v = verifyQuote(doc, q.text);
    if (!v.verified) return { drop: `quote not verified (${v.reason}): "${q.text.slice(0, 80)}"` };
    quotes.push({ text: v.canonicalText!, location: v.location!, role: q.role });
  }
  const distinct = new Set(quotes.map((q) => normText(q.text)));
  const need = f.status === "insufficient_data" ? 1 : 2;
  if (distinct.size < need) return { drop: `needs ${need} distinct verified quotes, got ${distinct.size}` };
  return { ok: { topic, finding: f, quotes } };
}

const keyOf = (c: Checked) =>
  c.quotes.map((q) => normText(q.text).slice(0, 60)).sort().join("|");

export async function auditDocument(file: string, cfg: Config, onProgress: (s: string) => void = () => {}): Promise<AuditResult> {
  const startedAt = new Date().toISOString();
  const doc = parseDocument(file);
  const log: ToolCallRecord[] = [];
  const stats: RunStats[] = [];
  const dropped: AuditResult["dropped"] = [];
  const FindingsSchema = makeFindingsSchema(cfg.conflictTypes);

  onProgress(`${doc.name}: ${doc.sections.length} sections, running ${cfg.topics.length} topic agents`);

  // Orchestrator: fan out one sub-agent per topic (own prompt, own context), then collect.
  const perTopic = await Promise.all(
    cfg.topics.map(async (t) => {
      const out = await runAgent({
        label: `topic:${t.topic}`,
        system: subagentPrompt(t, cfg),
        prompt: `Analyze the document "${doc.name}" for contradictions on the topic "${t.topic}". Return your findings.`,
        schema: FindingsSchema,
        doc, log, stats,
      });
      onProgress(`${doc.name}: topic ${t.topic} -> ${out.findings.length} candidate(s)`);
      return { topic: t.topic, findings: out.findings };
    }),
  );

  // Merge + code-level quote verification + dedupe.
  const seen = new Set<string>();
  const checked: Checked[] = [];
  for (const { topic, findings } of perTopic) {
    for (const f of findings) {
      const r = checkFinding(doc, topic, f);
      if ("drop" in r) { dropped.push({ topic, reason: r.drop, finding: f }); continue; }
      const k = keyOf(r.ok);
      if (seen.has(k)) { dropped.push({ topic, reason: "duplicate of another topic's finding", finding: f }); continue; }
      seen.add(k);
      checked.push(r.ok);
    }
  }

  // Merge candidates that describe the same underlying contradiction.
  let kept = checked;
  if (checked.length > 1) {
    const m = await runAgent({
      label: "merge",
      system: mergePrompt(),
      prompt: checked
        .map((c, i) => `#${i} [${c.topic}/${c.finding.type}] ${c.quotes.map((q) => `(${q.location}) "${q.text}"`).join(" <-> ")}\n   ${c.finding.explanation}`)
        .join("\n\n"),
      schema: MergeSchema, doc, log, stats, maxTurns: 5,
    });
    const taken = new Set<number>();
    kept = [];
    for (const cl of m.clusters) {
      const members = cl.members.filter((i) => i >= 0 && i < checked.length && !taken.has(i));
      if (!members.length) continue;
      members.forEach((i) => taken.add(i));
      const rep = members.includes(cl.representative) ? cl.representative : members[0];
      const repC = checked[rep];
      const others = members.filter((i) => i !== rep);
      for (const i of others) dropped.push({ topic: checked[i].topic, reason: `merged into ${repC.quotes[0].location}`, finding: checked[i].finding });
      if (others.length) {
        const extra = others.flatMap((i) => checked[i].quotes.map((q) => q.location));
        repC.finding = { ...repC.finding, explanation: `${repC.finding.explanation} (Related clauses: ${[...new Set(extra)].join("; ")}.)` };
      }
      kept.push(repC);
    }
    checked.forEach((c, i) => { if (!taken.has(i)) kept.push(c); });
    onProgress(`${doc.name}: merge ${checked.length} -> ${kept.length}`);
  }

  // Verifier: try to reconcile each conflict. Reconcilable -> needs_review, else conflict.
  const conflicts = await Promise.all(
    kept.map(async (c, i): Promise<Conflict> => {
      const id = "C-" + crypto.createHash("sha1").update(doc.name + keyOf(c)).digest("hex").slice(0, 8);
      if (c.finding.status === "insufficient_data") {
        return { conflictId: id, topic: c.topic, type: c.finding.type, status: "insufficient_data", quotes: c.quotes,
          explanation: c.finding.explanation, reconcileNote: "", suggestedFix: c.finding.suggestedFix };
      }
      const v = await runAgent({
        label: `verifier:${i + 1}`,
        system: verifierPrompt(cfg),
        prompt: `Candidate contradiction (topic: ${c.topic}, type: ${c.finding.type}).\n\nExplanation from analyst: ${c.finding.explanation}\n\nQuotes:\n${c.quotes
          .map((q, n) => `${n + 1}. [${q.role}] (${q.location}) "${q.text}"`).join("\n")}\n\nTry to reconcile the two norms.`,
        schema: VerdictSchema,
        doc, log, stats,
        maxTurns: 25,
      });
      onProgress(`${doc.name}: ${id} verifier -> ${v.reconcilable ? "needs_review" : "conflict"}`);
      return { conflictId: id, topic: c.topic, type: c.finding.type,
        status: v.reconcilable ? "needs_review" : "conflict", quotes: c.quotes,
        explanation: c.finding.explanation, reconcileNote: v.reconcileNote, suggestedFix: c.finding.suggestedFix };
    }),
  );

  const finishedAt = new Date().toISOString();
  return {
    document: doc.name, conflicts, dropped,
    audit: {
      runId: startedAt.replace(/[:.]/g, "-"),
      configHash: cfg.hash, configFiles: cfg.files, model: MODEL(),
      startedAt, finishedAt,
      totalCostUsd: stats.reduce((a, s) => a + s.costUsd, 0),
      runs: stats, toolCalls: log,
    },
  };
}

/** Writes <outDir>/<doc>.result.json (schema output) and <doc>.audit.json (audit log). */
export function writeResult(r: AuditResult, outDir = "out") {
  const dir = path.resolve(outDir, r.audit.runId);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, r.document);
  fs.writeFileSync(base + ".result.json", JSON.stringify({ document: r.document, conflicts: r.conflicts, dropped: r.dropped }, null, 2));
  fs.writeFileSync(base + ".audit.json", JSON.stringify(r.audit, null, 2));
  return dir;
}
