import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ParsedDoc } from "./parse.js";
import { normText } from "./normalize.js";
import { verifyQuote } from "./verify.js";

export interface ToolCallRecord {
  agent: string;
  tool: string;
  input: unknown;
  ok: boolean;
  at: string;
}

const text = (obj: unknown) => ({ content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) }] });

export const DOC_TOOL_NAMES = [
  "mcp__doc__list_sections",
  "mcp__doc__read_section",
  "mcp__doc__search_document",
  "mcp__doc__verify_quote",
];

/** One MCP server per agent run, bound to one document. Every call is appended to `log`. */
export function createDocServer(doc: ParsedDoc, agent: string, log: ToolCallRecord[]) {
  const rec = (name: string, input: unknown, ok: boolean) =>
    log.push({ agent, tool: name, input, ok, at: new Date().toISOString() });

  return createSdkMcpServer({
    name: "doc",
    version: "0.1.0",
    tools: [
      tool("list_sections", "List all sections of the document: id, title, page, length in characters.", {}, async () => {
        rec("list_sections", {}, true);
        return text(doc.sections.map((s) => ({ id: s.id, title: s.title, page: s.page, chars: s.text.length })));
      }),
      tool("read_section", "Read the full text of one section by id (ids come from list_sections).", { id: z.string() }, async ({ id }) => {
        const s = doc.sections.find((x) => x.id === id);
        rec("read_section", { id }, !!s);
        if (!s) return { ...text(`Unknown section id: ${id}. Call list_sections.`), isError: true };
        return text(`# ${s.title}${s.page ? ` (page ${s.page})` : ""}\n\n${s.text}`);
      }),
      tool(
        "search_document",
        "Case-insensitive search. Matches the phrase first; if none, paragraphs containing all words. Returns up to 8 snippets with section ids.",
        { q: z.string() },
        async ({ q }) => {
          const hits: { section_id: string; title: string; snippet: string }[] = [];
          const needle = normText(q);
          const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2).map(normText).filter(Boolean);
          const paras = doc.sections.flatMap((s) => s.text.split("\n\n").map((p) => ({ s, p, n: normText(p) })));
          let matched = needle ? paras.filter((x) => x.n.includes(needle)) : [];
          if (!matched.length && words.length) matched = paras.filter((x) => words.every((w) => x.n.includes(w)));
          for (const m of matched.slice(0, 8)) {
            hits.push({ section_id: m.s.id, title: m.s.title, snippet: m.p.length > 400 ? m.p.slice(0, 400) + "…" : m.p });
          }
          rec("search_document", { q }, true);
          return text(hits.length ? hits : "No matches.");
        },
      ),
      tool(
        "verify_quote",
        "Check that a quote really occurs in the document (comparison ignores case, spaces, hyphens, punctuation). Returns verified, location and the exact text.",
        { text: z.string() },
        async (args) => {
          const r = verifyQuote(doc, args.text);
          rec("verify_quote", { text: args.text.slice(0, 200) }, r.verified);
          return text(r);
        },
      ),
    ],
  });
}
