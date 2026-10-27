/**
 * Lawyer ratings -> training dataset.
 *   npx tsx scripts/build_dataset.ts [--holdout-doc <Document>]
 * Reads data/lawyer/raw/*.feedback.json (export of the artifact's `feedback` collection), documents.json, overrides.json.
 * Writes data/lawyer/dataset.jsonl and data/lawyer/split.json (frozen: a row keeps its split when new labels arrive).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseCsv } from "../src/config.js";
import type { Example } from "../src/fewshot.js";

const dir = path.resolve("data/lawyer");
const HOLDOUT_SHARE = 0.3;
const holdoutDoc = process.argv.includes("--holdout-doc") ? process.argv[process.argv.indexOf("--holdout-doc") + 1] : "";
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const [header, ...riskRows] = parseCsv(fs.readFileSync("config/risks.csv", "utf8"));
const risks = new Map(riskRows.map((r) => [r[header.indexOf("id")], Object.fromEntries(header.map((h, i) => [h.trim(), r[i]]))]));
const docs: Record<string, { document: string; context: string }> = readJson("documents.json");
const overrides: Record<string, { gold_status: string | string[]; inferred: boolean }> = readJson("overrides.json");
const splitFile = path.join(dir, "split.json");
const split: Record<string, "train" | "holdout"> = fs.existsSync(splitFile) ? readJson("split.json") : {};

interface Raw { docKey: string; riskId: string; agentStatus: string; verdict: "correct" | "false_positive"; comment: string; explanation: string; quotes: string[]; dupOf: string; immaterial: boolean }
const raw: Raw[] = fs.readdirSync(path.join(dir, "raw")).filter((f) => f.endsWith(".feedback.json"))
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, "raw", f), "utf8")) as Raw[]);

const rows = raw.map((r) => {
  const id = `${r.docKey}:${r.riskId}`;
  const doc = docs[r.docKey];
  if (!doc) throw new Error(`${id}: unknown docKey, add it to documents.json`);
  const ov = overrides[id];
  const gold = r.verdict === "correct" ? r.agentStatus : ov?.gold_status ?? null;
  const source = r.verdict === "correct" ? "agreed" : ov ? (ov.inferred ? "inferred" : "agreed") : "none";
  return {
    id, document: doc.document, doc_context: doc.context, risk_id: r.riskId, risk: risks.get(r.riskId)?.risk ?? "",
    check_type: risks.get(r.riskId)?.check_type ?? "", quotes: r.quotes, model_status: r.agentStatus,
    model_explanation: r.explanation, lawyer_verdict: r.verdict, lawyer_comment: r.comment,
    gold_status: gold, gold_source: source, dup_of: r.dupOf, immaterial: r.immaterial,
  };
}).sort((a, b) => a.id.localeCompare(b.id));

// New rows: a whole document goes to holdout when asked; otherwise the first labelled document is split by risk,
// stratified by (verdict, status) so that rare strata (false positives, insufficient_data) reach both sides.
const strata = new Map<string, typeof rows>();
for (const r of rows) if (!split[r.id]) {
  if (holdoutDoc && r.document === holdoutDoc) { split[r.id] = "holdout"; continue; }
  const k = `${r.lawyer_verdict}|${r.gold_status ?? "none"}`;
  strata.set(k, [...(strata.get(k) ?? []), r]);
}
for (const list of strata.values()) {
  list.sort((a, b) => hash(a.id).localeCompare(hash(b.id)));
  const n = list.length === 1 ? (parseInt(hash(list[0].id).slice(0, 2), 16) / 255 < HOLDOUT_SHARE ? 1 : 0) : Math.round(list.length * HOLDOUT_SHARE);
  list.forEach((r, i) => (split[r.id] = i < n ? "holdout" : "train"));
}

const out: Example[] = rows.map((r) => ({ ...r, split: split[r.id] })) as never;
fs.writeFileSync(path.join(dir, "dataset.jsonl"), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
fs.writeFileSync(splitFile, JSON.stringify(Object.fromEntries(Object.entries(split).sort()), null, 1) + "\n");

const count = (f: (r: (typeof out)[number]) => string) => Object.entries(out.reduce<Record<string, number>>((a, r) => ((a[f(r)] = (a[f(r)] ?? 0) + 1), a), {})).map(([k, v]) => `${k}=${v}`).join(", ");
console.log(`${out.length} rows -> data/lawyer/dataset.jsonl`);
console.log(`split: ${count((r) => r.split)}`);
console.log(`by verdict/gold: ${count((r) => `${r.lawyer_verdict}/${r.gold_status}`)}`);
console.log(`no gold status (excluded from few-shot and eval): ${out.filter((r) => !r.gold_status).length}`);
console.log(`holdout: ${out.filter((r) => r.split === "holdout").map((r) => r.risk_id).join(" ")}`);
