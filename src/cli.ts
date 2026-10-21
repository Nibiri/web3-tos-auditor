import { loadConfig } from "./config.js";
import { auditDocument, writeResult } from "./pipeline.js";

const file = process.argv[2];
if (!file) { console.error("usage: npm run audit -- <file.pdf|file.docx>"); process.exit(2); }
const cfg = loadConfig();
const r = await auditDocument(file, cfg, (s) => console.error("·", s));
const dir = writeResult(r);
console.log(JSON.stringify({ document: r.document, conflicts: r.conflicts }, null, 2));
console.error(`\nSaved to ${dir} (cost $${r.audit.totalCostUsd.toFixed(3)}, ${r.audit.toolCalls.length} tool calls)`);
