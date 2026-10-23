import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { auditDocument, writeResult, type AuditResult } from "./pipeline.js";

const dir = path.resolve(process.env.EXAMPLES_DIR || "examples");
const files = fs.readdirSync(dir).filter((f) => /\.(pdf|docx)$/i.test(f)).sort();
const isReference = (f: string) => !/^bad_/i.test(f);
if (process.env.OUTPUT_LANG) process.env.OUTPUT_LANG_EXPLICIT = "1";
process.env.OUTPUT_LANG_EXPLICIT ||= "1"; // concurrent docs share the process env, so eval keeps one language
const cfg = loadConfig();
const CONC = Number(process.env.CONCURRENCY || 2);
const conflictIds = new Set(cfg.risks.filter((r) => r.check_type === "conflict").map((r) => r.id));

type Expected = Record<string, string | string[]>;
function expectedFor(file: string): Expected | null {
  const p = path.join(dir, file.replace(/\.[^.]+$/, "") + ".expected.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).risks : null;
}

const results = new Map<string, AuditResult | Error>();
const queue = [...files];
await Promise.all(Array.from({ length: CONC }, async () => {
  for (let f; (f = queue.shift()); ) {
    const t0 = Date.now();
    try { const r = await auditDocument(path.join(dir, f), cfg); writeResult(r); results.set(f, r); }
    catch (e) { results.set(f, e as Error); }
    console.error(`· ${f} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}));

const rows: string[][] = [["file", "kind", "matched/labelled", "risk", "no risk", "insuff.", "false conflicts", "cost $"]];
let falseConflicts = 0, cost = 0, mTot = 0, lTot = 0;
const misses: string[] = [], fps: string[] = [], gaps: string[] = [];
for (const f of files) {
  const r = results.get(f)!;
  const kind = isReference(f) ? "reference" : "bad";
  if (r instanceof Error) { rows.push([f, kind, "ERROR", r.message.slice(0, 40), "", "", "", ""]); continue; }
  const exp = expectedFor(f);
  const st = new Map(r.results.map((x) => [x.riskId, x.status]));
  let m = 0, l = 0;
  if (exp) for (const [id, want] of Object.entries(exp)) {
    l++; const ok = (Array.isArray(want) ? want : [want]).includes(st.get(id) ?? "skipped");
    if (ok) m++; else misses.push(`  [${f}] ${id}: expected ${[want].flat().join("|")}, got ${st.get(id) ?? "skipped"}`);
  }
  // main metric: contradictions (two clauses that conflict) flagged on reference documents and not labelled as expected;
  // gap-type findings on conflict checks (missing/optional/unfilled) are listed separately and not counted
  let fc = 0;
  if (isReference(f)) for (const x of r.results) {
    if (conflictIds.has(x.riskId) && x.status === "risk_found" && !([exp?.[x.riskId] ?? []].flat().includes("risk_found"))) {
      const line = `  [${f}] ${x.riskId} ${x.quotes.map((q) => q.location).join("  vs  ")}`;
      if (x.conflictType) { fc++; fps.push(line); } else gaps.push(line);
    }
  }
  falseConflicts += fc; cost += r.audit.totalCostUsd; mTot += m; lTot += l;
  const n = (s: string) => String(r.results.filter((x) => x.status === s).length);
  rows.push([f, kind, exp ? `${m}/${l}` : "-", n("risk_found"), n("no_risk"), n("insufficient_data"), isReference(f) ? String(fc) : "-", r.audit.totalCostUsd.toFixed(2)]);
}
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
console.log(rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ")).join("\n"));
console.log(`\nFALSE CONFLICTS ON REFERENCES (main metric): ${falseConflicts}`);
console.log(`Labelled checks matched: ${mTot}/${lTot}  | cost $${cost.toFixed(2)} | model ${process.env.AUDITOR_MODEL || "claude-sonnet-5-5"} | config ${cfg.hash.slice(0, 12)}`);
if (fps.length) console.log("\nFalse conflicts:\n" + fps.join("\n"));
if (gaps.length) console.log("\nGap findings on reference documents (not counted, for review):\n" + gaps.join("\n"));
if (misses.length) console.log("\nMismatches vs labels:\n" + misses.join("\n"));
