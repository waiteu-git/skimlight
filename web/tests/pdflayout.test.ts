import assert from "node:assert/strict";
import { test } from "node:test";

import { blocksFromLines, linesOf, type PdfItem } from "../src/core/pdflayout.ts";

const it = (str: string, x: number, y: number, size = 10, eol = false): PdfItem => ({ str, x, y, size, eol });

test("行：同じ高さの断片を左から並べ、日本語の継ぎ目に空白を入れない", () => {
  const lines = linesOf([it("応募は", 50, 700), it("国内在住の方", 80, 700), it("に限ります。", 140, 700.5), it("Deploy", 50, 680), it("Now", 90, 680)], 1);
  assert.deepEqual(lines.map((l) => l.text), ["応募は国内在住の方に限ります。", "Deploy Now"]);
});

test("段落・見出し・箇条書き・ページ番号", () => {
  const p1 = linesOf([
    it("募集要項", 50, 760, 16, true),
    it("応募期間は2026年9月10日から", 50, 720, 10, true),
    it("12月8日までです。", 50, 707, 10, true),
    it("・作品は本人が制作したものに限ります。", 50, 680, 10, true),
    it("・未成年の方は保護者の同意が必要です。", 50, 667, 10, true),
    it("1", 300, 40, 9, true),
  ], 1);
  const blocks = blocksFromLines([p1]);
  assert.deepEqual(blocks, [
    { type: "h2", text: "募集要項" },
    { type: "p", text: "応募期間は2026年9月10日から12月8日までです。" },
    { type: "p", text: "・作品は本人が制作したものに限ります。" },
    { type: "p", text: "・未成年の方は保護者の同意が必要です。" },
  ]);
});

test("各ページに繰り返すヘッダを落とす", () => {
  const page = (n: number) => linesOf([it("○○財団 募集要項", 50, 800, 9, true), it(`本文${n}です。`, 50, 700, 10, true), it(`${n}`, 300, 40, 9, true)], n);
  const blocks = blocksFromLines([page(1), page(2), page(3)]);
  assert.deepEqual(blocks.map((b) => b.text), ["本文1です。", "本文2です。", "本文3です。"]);
});

test("文の途中で折り返した行は、行間が少し広くてもつなぐ（実物の要項 PDF・10/13）", () => {
  const lines = linesOf([
    it("公式サイト内の応募フォームより、以下の必要事項", 50, 700, 10, true),
    it("を入力・提出の上ご応募ください。", 50, 682, 10, true), // 行間 18＝文字の1.8倍
    it("● 作品タイトル", 50, 664, 10, true),
  ], 1);
  assert.deepEqual(blocksFromLines([lines]).map((b) => b.text), ["公式サイト内の応募フォームより、以下の必要事項を入力・提出の上ご応募ください。", "● 作品タイトル"]);
});

test("短い行（賞金の一覧など）は、句点が無くても続きとしてつながない", () => {
  const lines = linesOf([
    it("公式サイト内の応募フォームより、以下の必要事項", 50, 700, 10, true),
    it("を入力・提出の上ご応募ください。", 50, 682, 10, true),
    it("グランプリ", 50, 650, 10, true),
    it("1作品", 50, 632, 10, true),
    it("賞金100万円", 50, 614, 10, true),
  ], 1);
  assert.deepEqual(blocksFromLines([lines]).map((b) => b.text),
    ["公式サイト内の応募フォームより、以下の必要事項を入力・提出の上ご応募ください。", "グランプリ", "1作品", "賞金100万円"]);
});
