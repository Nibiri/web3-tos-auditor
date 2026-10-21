import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { auditDocument, writeResult, type AuditResult } from "./pipeline.js";
import { normText } from "./normalize.js";

interface Expected { id: string; topic?: string; type?: string; anchors: string[][] }

const dir = path.resolve(process.env.EXAMPLES_DIR || "examples");
const files = fs.readdirSync(dir).filter((f) => /\.(pdf|docx)$/i.test(f)).sort();
const isReference = (f: string) => !/^bad_/i.test(f);
const cfg = loadConfig();
const CONC = Number(process.env.CONCURRENCY || 2);

function expectedFor(file: string): Expected[] | null {
  const p = path.join(dir, file.replace(/\.[^.]+$/, "") + ".expected.json");
  if (!fs.existsSync(p)) return null;
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return Array.isArray(j.conflicts) ? j.conflicts : null;
}

type Out = AuditResult["conflicts"][number];
const real = (r: AuditResult) => r.conflicts.filter((c) => c.status === "conflict" || c.status === "needs_review");

/** One side of the expected pair must match one quote and the other side a different quote. */
function matches(e: Expected, c: Out): boolean {
  const hit = (group: string[], i: number) => group.some((a) => normText(c.quotes[i].text).includes(normText(a)));
  const [A, B] = e.anchors;
  for (let i = 0; i < c.quotes.length; i++)
    for (let j = 0; j < c.quotes.length; j++) if (i !== j && hit(A, i) && hit(B, j)) return true;
  return false;
}

/** Each output conflict may satisfy at most one expected conflict (most constrained expected first). */
function countFound(exp: Expected[], r: AuditResult): number {
  const outs = real(r);
  const cand = exp.map((e) => outs.map((c, i) => (matches(e, c) ? i : -1)).filter((i) => i >= 0));
  const order = exp.map((_, i) => i).sort((x, y) => cand[x].length - cand[y].length);
  const used = new Set<number>();
  let found = 0;
  for (const e of order) {
    const pick = cand[e].find((i) => !used.has(i));
    if (pick !== undefined) { used.add(pick); found++; }
  }
  return found;
}

const results = new Map<string, AuditResult | Error>();
const queue = [...files];
await Promise.all(
  Array.from({ length: CONC }, async () => {
    for (let f; (f = queue.shift()); ) {
      const t0 = Date.now();
      try {
        const r = await auditDocument(path.join(dir, f), cfg);
        writeResult(r);
        results.set(f, r);
      } catch (e) {
        results.set(f, e as Error);
      }
      console.error(`· ${f} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }),
);

const rows: string[][] = [["file", "kind", "found/expected", "conflict", "needs_review", "insuff.", "cost $"]];
let falseConflicts = 0, cost = 0;
for (const f of files) {
  const r = results.get(f)!;
  if (r instanceof Error) { rows.push([f, isReference(f) ? "reference" : "bad", "ERROR", r.message.slice(0, 40), "", "", ""]); continue; }
  const exp = expectedFor(f);
  const n = (s: string) => String(r.conflicts.filter((c) => c.status === s).length);
  cost += r.audit.totalCostUsd;
  let fe = "";
  if (!isReference(f)) {
    fe = exp ? `${countFound(exp, r)}/${exp.length}` : `${r.conflicts.filter((c) => c.status !== "insufficient_data").length}/? (no expected)`;
  } else falseConflicts += r.conflicts.filter((c) => c.status === "conflict").length;
  rows.push([f, isReference(f) ? "reference" : "bad", fe || "-", n("conflict"), n("needs_review"), n("insufficient_data"), r.audit.totalCostUsd.toFixed(2)]);
}
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
console.log(rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ")).join("\n"));
console.log(`\nFALSE CONFLICTS ON REFERENCES (main metric): ${falseConflicts}`);
console.log(`Total cost: $${cost.toFixed(2)}  | model: ${process.env.AUDITOR_MODEL || "claude-sonnet-5-5"}  | config hash: ${cfg.hash.slice(0, 12)}`);
for (const f of files) {
  const r = results.get(f);
  if (!r || r instanceof Error || !isReference(f)) continue;
  for (const c of r.conflicts.filter((c) => c.status !== "insufficient_data"))
    console.log(`  [${f}] ${c.status} ${c.conflictId}: ${c.quotes.map((q) => q.location).join("  vs  ")}`);
}
