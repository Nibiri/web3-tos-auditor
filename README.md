# tos-auditor (step 1: terminal pipeline)

Finds contradictions inside Web3 Terms of Service. Node 20+, TypeScript, Claude Agent SDK, zod. Needs `pdftotext` (poppler) and `pandoc`.

    npm install
    npm run audit -- examples/Bad_ToS_3.docx   # one file, JSON to stdout, files to out/<run>/
    npm run eval                                # all files in examples/, table + false-conflict count
    npm test                                    # verify_quote unit tests

Flow: parse (src/parse.ts) -> one sub-agent per topic in config/topics.csv (src/prompts.ts builds prompts from config/) -> code-level `verify_quote` on every quote (unverified or <2 distinct quotes = dropped) -> merge duplicates -> verifier tries to reconcile each conflict (reconcilable = needs_review, else conflict).
Each agent only sees the document through 4 MCP tools: list_sections, read_section, search_document, verify_quote.

Outputs per run in out/<runId>/: `<doc>.result.json` (schema output + dropped candidates with reasons) and `<doc>.audit.json` (config hash, model, timings, cost, every tool call).

Env: AUDITOR_MODEL (default claude-sonnet-5-5), OUTPUT_LANG (default Russian), CONCURRENCY (eval, default 2), EXAMPLES_DIR.
Expected files: `examples/<name>.expected.json` = `{"conflicts":[{"id","anchors":[[sideA fragments],[sideB fragments]]}]}`.

## Browser version

`artifact/tos-auditor.html` is the same pipeline as a single page (paste text or upload PDF/DOCX/TXT). It was published as a Claude artifact and runs on the viewer's own Claude account.
