/**
 * 引用照合用の正規化と、正規化後の位置から原文の位置を復元する表。
 * CLI（ruleaudit/textnorm.py）の移植。位置はすべて「コードポイント」単位（Python の str と同じ）。
 * 同じ結果になることは test-vectors/normalize.json で固定している。
 */

export const BLOCK_SEP = "\u001e";
const ALWAYS_DROP = new Set(["*", "\\", "|", "`", "_"]);
const LINE_START_DROP = new Set([">", "#"]);
export const CELL_SEPARATORS = new Set(["|", "｜"]);
const LINE_BREAKS = new Set(["\n", "\r", " ", " ", "\x0b", "\x0c", "\x85", BLOCK_SEP]);
const EXTRA_IGNORABLE = new Set([0x034f, 0x115f, 0x1160, 0x3164, 0xffa0]);
const JAMO: Array<[number, number]> = [[0x1100, 0x11ff], [0xa960, 0xa97f], [0xd7b0, 0xd7ff]];
const CLUSTER_SOFT_CAP = 32;
// Python の str.isspace() が真になる文字（JS の \s とは違う＝U+FEFF を含めない・U+001C〜U+001F を含める）
const PY_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
const MARK = /\p{M}/u;
const CF_CC = /^[\p{Cf}\p{Cc}]$/u;

const nfkc = (s: string) => s.normalize("NFKC");

/**
 * 正準結合クラスが 0 でないか（Python の unicodedata.combining(ch) != 0）。JS に直接の API が無いので、
 * 結合クラス 240（最大級）の U+0345 の後ろに置いて NFD をかけ、前へ並べ替えられたら 0 でないと判定する。
 * クラス 0 の文字は並べ替えで動かない。
 */
const cccCache = new Map<string, boolean>();
function hasCombiningClass(ch: string): boolean {
  const hit = cccCache.get(ch);
  if (hit !== undefined) return hit;
  const x = Array.from(ch.normalize("NFD"))[0] ?? ch;
  const probe = ("a\u0345" + x).normalize("NFD");
  const r = !probe.endsWith(x) || (x === "\u0345");
  cccCache.set(ch, r);
  return r;
}
const isSpace = (ch: string) => PY_SPACE.has(ch.codePointAt(0)!);

const inertCache = new Map<string, boolean>();
function inert(ch: string): boolean {
  const hit = inertCache.get(ch);
  if (hit !== undefined) return hit;
  const o = ch.codePointAt(0)!;
  let r: boolean;
  if (o < 0x80) r = true;
  else if (MARK.test(ch) || hasCombiningClass(ch)) r = false;
  else if (JAMO.some(([a, b]) => a <= o && o <= b)) r = false;
  else r = nfkc(ch) === ch;
  inertCache.set(ch, r);
  return r;
}

function isStarter(ch: string): boolean {
  const first = Array.from(ch.normalize("NFKD"))[0] ?? ch;
  return !hasCombiningClass(first);
}

/** NFKC が独立に決まる最小のかたまり [start, end)（コードポイントの位置）。 */
export function clusters(cps: string[]): Array<[number, number]> {
  const n = cps.length;
  const out: Array<[number, number]> = [];
  let start = 0;
  while (start < n) {
    let end = start + 1;
    while (end < n) {
      const c = cps[end];
      if (inert(c)) break;
      if (end - start < CLUSTER_SOFT_CAP && isStarter(c)) {
        const head = cps.slice(start, end).join("");
        if (nfkc(head + c) === nfkc(head) + nfkc(c)) break;
      }
      end += 1;
    }
    out.push([start, end]);
    start = end;
  }
  return out;
}

function isIgnorable(ch: string): boolean {
  if (CF_CC.test(ch)) return true;
  const o = ch.codePointAt(0)!;
  return EXTRA_IGNORABLE.has(o) || (o >= 0xfe00 && o <= 0xfe0f) || (o >= 0xe0100 && o <= 0xe01ef);
}

export interface Normalized {
  /** 正規化後の文字（コードポイントの配列） */
  chars: string[];
  text: string;
  starts: number[];
  ends: number[];
  gapAfter: number[];
  consistent: boolean;
}

/** spaced=false は空白を全部除いた照合用、true は空白を1つに畳み小文字にした語の走査用。 */
export function normalize(input: string, spaced = false): Normalized {
  const cps = Array.from(input);
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const gaps: number[] = [];
  const parts: string[] = [];
  let atLineStart = true;
  for (const [cs, ce] of clusters(cps)) {
    const raw = cps.slice(cs, ce).join("");
    const nf = ce - cs === 1 && raw.codePointAt(0)! < 0x80 ? raw : nfkc(raw);
    parts.push(nf);
    for (let ch of nf) {
      if (LINE_BREAKS.has(ch) || isSpace(ch)) {
        if (LINE_BREAKS.has(ch)) atLineStart = true;
        if (spaced) {
          if (out.length && out[out.length - 1] !== " ") {
            out.push(" "); starts.push(cs); ends.push(ce); gaps.push(0);
          }
        } else if (out.length) {
          gaps[gaps.length - 1] = 1;
        }
        continue;
      }
      if (ch === "|") {
        if (!spaced && out.length) gaps[gaps.length - 1] = 1;
        continue;
      }
      if (isIgnorable(ch) || ALWAYS_DROP.has(ch)) continue;
      if (LINE_START_DROP.has(ch) && atLineStart && !(ch === ">" && nfkc(cps[ce] ?? "") === "=")) continue;
      atLineStart = false;
      if (spaced) {
        const low = ch.toLowerCase();
        if (Array.from(low).length === 1) ch = low;
      }
      out.push(ch); starts.push(cs); ends.push(ce); gaps.push(0);
    }
  }
  return {
    chars: out,
    text: out.join(""),
    starts,
    ends,
    gapAfter: gaps,
    consistent: parts.join("") === nfkc(input),
  };
}
