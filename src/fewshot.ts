import fs from "node:fs";
import path from "node:path";

/** One lawyer-checked case from data/lawyer/dataset.jsonl (see scripts/build_dataset.ts). */
export interface Example {
  id: string;
  document: string;
  doc_context: string;
  risk_id: string;
  quotes: string[];
  model_status: string;
  lawyer_verdict: "correct" | "false_positive";
  lawyer_comment: string;
  gold_status: string | string[] | null;
  gold_source: "agreed" | "inferred" | "none";
  dup_of: string;
  split: "train" | "holdout";
}

/** off = no examples; train = only the train split (used by eval-lawyer); all = every verified example (production). */
export type FewshotMode = "off" | "train" | "all";
const MAX_PER_RISK = 2;
const MAX_QUOTE = 300;

export const fewshotMode = (): FewshotMode => {
  const v = (process.env.FEWSHOT ?? "all").toLowerCase();
  return v === "off" || v === "0" ? "off" : v === "train" ? "train" : "all";
};

export function loadExamples(file = path.resolve("data/lawyer/dataset.jsonl")): Example[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Example);
}

/** Corrections teach the most, then cases with a lawyer's note, then plain confirmations; duplicates of another risk are skipped. */
const rank = (e: Example) => (e.lawyer_verdict === "false_positive" ? 0 : e.lawyer_comment ? 1 : 2);

export function selectExamples(all: Example[], mode: FewshotMode): Example[] {
  if (mode === "off") return [];
  const usable = all.filter((e) => e.gold_status && e.quotes.length && (mode === "all" || e.split === "train")
    && !(e.dup_of && e.lawyer_verdict === "correct"));
  const byRisk = new Map<string, Example[]>();
  for (const e of usable) byRisk.set(e.risk_id, [...(byRisk.get(e.risk_id) ?? []), e]);
  return [...byRisk.values()].flatMap((l) => l.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id)).slice(0, MAX_PER_RISK));
}

const clip = (s: string) => (s.length > MAX_QUOTE ? s.slice(0, MAX_QUOTE) + "…" : s);
const goldText = (g: string | string[]) => [g].flat().join(" or ");

/**
 * Prompt text for one risk. Examples from the document being audited are skipped by default: the lawyer's answer
 * for this very text would leak the result (set allowSameDoc only for eval-lawyer).
 */
export function fewshotBlock(riskId: string, examples: Example[], docName: string, allowSameDoc = false): string {
  const own = examples.filter((e) => e.risk_id === riskId && (allowSameDoc || e.document !== docName));
  if (!own.length) return "";
  return own.map((e) => {
    const verdict = e.lawyer_verdict === "correct"
      ? `lawyer CONFIRMED ${e.model_status}`
      : `lawyer REJECTED ${e.model_status}; correct status: ${goldText(e.gold_status!)}`;
    return `\n  lawyer-reviewed example (other document: ${e.doc_context}): quoted ${e.quotes.map((q) => `"${clip(q)}"`).join(" + ")} -> analyst said ${e.model_status}; ${verdict}.` +
      (e.lawyer_comment ? ` Lawyer's note: ${e.lawyer_comment}.` : "") +
      ` Use it to calibrate how strict to be; it is not a fact about this document.`;
  }).join("");
}
