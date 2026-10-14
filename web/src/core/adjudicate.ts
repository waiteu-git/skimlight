/**
 * 3値（引用あり／引用なし／要確認）を決める唯一の場所。CLI（ruleaudit/adjudicate.py）の移植。
 * 「適合」「当たる」とは言わない。決めるのは本人。
 */
import { findTerms, matchQuote, termSentences, type QuoteMatch } from "./quotes.ts";

export const QUOTED = "引用あり";
export const NO_QUOTE = "引用なし";
export const REVIEW = "要確認";
export type Status = typeof QUOTED | typeof NO_QUOTE | typeof REVIEW;

export const REASONS: Record<string, string> = {
  NO_SNAPSHOT: "原文がありません",
  QUOTE_NOT_FOUND: "引用が原文に見つかりません（言い換え・転記ミス・変更の疑い）。原文を確かめてください",
  QUOTE_TOO_SHORT: "引用が短すぎて照合できません",
  QUALIFIER_OUTSIDE: "引用の前後に、条件・例外・否定の語があります。文の全体を読んでください",
  QUALIFIER_WITH_CHECK: "引用に条件・例外の語があり、値の並べでは扱いきれません",
  SITUATION_MISSING: "状況に値がありません",
  OUT_OF_RANGE: "あなたの値が、条件から外れて見えます。原文と値を確かめてください",
  UNCOMPARABLE: "あなたの値と条件の型が合わず、並べられません",
  DEADLINE_PASSED: "締切を過ぎています",
  TERM_PRESENT: "「記載なし」としたが、関連する語が原文にあります。該当箇所を読んでください",
};

export interface Check { field: string; op: string; value?: unknown; as_of?: string; label?: string }
export interface Requirement {
  id: string; kind: string; topic: string; source: string; quote: string | null;
  check?: Check | null; deadline?: string | null; absent_terms?: string[]; note?: string;
}
export interface Finding {
  reqId: string; topic: string; kind: string; status: Status; reasons: string[]; notes: string[];
  quote: string | null; sentence: string; match?: QuoteMatch;
}

type Situation = Record<string, unknown>;

export function get(situation: Situation, dotted: string): unknown {
  let cur: unknown = situation;
  for (const key of dotted.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !(key in (cur as object))) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur ?? null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" || !ISO.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
}

function yearsBetween(born: Date, asOf: Date): number {
  const before = asOf.getUTCMonth() < born.getUTCMonth() ||
    (asOf.getUTCMonth() === born.getUTCMonth() && asOf.getUTCDate() < born.getUTCDate());
  return asOf.getUTCFullYear() - born.getUTCFullYear() - (before ? 1 : 0);
}

const sameKind = (a: unknown, b: unknown) =>
  (typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string");

/** "in" / "out" / "missing" / "uncomparable"。 */
export function compare(check: Check, situation: Situation): "in" | "out" | "missing" | "uncomparable" {
  const { op, value: want } = check;
  const have = get(situation, check.field);
  if (have === null) return "missing";
  let ok: boolean;
  switch (op) {
    case "age_at_most":
    case "age_at_least": {
      const born = parseDate(have);
      const asOf = parseDate(check.as_of);
      if (!born || !asOf || typeof want !== "number") return "uncomparable";
      const age = yearsBetween(born, asOf);
      ok = op === "age_at_most" ? age <= want : age >= want;
      break;
    }
    case "in": case "not_in":
      if (!Array.isArray(want)) return "uncomparable";
      ok = want.includes(have) === (op === "in");
      break;
    case "contains":
      if (typeof have === "string" && typeof want === "string") ok = have.includes(want);
      else if (Array.isArray(have)) ok = have.includes(want);
      else return "uncomparable";
      break;
    case "is_true": ok = have === true; break;
    case "is_false": ok = have === false; break;
    case "==": ok = have === want; break;
    case "!=": ok = have !== want; break;
    case "<=": case "<": case ">=": case ">": {
      if (!sameKind(have, want)) return "uncomparable";
      const a = have as number | string, b = want as number | string;
      ok = op === "<=" ? a <= b : op === "<" ? a < b : op === ">=" ? a >= b : a > b;
      break;
    }
    default: return "uncomparable";
  }
  return ok ? "in" : "out";
}

export function adjudicate(req: Requirement, doc: string | null, situation: Situation, today: Date): Finding {
  const f: Finding = { reqId: req.id, topic: req.topic, kind: req.kind, status: REVIEW, reasons: [], notes: [], quote: req.quote, sentence: "" };
  if (doc === null) { f.reasons.push("NO_SNAPSHOT"); return f; }
  if (req.quote === null) {
    const present = findTerms(req.absent_terms ?? [], doc);
    if (present.length) {
      f.reasons.push("TERM_PRESENT");
      f.notes.push(...termSentences(present, doc));
    } else {
      f.status = NO_QUOTE;
    }
    return f;
  }
  const m = matchQuote(req.quote, doc);
  f.match = m;
  if (!m.ok) { f.reasons.push(m.reason === "TOO_SHORT" ? "QUOTE_TOO_SHORT" : "QUOTE_NOT_FOUND"); return f; }
  f.sentence = m.sentence;
  if (m.qualifiersOutside.length) f.reasons.push("QUALIFIER_OUTSIDE");
  if (req.check) {
    if (m.conditionsInside.length) f.reasons.push("QUALIFIER_WITH_CHECK");
    const r = compare(req.check, situation);
    if (r === "missing") f.reasons.push("SITUATION_MISSING");
    else if (r === "out") f.reasons.push("OUT_OF_RANGE");
    else if (r === "uncomparable") f.reasons.push("UNCOMPARABLE");
  }
  if (req.deadline) {
    const d = parseDate(req.deadline);
    if (d && d.getTime() < today.getTime()) f.reasons.push("DEADLINE_PASSED");
  }
  if (!f.reasons.length) f.status = QUOTED;
  return f;
}
