import { loadConfig } from "./config.js";
import { auditDocument, writeResult } from "./pipeline.js";

const file = process.argv[2];
if (!file) { console.error("usage: npm run audit -- <file.pdf|file.docx>"); process.exit(2); }
const cfg = loadConfig();
const r = await auditDocument(file, cfg, (s) => console.error("·", s));
const dir = writeResult(r);
const view = r.results.map((x) => `${x.riskId} ${x.statusRu.padEnd(20)} ${cfg.risks.find((r) => r.id === x.riskId)?.title ?? x.risk}${x.quotes[0] ? `\n     «${x.quotes[0].text.slice(0, 110)}» (${x.quotes[0].location})` : ""}`);
console.log(`${r.document}: ${r.profile.projectType} [${r.profile.tags.join(",")}]\n${view.join("\n")}`);
console.error(`\nSaved to ${dir} (cost $${r.audit.totalCostUsd.toFixed(3)}, ${r.audit.toolCalls.length} tool calls)`);
