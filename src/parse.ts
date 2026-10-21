import { execFileSync } from "node:child_process";
import path from "node:path";

export interface Section {
  id: string;
  title: string;
  page: number | null;
  text: string;
}
export interface ParsedDoc {
  name: string;
  file: string;
  sections: Section[];
}

interface Line { text: string; page: number | null }
interface Block { kind: "heading" | "para"; text: string; page: number | null }

const MAX_SECTION_CHARS = 8000;

function extractRaw(file: string): Line[] {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") {
    const out = execFileSync("pdftotext", [file, "-"], { maxBuffer: 256 * 1024 * 1024 }).toString("utf8");
    const lines: Line[] = [];
    out.split("\f").forEach((pg, i) => {
      for (const l of pg.split("\n")) lines.push({ text: l, page: i + 1 });
    });
    return lines;
  }
  if (ext === ".docx") {
    const out = execFileSync("pandoc", [file, "-t", "plain", "--wrap=none"], { maxBuffer: 256 * 1024 * 1024 }).toString("utf8");
    return out.split("\n").map((text) => ({ text, page: null }));
  }
  throw new Error(`Unsupported file type: ${file}`);
}

const clean = (s: string) => s.replace(/^#{1,6}\s+/, "").replace(/[​‌‍⁠﻿]/g, "").replace(/ /g, " ").replace(/[ \t]+/g, " ").trim();

const CLAUSE_START = /^\d+(\.\d+)+\.?\s+\S/; // 3.2. text / 3.2 text
const PART_HEADING = /^(ЧАСТЬ|PART|ARTICLE|SECTION|APPENDIX|ПРИЛОЖЕНИЕ)\s+[IVX\d]+/i;
const NUMBERED = /^\d{1,2}(\.\d{1,2})*\.?\s+\p{Lu}/u;

function isHeading(t: string): boolean {
  if (!t) return false;
  if (PART_HEADING.test(t) && t.length < 120) return true;
  if (NUMBERED.test(t) && t.length <= 80 && !/[.;,:!?]$/.test(t)) return true;
  return false;
}

/** Group raw lines into headings and paragraphs. */
function toBlocks(lines: Line[], isPdf: boolean): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let prevLen = 0;
  const flush = () => { if (cur) blocks.push(cur); cur = null; };
  for (const raw of lines) {
    const t = clean(raw.text);
    if (!t) { flush(); prevLen = 0; continue; }
    if (/^(page\s*)?\d{1,3}(\s*(of|\/)\s*\d{1,3})?$/i.test(t)) continue; // page numbers
    const marked = /^#{1,6}\s+\S/.test(raw.text.trim());
    if (marked || isHeading(t)) {
      flush();
      blocks.push({ kind: "heading", text: t, page: raw.page });
      prevLen = 0;
      continue;
    }
    const startsNew =
      CLAUSE_START.test(t) || /^([-•*]|\(\w\))\s/.test(t) || /^TL;DR/i.test(t) ||
      // PDF hard-wrap: a short previous line means the paragraph ended
      (isPdf && cur !== null && prevLen > 0 && prevLen < 70 && /[.:;!?»”"]$/.test((cur as Block).text));
    if (cur && !startsNew && isPdf) {
      (cur as Block).text += " " + t;
    } else if (cur && !startsNew && !isPdf) {
      (cur as Block).text += " " + t;
    } else {
      flush();
      cur = { kind: "para", text: t, page: raw.page };
    }
    prevLen = t.length;
  }
  flush();
  return blocks;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "section";

function chunkParas(paras: string[]): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > MAX_SECTION_CHARS) { chunks.push(cur); cur = ""; }
    cur = cur ? cur + "\n\n" + p : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Parse PDF/DOCX into sections. Ids come from position + title, never from the document's own numbering. */
export function parseDocument(file: string): ParsedDoc {
  const isPdf = path.extname(file).toLowerCase() === ".pdf";
  const blocks = toBlocks(extractRaw(file), isPdf);

  // Top-level grouping: a heading starts a new section; sub-numbered headings (1.1) merge into the parent
  // section to avoid hundreds of tiny sections, except when no parent exists yet.
  type Raw = { title: string; page: number | null; paras: string[] };
  const raws: Raw[] = [{ title: "Preamble", page: blocks[0]?.page ?? null, paras: [] }];
  for (const b of blocks) {
    if (b.kind === "heading") {
      const sub = /^\d{1,2}\.\d/.test(b.text) && !/^appendix/i.test(b.text);
      if (sub && raws.length > 1) { raws[raws.length - 1].paras.push(b.text); continue; }
      raws.push({ title: b.text, page: b.page, paras: [] });
    } else raws[raws.length - 1].paras.push(b.text);
  }

  const sections: Section[] = [];
  let pos = 0;
  for (const r of raws) {
    if (!r.paras.length) continue;
    pos++;
    const baseId = `s${String(pos).padStart(2, "0")}-${slug(r.title)}`;
    const chunks = chunkParas(r.paras);
    chunks.forEach((text, i) => {
      sections.push({
        id: chunks.length > 1 ? `${baseId}.p${i + 1}` : baseId,
        title: chunks.length > 1 ? `${r.title} (part ${i + 1}/${chunks.length})` : r.title,
        page: r.page,
        text,
      });
    });
  }
  return { name: path.basename(file).replace(/\.[^.]+$/, ""), file, sections };
}
