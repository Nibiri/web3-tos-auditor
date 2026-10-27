/**
 * Before/after check of the lawyer few-shot examples.
 *   npm run eval:lawyer            (REPEATS=3 to average LLM noise, CONCURRENCY=2)
 * Arm A = no examples. Arm B = TRAIN-split examples only, same-document examples allowed.
 * Only the HOLDOUT split is evidence: those risks have no example of their own, so a gain there means the
 * calibration transferred. The TRAIN split is printed for completeness and is in-sample (B saw those answers).
 * With a single labelled document this is a weak test; label a second document and pass --holdout-doc to
 * scripts/build_dataset.ts for the real one (train on document 1, test on document 2).
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { loadExamples, type Example } from "./fewshot.js";
import { auditDocument } from "./pipeline.js";

process.env.OUTPUT_LANG ||= "English"; // the lawyer rated English reports
process.env.OUTPUT_LANG_EXPLICIT = "1";
const REPEATS = Number(process.env.REPEATS || 1);
const CONC = Number(process.env.CONCURRENCY || 2);
const examples = loadExamples().filter((e) => e.gold_status);
const docs = [...new Set(examples.map((e) => e.document))];
const hit = (got: string | undefined, e: Example) => !!got && [e.gold_status!].flat().includes(got);

const arms = { A_no_examples: loadConfig(undefined, { fewshot: "off" }), B_train_examples: loadConfig(undefined, { fewshot: "train", allowSameDoc: true }) };
type Arm = keyof typeof arms;
const score = new Map<string, { ok: number; n: number; fp: number }>(); // key: arm|split
const perItem = new Map<string, Record<Arm, number>>();
let cost = 0;

const jobs = docs.flatMap((d) => Object.keys(arms).flatMap((a) => Array.from({ length: REPEATS }, () => ({ d, a: a as Arm }))));
await Promise.all(Array.from({ length: CONC }, async () => {
  for (let j; (j = jobs.shift()); ) {
    const file = fs.readdirSync("examples").find((f) => path.parse(f).name === j.d && /\.(pdf|docx)$/i.test(f));
    if (!file) { console.error(`no examples/${j.d}.{pdf,docx}, skipped`); continue; }
    const r = await auditDocument(path.join("examples", file), arms[j.a]);
    cost += r.audit.totalCostUsd;
    const st = new Map(r.results.map((x) => [x.riskId, x.status]));
    for (const e of examples.filter((x) => x.document === j.d)) {
      const got = st.get(e.risk_id), k = `${j.a}|${e.split}`, s = score.get(k) ?? { ok: 0, n: 0, fp: 0 };
      s.n++; if (hit(got, e)) s.ok++; else if (got === "risk_found") s.fp++;
      score.set(k, s);
      const p = perItem.get(e.id) ?? ({ A_no_examples: 0, B_train_examples: 0 } as Record<Arm, number>);
      p[j.a] += hit(got, e) ? 1 : 0; perItem.set(e.id, p);
    }
    console.error(`· ${j.d} ${j.a} done`);
  }
}));

const pct = (k: string) => { const s = score.get(k); return s ? `${s.ok}/${s.n} (${((100 * s.ok) / s.n).toFixed(0)}%), over-flagged risk_found: ${s.fp}` : "-"; };
console.log(`\nRepeats per arm: ${REPEATS} | model ${process.env.AUDITOR_MODEL || "claude-sonnet-5-5"} | cost $${cost.toFixed(2)}`);
for (const split of ["holdout", "train"]) {
  console.log(`\n${split.toUpperCase()}${split === "train" ? " (in-sample for B, not evidence)" : " (evidence)"}`);
  for (const a of Object.keys(arms)) console.log(`  ${a.padEnd(18)} ${pct(`${a}|${split}`)}`);
}
console.log("\nPer item (runs matching lawyer's status, out of " + REPEATS + "):");
for (const e of examples) { const p = perItem.get(e.id); if (p) console.log(`  ${e.split.padEnd(7)} ${e.risk_id}  A=${p.A_no_examples}  B=${p.B_train_examples}${p.A_no_examples !== p.B_train_examples ? "  <-" : ""}`); }
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync(path.join("out", `eval-lawyer-${Date.now()}.json`), JSON.stringify({ repeats: REPEATS, score: Object.fromEntries(score), perItem: Object.fromEntries(perItem), cost }, null, 1));
