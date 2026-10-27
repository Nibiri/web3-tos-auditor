# tos-auditor (step 1: terminal pipeline)

Finds contradictions inside Web3 Terms of Service. Node 20+, TypeScript, Claude Agent SDK, zod. Needs `pdftotext` (poppler) and `pandoc`.

    npm install
    npm run audit -- examples/Bad_ToS_3.docx   # one file, JSON to stdout, files to out/<run>/
    npm run eval                                # all files in examples/, table + false-conflict count
    npm test                                    # verify_quote unit tests

Flow: parse (src/parse.ts) -> one sub-agent per topic in config/topics.csv (src/prompts.ts builds prompts from config/) -> code-level `verify_quote` on every quote (unverified or <2 distinct quotes = dropped) -> merge duplicates -> verifier tries to reconcile each conflict (reconcilable = needs_review, else conflict).
Each agent only sees the document through 4 MCP tools: list_sections, read_section, search_document, verify_quote.

Outputs per run in out/<runId>/: `<doc>.result.json` (schema output + dropped candidates with reasons) and `<doc>.audit.json` (config hash, model, timings, cost, every tool call).

Env: AUDITOR_MODEL (default claude-sonnet-5-5), OUTPUT_LANG (by default the report language follows the document; set it to force one; "English" also switches the risk table to config/risks_en.csv and the status labels), CONCURRENCY (eval, default 2), EXAMPLES_DIR.
Expected files: `examples/<name>.expected.json` = `{"conflicts":[{"id","anchors":[[sideA fragments],[sideB fragments]]}]}`.

## Labelling reference documents

Fill `examples/labels/labels_template.xlsx` (column `expected_status`: risk_found / no_risk / insufficient_data; several acceptable values as `risk_found|insufficient_data`; `clause` and `comment` are for humans). Then run `python3 scripts/import_labels.py examples/labels/labels_template.xlsx`: it writes `examples/<document>.expected.json`, which `npm run eval` compares against.

## Learning from the lawyer's ratings (few-shot, no fine-tuning)

Fine-tuning Claude is not available here, so the lawyer's ratings are used as data in the prompts.

    npm run dataset      # data/lawyer/raw/*.feedback.json -> data/lawyer/dataset.jsonl + split.json
    npm run eval:lawyer  # before/after on the holdout split (REPEATS=3 recommended)

- `data/lawyer/raw/<docKey>.feedback.json`: export of the lawyer artifact's `feedback` collection (one rating per risk: model status, lawyer verdict `correct`/`false_positive`, comment).
- `data/lawyer/overrides.json`: the right status for `false_positive` rows (the artifact does not store it). Entries marked `inferred` come from the lawyer's comment and need her confirmation.
- `data/lawyer/dataset.jsonl`: one row per rated risk: risk, quotes, model status, lawyer verdict, comment, `gold_status`, `split`.
- `data/lawyer/split.json`: frozen train/holdout split (about 30% holdout, stratified). New rows never move existing ones; `--holdout-doc <Document>` sends a whole new document to holdout.
- `src/fewshot.ts`: puts up to 2 verified examples per risk into that risk's block of the agent prompt (corrections first). Examples from the document being audited are never shown. `FEWSHOT=off|train|all` (default `all`); the example ids are part of the config hash in the audit file.
- Limits: one labelled document so far, so the holdout is small and the test is weak; it shows transfer of the calibration, not accuracy on new documents. The real test is: label the next document (examples/labels), run `npm run dataset -- --holdout-doc <it>`, then `npm run eval:lawyer`.
