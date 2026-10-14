/** 引用の逐語照合。CLI（ruleaudit/quotes.py）の移植。位置はコードポイント単位。 */
import { BLOCK_SEP, normalize, type Normalized } from "./textnorm.ts";
import { qualifiers } from "./vocab.ts";

export const MIN_QUOTE_CHARS = 8;
const SENTENCE_END = new Set(["。", "．", "！", "？", "!", "?", "\n", "\r", BLOCK_SEP]);
const STOPS = new Set(["。", "．", "！", "？", "!", "?"]);

export interface QuoteMatch {
  ok: boolean;
  reason: "VERIFIED" | "NOT_FOUND" | "TOO_SHORT" | "EMPTY";
  count: number;
  start: number;
  end: number;
  sentence: string;
  qualifiersOutside: string[];
  qualifiersInside: string[];
  conditionsInside: string[];
}

const fail = (reason: QuoteMatch["reason"]): QuoteMatch => ({
  ok: false, reason, count: 0, start: -1, end: -1, sentence: "", qualifiersOutside: [], qualifiersInside: [], conditionsInside: [],
});

/** 文の境界 [s, e)（コードポイントの配列の位置）。 */
export function sentenceBounds(cps: string[], start: number, end: number): [number, number] {
  let s = start;
  while (s > 0 && !SENTENCE_END.has(cps[s - 1])) s -= 1;
  let e = end;
  if (e > 0 && SENTENCE_END.has(cps[e - 1])) return [s, e];
  while (e < cps.length && !SENTENCE_END.has(cps[e])) e += 1;
  if (e < cps.length && STOPS.has(cps[e])) e += 1;
  return [s, e];
}

/** 正規化した文字の配列 hay の中で needle を探す（コードポイントの位置を返す）。 */
function findAll(hay: Normalized, needle: string[]): number[] {
  const out: number[] = [];
  const n = needle.length;
  if (!n) return out;
  const text = hay.text;
  const ntext = needle.join("");
  // 文字列の検索（コード単位）→ コードポイントの位置へ直す
  let cu = text.indexOf(ntext);
  if (cu < 0) return out;
  const cuToCp: number[] = [];
  let cp = 0;
  for (const ch of hay.chars) {
    for (let k = 0; k < ch.length; k++) cuToCp.push(cp);
    cp += 1;
  }
  while (cu >= 0) {
    out.push(cuToCp[cu]);
    cu = text.indexOf(ntext, cu + 1);
  }
  return out;
}

const trimPy = (s: string) => s.replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/gu, "");

export function matchQuote(quote: string | null | undefined, doc: string): QuoteMatch {
  if (!quote || !trimPy(quote)) return fail("EMPTY");
  const q = normalize(quote);
  if (q.chars.length < MIN_QUOTE_CHARS) return fail("TOO_SHORT");
  const d = normalize(doc);
  if (!d.consistent) return fail("NOT_FOUND");
  const hits = findAll(d, q.chars);
  if (!hits.length) return fail("NOT_FOUND");
  const first = hits[0];
  const cps = Array.from(doc);
  const start = d.starts[first];
  const end = d.ends[first + q.chars.length - 1];
  if (cps.slice(start, end).includes(BLOCK_SEP)) return fail("NOT_FOUND");
  const [ss, se] = sentenceBounds(cps, start, end);
  const sentence = trimPy(cps.slice(ss, se).join(""));
  const insideText = cps.slice(start, end).join("");
  const outsideText = cps.slice(ss, start).join("") + "　" + cps.slice(end, se).join("");
  const inside = qualifiers(insideText);
  const outside = qualifiers(outsideText).filter((w) => !inside.includes(w));
  return {
    ok: true, reason: "VERIFIED", count: hits.length, start, end, sentence,
    qualifiersOutside: outside, qualifiersInside: inside, conditionsInside: qualifiers(insideText, false),
  };
}

export function findTerms(terms: string[], doc: string): string[] {
  const d = normalize(doc).text;
  return terms.filter((t) => {
    const nt = normalize(t).text;
    return nt.length > 0 && d.includes(nt);
  });
}

export function termSentences(terms: string[], doc: string, limit = 3): string[] {
  const d = normalize(doc);
  const cps = Array.from(doc);
  const out: string[] = [];
  for (const t of terms) {
    const nt = normalize(t);
    if (!nt.chars.length) continue;
    for (const pos of findAll(d, nt.chars)) {
      if (out.length >= limit) break;
      const [s, e] = sentenceBounds(cps, d.starts[pos], d.ends[pos + nt.chars.length - 1]);
      const sent = trimPy(cps.slice(s, e).join(""));
      if (!out.includes(sent)) out.push(sent);
    }
  }
  return out.slice(0, limit);
}
