import { z } from "zod";

export const STATUSES = ["conflict", "needs_review", "no_conflict", "insufficient_data"] as const;
export const ROLES = ["claim", "mechanic", "exception", "definition", "reference"] as const;

/** Final output schema (types are validated against config/conflict-types.md at runtime). */
export const QuoteSchema = z.object({ text: z.string(), location: z.string(), role: z.enum(ROLES) });
export const ConflictSchema = z.object({
  conflictId: z.string(),
  topic: z.string(),
  type: z.string(),
  status: z.enum(STATUSES),
  quotes: z.array(QuoteSchema),
  explanation: z.string(),
  reconcileNote: z.string(),
  suggestedFix: z.string(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

/** What a topic subagent returns (before code-level quote verification). */
export const makeFindingsSchema = (types: string[]) =>
  z.object({
    findings: z.array(
      z.object({
        type: z.enum(types as [string, ...string[]]),
        status: z.enum(["conflict", "insufficient_data"]),
        quotes: z.array(z.object({ text: z.string(), role: z.enum(ROLES) })).min(1).max(2),
        explanation: z.string(),
        suggestedFix: z.string(),
      }),
    ),
  });
export type Finding = z.infer<ReturnType<typeof makeFindingsSchema>>["findings"][number];

export const VerdictSchema = z.object({
  reconcilable: z.boolean(),
  reconcileNote: z.string(),
});

export const MergeSchema = z.object({
  clusters: z.array(z.object({ members: z.array(z.number().int()), representative: z.number().int() })),
});
