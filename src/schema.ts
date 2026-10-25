import { z } from "zod";

export const STATUSES = ["risk_found", "no_risk", "insufficient_data"] as const;
export type Status = (typeof STATUSES)[number];
const STATUS_LABELS = {
  en: { risk_found: "Risk found", no_risk: "No risk found", insufficient_data: "Insufficient data" },
  ru: { risk_found: "Риск выявлен", no_risk: "Риск не выявлен", insufficient_data: "Недостаточно данных" },
};
/** Labels follow OUTPUT_LANG at access time, because the language is chosen per document. */
export const STATUS_RU = new Proxy({} as Record<Status, string>, {
  get: (_, k: string) => STATUS_LABELS[/^en/i.test(process.env.OUTPUT_LANG ?? "") ? "en" : "ru"][k as Status],
});
export const ROLES = ["claim", "mechanic", "exception", "definition", "reference", "provision"] as const;

/** Final per-check result. */
export const QuoteSchema = z.object({ text: z.string(), location: z.string(), role: z.enum(ROLES) });
export const ResultSchema = z.object({
  riskId: z.string(),
  topic: z.string(),
  checkType: z.string(),
  risk: z.string(),
  status: z.enum(STATUSES),
  statusRu: z.string(),
  provisionFound: z.boolean(),
  conflictType: z.string().nullable(),
  quotes: z.array(QuoteSchema),
  explanation: z.string(),
  reconcileNote: z.string(),
  suggestedFix: z.string(),
  needsReview: z.boolean(),
  legalBasis: z.string().optional(),
  dupOf: z.string().optional(),
  immaterial: z.boolean().optional(),
});
export type Result = z.infer<typeof ResultSchema>;

/** Project profile detected before the checks run. */
export const ProfileSchema = z.object({
  tags: z.array(z.enum(["custodial", "yield"])),
  projectType: z.string(),
  jurisdiction: z.string(),
  jurisdictions: z.array(z.enum(["RU", "EU/EEA", "UK", "US"])),
  operator: z.string(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** What a check agent returns (before code-level quote verification). */
export const makeAgentSchema = (riskIds: string[], conflictTypes: string[]) =>
  z.object({
    results: z.array(
      z.object({
        riskId: z.enum(riskIds as [string, ...string[]]),
        status: z.enum(STATUSES),
        provisionFound: z.boolean(),
        conflictType: z.enum(["none", ...conflictTypes] as [string, ...string[]]),
        quotes: z.array(z.object({ text: z.string(), role: z.enum(ROLES) })).max(3),
        explanation: z.string(),
        suggestedFix: z.string(),
      }),
    ),
  });
export type AgentResult = z.infer<ReturnType<typeof makeAgentSchema>>["results"][number];

export const VerdictSchema = z.object({ reconcilable: z.boolean(), reconcileNote: z.string() });

export const ValidatorSchema = z.object({
  reviews: z.array(z.object({
    riskId: z.string(),
    verdict: z.enum(["confirm", "change_status", "duplicate", "immaterial"]),
    correctStatus: z.enum(STATUSES),
    legalBasis: z.string(),
    duplicateOf: z.string(),
    why: z.string(),
  })),
});

export const ConsistencySchema = z.object({
  fixes: z.array(z.object({ riskId: z.string(), correctStatus: z.enum(STATUSES), why: z.string() })),
});
