import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type CheckType = "presence" | "conflict" | "cross_doc" | "mechanical";
export interface Risk {
  id: string; topic: string; applies_to: string[]; risk: string; prompt: string;
  output_if_found: string; check_type: CheckType; evidence: string; jurisdiction_dependent: boolean; title: string;
}
export interface JurisdictionRule { jurisdiction: string; risk_id: string; note: string; source: string; status: string }
export interface Agent { topic: string; description: string; risk_topics: string[]; watch_for: string }
export interface Config {
  agents: Agent[];
  risks: Risk[];
  jurisdictionRules: JurisdictionRule[];
  conflictTypesMd: string;
  validatorMd: string;
  conflictTypes: string[];
  hash: string;
  files: Record<string, string>;
}

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, newlines inside quotes). */
export function parseCsv(src: string): string[][] {
  src = src.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [], f = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(f); f = ""; if (row.some((x) => x.trim())) rows.push(row); row = [];
    } else f += c;
  }
  if (f || row.length) { row.push(f); if (row.some((x) => x.trim())) rows.push(row); }
  return rows;
}

function table(csv: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(csv);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

export function loadConfig(dir = path.resolve("config")): Config {
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
  const [topicsCsv, risksCsv, md, jrCsv] = [read("topics.csv"), read("risks.csv"), read("conflict-types.md"), read("jurisdiction_rules.csv")];
  const jurisdictionRules: JurisdictionRule[] = table(jrCsv).filter((r) => r.risk_id).map((r) => ({ jurisdiction: r.jurisdiction, risk_id: r.risk_id, note: r.note, source: r.source_to_verify, status: r.status }));
  const titles = new Map(fs.existsSync(path.join(dir, "risk_titles.csv")) ? table(read("risk_titles.csv")).map((r) => [r.id, r.title] as [string, string]) : []);
  // English table: set OUTPUT_LANG=English to use config/risks_en.csv for risk text, prompts, fixes and titles.
  const en = /^en/i.test(process.env.OUTPUT_LANG ?? "") && fs.existsSync(path.join(dir, "risks_en.csv"))
    ? new Map(table(read("risks_en.csv")).map((r) => [r.id, r] as [string, Record<string, string>])) : new Map<string, Record<string, string>>();
  const risks: Risk[] = table(risksCsv).filter((r) => r.id).map((r) => {
    const ct = r.check_type as CheckType;
    if (!["presence", "conflict", "cross_doc", "mechanical"].includes(ct)) throw new Error(`risks.csv ${r.id}: bad check_type ${r.check_type}`);
    return { id: r.id, topic: r.topic, applies_to: r.applies_to.split(/[;,]/).map((s) => s.trim()).filter(Boolean),
      risk: en.get(r.id)?.risk || r.risk, prompt: en.get(r.id)?.prompt || r.prompt, output_if_found: en.get(r.id)?.output_if_found || r.output_if_found, check_type: ct, evidence: r.evidence_in_examples, jurisdiction_dependent: /^(yes|да|true|1)$/i.test(r.jurisdiction_dependent ?? ""), title: en.get(r.id)?.title || titles.get(r.id) || r.risk };
  });
  const agents: Agent[] = table(topicsCsv).filter((r) => r.topic).map((r) => ({
    topic: r.topic, description: r.description, watch_for: r.watch_for, risk_topics: r.risk_topics.split(";").map((s) => s.trim()).filter(Boolean),
  }));
  // every non-mechanical risk must belong to exactly one agent
  const owner = new Map<string, string>();
  for (const a of agents) for (const t of a.risk_topics) owner.set(t, owner.has(t) ? "DUP" : a.topic);
  for (const r of risks) if (r.check_type !== "mechanical" && (!owner.has(r.topic) || owner.get(r.topic) === "DUP"))
    throw new Error(`risks.csv ${r.id}: topic "${r.topic}" is not assigned to exactly one agent in topics.csv`);
  const conflictTypes = [...md.matchAll(/^## (\w+)\s*$/gm)].map((m) => m[1]);
  if (!conflictTypes.length) throw new Error("conflict-types.md: no '## type' sections found");
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
  const validatorMd = read("validator_prompt.md");
  const files = { "validator_prompt.md": sha(validatorMd), "topics.csv": sha(topicsCsv), "risks.csv": sha(risksCsv), "conflict-types.md": sha(md), "jurisdiction_rules.csv": sha(jrCsv) };
  return { agents, risks, jurisdictionRules, conflictTypesMd: md, validatorMd, conflictTypes, files, hash: sha(Object.values(files).join()) };
}

export const applies = (r: Risk, tags: string[]) => r.applies_to.includes("all") || r.applies_to.some((t) => tags.includes(t));
