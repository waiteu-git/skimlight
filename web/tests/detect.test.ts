import assert from "node:assert/strict";
import { test } from "node:test";

import { type Block, detect, findDates, splitSentences } from "../src/core/detect.ts";

const T = new Date(Date.UTC(2026, 9, 12));
const p = (text: string): Block => ({ type: "p", text });
const labelsOf = (blocks: Block[]) => detect(blocks, T).map((s) => [s.text, s.labels]);

test("文の切れ目：社名の！・括弧の中の。・番号の．では切らない", () => {
  const ss = splitSentences([p("「ロリポップ！デプロイナウ」で公開したものに限ります。以下「作品等」（以下「作品等」といいます。）を使う。３． 年齢25才以下であること")]);
  assert.deepEqual(ss.map((s) => s.text), [
    "「ロリポップ！デプロイナウ」で公開したものに限ります。",
    "以下「作品等」（以下「作品等」といいます。）を使う。",
    "３． 年齢25才以下であること",
  ]);
  assert.deepEqual(splitSentences([p("お待ちしています！ぜひどうぞ。")]).map((s) => s.text), ["お待ちしています！ぜひどうぞ。"]);
  assert.deepEqual(splitSentences([p("お待ちしています！ ぜひどうぞ。")]).map((s) => s.text), ["お待ちしています！", "ぜひどうぞ。"]);
});

test("日付：年の補完・範囲の年またぎ・時刻", () => {
  assert.deepEqual(findDates("2026年9月10日（木）〜 12月8日（火）23:59", 2026).map((d) => [d.iso, d.time]), [["2026-09-10", undefined], ["2026-12-08", "23:59"]]);
  assert.deepEqual(findDates("12月20日〜1月10日", 2026).map((d) => d.iso), ["2026-12-20", "2027-01-10"]);
  assert.deepEqual(findDates("応募締切：2026.12.8（火）まで", 2026).map((d) => d.iso), ["2026-12-08"]);
  assert.deepEqual(findDates("締切 11/29 21時まで", 2026).map((d) => [d.iso, d.time]), [["2026-11-29", "21:00"]]);
  assert.deepEqual(findDates("13月40日", 2026), []);
});

test("5種類の検出", () => {
  const r = labelsOf([
    p("応募期間は2026年9月10日から2026年12月8日23:59までです。"),
    p("作品概要は100字以内で記入してください。"),
    p("他のコンテストとの二重応募は禁止します。"),
    p("応募者は本人であることが必須です。"),
    p("昨年度は約1,700人が参加しました。"),
    p("Q. 返済は必要ですか？"),
    p("受賞を無効とさせていただきます。"),
  ]);
  assert.deepEqual(r, [
    ["応募期間は2026年9月10日から2026年12月8日23:59までです。", ["deadline"]],
    ["作品概要は100字以内で記入してください。", ["required", "quantity"]],
    ["他のコンテストとの二重応募は禁止します。", ["prohibited"]],
    ["応募者は本人であることが必須です。", ["required"]],
    ["昨年度は約1,700人が参加しました。", []],
    ["Q. 返済は必要ですか？", []],
    ["受賞を無効とさせていただきます。", ["prohibited"]],
  ]);
});

test("見出しは塗らず、見出しの意味を箇条書きが受け継ぐ", () => {
  const ss = detect([
    { type: "h3", text: "応募が無効になる場合" },
    { type: "li", text: "応募作品が審査終了までに削除された場合" },
    { type: "h3", text: "応募資格" },
    { type: "li", text: "日本国内にお住まいの方" },
  ], T);
  assert.deepEqual(ss.map((s) => s.labels), [[], ["prohibited"], [], ["required"]]);
});

test("矛盾：同じ対象に違う締切日。月間・次回の締切は別の話", () => {
  const ss = detect([
    p("応募締切は2026年12月8日23:59です。"),
    p("応募期間：2026年9月10日〜2026年12月10日"),
    p("月間賞の次回の締切は、10月31日です。"),
  ], T);
  assert.ok(ss[0].labels.includes("conflict") && ss[1].labels.includes("conflict"));
  assert.deepEqual(ss[0].conflictWith, [1]);
  assert.ok(!ss[2].labels.includes("conflict"));
  const same = detect([p("応募締切：2026.12.8（火）まで"), p("応募期間は2026年9月10日から2026年12月8日23:59までです。")], T);
  assert.ok(same.every((s) => !s.labels.includes("conflict")));
});

test("立場：チーム・未成年・海外向けの文を見分ける", () => {
  const ss = detect([p("チームの場合は代表者が応募してください。"), p("未成年の方は保護者の同意を得てください。"), p("留学生の方は応募できません。")], T);
  assert.deepEqual(ss.map((s) => s.audiences), [["team"], ["minor"], ["overseas"]]);
});

test("実ページで見つけた誤りの型（10/12）", () => {
  const r = labelsOf([
    p("ご関心のある方は、お気軽にプレエントリーへご登録ください。"),
    p("特に、安全管理・法令遵守の点においては細心の注意を払い、環境を維持します。"),
    p("(PDF形式・1MB)"),
    p("作品紹介スライド（PDF形式・10ページ以内・10MB以内）"),
    p("ぜひご応募ください。応募には登録が必須です。"),
  ]);
  assert.deepEqual(r.map(([, l]) => l), [[], [], [], ["quantity"], [], ["required"]]); // 最後は「ぜひ…」と「必須です」の2文
  const cells = detect([{ type: "h3", text: "募集対象者" }, { type: "td", text: "対象大学" }, { type: "td", text: "日本の大学に在籍する大学生" }], T);
  assert.deepEqual(cells.map((x) => x.labels), [[], [], ["required"]]);
});

test("日程表の行：期間と「エントリー」の行は締切、審査会の行は締切にしない", () => {
  const ss = detect([p("2026年8月28日（金）～ 2026年11月19日（木） 本エントリー"), p("2026年12月5日（土）～ 2026年12月6日（日） 一次審査会")], T);
  assert.deepEqual(ss.map((s) => s.labels.includes("deadline")), [true, false]);
});
