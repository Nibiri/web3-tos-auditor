import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ParsedDoc } from "./parse.js";
import { createDocServer, DOC_TOOL_NAMES, type ToolCallRecord } from "./tools.js";

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _omit, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export const MODEL = () => process.env.AUDITOR_MODEL || "claude-sonnet-5-5";

export interface RunStats { agent: string; costUsd: number; turns: number; durationMs: number }

/** One sub-agent run: own system prompt, own MCP tool server bound to the document, structured JSON output. */
export async function runAgent<S extends z.ZodType>(opts: {
  label: string;
  system: string;
  prompt: string;
  schema: S;
  doc: ParsedDoc;
  log: ToolCallRecord[];
  stats: RunStats[];
  maxTurns?: number;
}): Promise<z.infer<S>> {
  const server = createDocServer(opts.doc, opts.label, opts.log);
  const q = query({
    prompt: opts.prompt,
    options: {
      model: MODEL(),
      systemPrompt: opts.system,
      tools: [],
      mcpServers: { doc: server },
      allowedTools: DOC_TOOL_NAMES,
      settingSources: [],
      persistSession: false,
      maxTurns: opts.maxTurns ?? 40,
      outputFormat: { type: "json_schema", schema: jsonSchema(opts.schema) },
    },
  });
  for await (const m of q) {
    if (m.type !== "result") continue;
    opts.stats.push({ agent: opts.label, costUsd: m.total_cost_usd, turns: m.num_turns, durationMs: m.duration_ms });
    if (m.subtype !== "success" || m.is_error) throw new Error(`${opts.label}: agent failed (${m.subtype})`);
    return opts.schema.parse(m.structured_output);
  }
  throw new Error(`${opts.label}: no result message`);
}
