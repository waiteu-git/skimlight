/**
 * PDF の文字の断片（pdf.js の getTextContent の items）を、行→段落・見出しのブロック列に組み直す。
 * pdf.js に依存しない純粋な関数（テストで固定する）。
 * - 行：同じ高さ（y が近い）の断片を左から並べる。hasEOL でも行を切る
 * - 段落：行の間が行の高さの 1.6 倍を超えたら切る。箇条書きの記号（・●①1.）で始まる行も切る
 * - 見出し：文字の大きさが本文の中央値の 1.18 倍以上で、40字以下の行
 * - 日本語の行の継ぎ目には空白を入れない（英数字どうしの時だけ空白）
 */
import type { Block } from "./detect.ts";

export interface PdfItem { str: string; x: number; y: number; size: number; eol?: boolean }
interface Line { text: string; y: number; size: number; page: number }

const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/u;
const BULLET = /^(?:[・●○■□◆◇▪︎•※]|[①-⑳]|[(（]?\d{1,2}[)）.．]|[(（]?[a-zA-Zア-ン][)）]|第\s*\d+\s*条)/u;

function joinText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const last = a[a.length - 1], first = b[0];
  return CJK.test(last) || CJK.test(first) || /\s$/.test(a) ? a + b : `${a} ${b}`;
}

export function linesOf(items: PdfItem[], page: number): Line[] {
  const lines: Line[] = [];
  let cur: { parts: PdfItem[]; y: number; size: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const parts = cur.parts.sort((p, q) => p.x - q.x);
    const text = parts.reduce((acc, p) => joinText(acc, p.str), "").replace(/\s+/g, " ").trim();
    if (text) lines.push({ text, y: cur.y, size: cur.size, page });
    cur = null;
  };
  for (const it of items) {
    if (!it.str && !it.eol) continue;
    const tol = Math.max(2, it.size * 0.45);
    if (cur && Math.abs(cur.y - it.y) > tol) flush();
    if (!cur) cur = { parts: [], y: it.y, size: it.size };
    if (it.str) { cur.parts.push(it); cur.size = Math.max(cur.size, it.size); }
    if (it.eol) flush();
  }
  flush();
  return lines;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** ページごとの行（上から順）をブロック列にする。 */
export function blocksFromLines(pages: Line[][]): Block[] {
  const all = pages.flat();
  const body = median(all.map((l) => l.size)) || 10;
  // 折り返した行は、ほぼ行の幅いっぱいまで文字がある。10字より長い行の字数の中央値を「1行の長さ」の目安にする
  const lineLen = median(all.map((l) => l.text.length).filter((n) => n > 10)) || 30;
  const blocks: Block[] = [];
  let para = "";
  let prev: Line | null = null;
  const flush = () => { const t = para.trim(); if (t) blocks.push({ type: "p", text: t }); para = ""; };
  for (const page of pages) {
    for (const l of page) {
      const heading = l.size >= body * 1.18 && l.text.length <= 40;
      const gap = prev && prev.page === l.page ? Math.abs(prev.y - l.y) : Infinity;
      // 前の行が文の終わり（。！？」）で終わっていなければ、行間が少し空いていても続きの行とみなす（日本語の PDF は行間が広いことがある）
      // ただし短い行（一覧・表の項目など）は、句点が無くても続きとはみなさない
      const continues = !!prev && !/[。．！？!?」』）)]$/u.test(prev.text) && prev.text.length >= lineLen * 0.7;
      const limit = Math.max(prev?.size ?? 0, l.size) * (continues ? 2.4 : 1.6);
      const newPara = !prev || prev.page !== l.page || gap > limit || BULLET.test(l.text);
      if (heading) {
        flush();
        blocks.push({ type: l.size >= body * 1.5 ? "h2" : "h3", text: l.text });
        prev = l;
        continue;
      }
      if (newPara) flush();
      para = joinText(para, l.text);
      prev = l;
    }
    flush(); // ページの境で段落を切る（ヘッダ・フッタの混入を段落に閉じ込める）
  }
  flush();
  return dropRepeated(blocks, pages.length);
}

/** 各ページに繰り返し出る短い行（ヘッダ・フッタ・ページ番号）を落とす。 */
function dropRepeated(blocks: Block[], pageCount: number): Block[] {
  if (pageCount < 3) return blocks.filter((b) => !/^[-–—\s]*\d{1,3}\s*(?:\/\s*\d{1,3})?[-–—\s]*$/.test(b.text));
  const count = new Map<string, number>();
  for (const b of blocks) if (b.text.length <= 40) count.set(b.text, (count.get(b.text) ?? 0) + 1);
  return blocks.filter((b) => !/^[-–—\s]*\d{1,3}\s*(?:\/\s*\d{1,3})?[-–—\s]*$/.test(b.text) && (count.get(b.text) ?? 0) < Math.ceil(pageCount * 0.6));
}
