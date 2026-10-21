import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface Topic { topic: string; description: string; watch_for: string }
export interface Config {
  topics: Topic[];
  conflictTypesMd: string;
  conflictTypes: string[];
  hash: string;
  files: Record<string, string>;
}

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, newlines inside quotes). */
export function parseCsv(src: string): string[][] {
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

export function loadConfig(dir = path.resolve("config")): Config {
  const csvPath = path.join(dir, "topics.csv");
  const mdPath = path.join(dir, "conflict-types.md");
  const csv = fs.readFileSync(csvPath, "utf8");
  const md = fs.readFileSync(mdPath, "utf8");
  const [header, ...rows] = parseCsv(csv);
  const idx = (k: string) => {
    const i = header.indexOf(k);
    if (i < 0) throw new Error(`topics.csv: missing column ${k}`);
    return i;
  };
  const [t, d, w] = [idx("topic"), idx("description"), idx("watch_for")];
  const topics = rows.map((r) => ({ topic: r[t].trim(), description: r[d].trim(), watch_for: r[w].trim() }));
  const conflictTypes = [...md.matchAll(/^## (\w+)\s*$/gm)].map((m) => m[1]);
  if (!conflictTypes.length) throw new Error("conflict-types.md: no '## type' sections found");
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
  return {
    topics,
    conflictTypesMd: md,
    conflictTypes,
    hash: sha(sha(csv) + sha(md)),
    files: { "topics.csv": sha(csv), "conflict-types.md": sha(md) },
  };
}
