import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL } from "./agent.js";

/** True when a PDF has (almost) no text layer, i.e. it is a scan. */
export function isScannedPdf(file: string): boolean {
  if (path.extname(file).toLowerCase() !== ".pdf") return false;
  const text = execFileSync("pdftotext", [file, "-"], { maxBuffer: 256 * 1024 * 1024 }).toString("utf8");
  const pages = Math.max(1, Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [file]).toString())?.[1] ?? 1));
  return text.replace(/\s+/g, "").length / pages < 80;
}

const hasTesseract = () => spawnSync("tesseract", ["--version"]).status === 0;

/** Render pages to PNG, then recognize them: tesseract when installed, otherwise Claude vision (Read on the page image). */
export async function ocrPdf(file: string, onProgress: (s: string) => void = () => {}): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-"));
  execFileSync("pdftoppm", ["-r", "150", "-png", file, path.join(dir, "p")]);
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(dir, f));
  const out: string[] = [];
  const tess = hasTesseract();
  onProgress(`OCR: ${pages.length} page(s) via ${tess ? "tesseract" : "Claude vision"}`);
  for (const [i, img] of pages.entries()) {
    if (tess) {
      out.push(execFileSync("tesseract", [img, "-", "-l", process.env.OCR_LANGS || "eng+rus"], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8"));
      continue;
    }
    let text = "";
    for await (const m of query({
      prompt: `Read the image file ${img} with the Read tool and transcribe ALL text on the page exactly as written, in reading order, one paragraph per line. Keep clause numbers and headings. No commentary.`,
      options: { model: MODEL(), tools: ["Read"], allowedTools: ["Read"], settingSources: [], persistSession: false, maxTurns: 6, additionalDirectories: [dir] },
    })) if (m.type === "result" && m.subtype === "success") text = m.result;
    out.push(text);
    onProgress(`OCR: page ${i + 1}/${pages.length}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return out.join("\n\n");
}
