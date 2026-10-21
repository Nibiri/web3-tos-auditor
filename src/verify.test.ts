import test from "node:test";
import assert from "node:assert/strict";
import { verifyQuote } from "./verify.js";
import type { ParsedDoc } from "./parse.js";

const doc: ParsedDoc = {
  name: "t", file: "t",
  sections: [{
    id: "s01", title: "3. Custody", page: 2,
    text: "TL;DR: we never hold your funds at all, trust us completely.\n\n3.2. Deposited assets may be trans-\nferred to pooled addresses managed by the Company.\n\n3.3. Users retain exclu­sive control.",
  }],
};

test("matches despite hyphenation, case and glued spaces", () => {
  const r = verifyQuote(doc, "deposited assets may be transferred to POOLED addresses managed by the company");
  assert.equal(r.verified, true);
  assert.match(r.location!, /cl\. 3\.2/);
});
test("matches glued PDF words", () => {
  assert.equal(verifyQuote(doc, "Depositedassetsmaybetransferredtopooledaddresses").verified, true);
});
test("rejects TL;DR text", () => {
  const r = verifyQuote(doc, "we never hold your funds at all, trust us completely");
  assert.equal(r.verified, false);
  assert.match(r.reason!, /TL;DR/);
});
test("rejects invented and too-short quotes", () => {
  assert.equal(verifyQuote(doc, "The company holds all private keys of users forever").verified, false);
  assert.equal(verifyQuote(doc, "pooled").verified, false);
});
