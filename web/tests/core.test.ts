import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { adjudicate } from "../src/core/adjudicate.ts";
import { findTerms, matchQuote, termSentences } from "../src/core/quotes.ts";
import { normalize } from "../src/core/textnorm.ts";
import { qualifiers } from "../src/core/vocab.ts";

const vec = (name: string) => JSON.parse(readFileSync(new URL(`../test-vectors/${name}`, import.meta.url), "utf-8"));

test("正規化が CLI と一致する", () => {
  for (const c of vec("normalize.json")) {
    const n = normalize(c.input);
    assert.equal(n.text, c.text, JSON.stringify(c.input));
    assert.deepEqual(n.starts, c.starts, `starts: ${c.input}`);
    assert.deepEqual(n.ends, c.ends, `ends: ${c.input}`);
    assert.deepEqual(n.gapAfter, c.gap_after, `gap: ${c.input}`);
    assert.equal(n.consistent, c.consistent);
  }
});

test("逐語照合が CLI と一致する", () => {
  const v = vec("quotes.json");
  for (const c of v.cases) {
    const m = matchQuote(c.quote, v.doc);
    assert.deepEqual(
      [m.ok, m.reason, m.count, m.start, m.end, m.sentence, m.qualifiersOutside, m.qualifiersInside, m.conditionsInside],
      [c.ok, c.reason, c.count, c.start, c.end, c.sentence, c.qualifiers_outside, c.qualifiers_inside, c.conditions_inside],
      c.quote,
    );
  }
  for (const c of v.qualifiers) {
    assert.deepEqual(qualifiers(c.text), c.all, c.text);
    assert.deepEqual(qualifiers(c.text, false), c.no_negation, c.text);
  }
  for (const c of v.terms) {
    assert.deepEqual(findTerms(c.terms, v.doc), c.found);
    assert.deepEqual(termSentences(c.terms, v.doc), c.sentences);
  }
});

test("3値が CLI と一致する", () => {
  const v = vec("adjudicate.json");
  for (const c of v.cases) {
    const [y, m, d] = c.today.split("-").map(Number);
    const f = adjudicate(c.requirement, v.doc, c.situation, new Date(Date.UTC(y, m - 1, d)));
    assert.deepEqual([f.status, f.reasons], [c.status, c.reasons], c.name);
  }
});
