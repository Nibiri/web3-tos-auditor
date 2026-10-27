import { test } from "node:test";
import assert from "node:assert/strict";
import { fewshotBlock, selectExamples, type Example } from "./fewshot.js";

const ex = (o: Partial<Example>): Example => ({
  id: "d:R-01", document: "Doc_A", doc_context: "bot", risk_id: "R-01", quotes: ["some quote"], model_status: "risk_found",
  lawyer_verdict: "correct", lawyer_comment: "", gold_status: "risk_found", gold_source: "agreed", dup_of: "", split: "train", ...o,
});

test("train mode drops holdout rows, all mode keeps them", () => {
  const rows = [ex({ id: "a", split: "holdout" }), ex({ id: "b", risk_id: "R-02" })];
  assert.deepEqual(selectExamples(rows, "train").map((e) => e.id), ["b"]);
  assert.equal(selectExamples(rows, "all").length, 2);
  assert.equal(selectExamples(rows, "off").length, 0);
});

test("rows without gold status or confirmed duplicates are not used", () => {
  const rows = [ex({ id: "a", gold_status: null }), ex({ id: "b", dup_of: "R-02" }), ex({ id: "c", lawyer_verdict: "false_positive", dup_of: "R-02", gold_status: "no_risk" })];
  assert.deepEqual(selectExamples(rows, "all").map((e) => e.id), ["c"]);
});

test("corrections come first and at most two examples per risk", () => {
  const rows = [ex({ id: "a" }), ex({ id: "b", lawyer_comment: "note" }), ex({ id: "c", lawyer_verdict: "false_positive", gold_status: "no_risk" })];
  assert.deepEqual(selectExamples(rows, "all").map((e) => e.id), ["c", "b"]);
});

test("examples from the audited document are not shown, unless allowed", () => {
  const rows = [ex({})];
  assert.equal(fewshotBlock("R-01", rows, "Doc_A"), "");
  assert.match(fewshotBlock("R-01", rows, "Doc_B"), /CONFIRMED risk_found/);
  assert.match(fewshotBlock("R-01", rows, "Doc_A", true), /some quote/);
  assert.equal(fewshotBlock("R-02", rows, "Doc_B"), "");
});

test("a rejected answer shows the lawyer's status and note", () => {
  const rows = [ex({ lawyer_verdict: "false_positive", gold_status: ["no_risk", "insufficient_data"], lawyer_comment: "not a violation" })];
  const t = fewshotBlock("R-01", rows, "Doc_B");
  assert.match(t, /REJECTED risk_found; correct status: no_risk or insufficient_data/);
  assert.match(t, /not a violation/);
});
