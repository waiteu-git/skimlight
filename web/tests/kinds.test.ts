import assert from "node:assert/strict";
import { test } from "node:test";

import { type Block, detect } from "../src/core/detect.ts";
import { guessKind, topicsFor } from "../src/core/topics.ts";
import { SAMPLE_BLOCKS, SCHOLARSHIP_BLOCKS } from "../src/core/sample.ts";

const T = new Date(Date.UTC(2026, 9, 19));
const p = (text: string): Block => ({ type: "p", text });

test("要項の種類を本文の語から選ぶ（判定ではなく、出す論点の組を選ぶだけ）", () => {
  assert.equal(guessKind(detect(SAMPLE_BLOCKS, T)), "contest");
  assert.equal(guessKind(detect(SCHOLARSHIP_BLOCKS, T)), "scholarship");
  assert.equal(guessKind(detect([p("2027年度 研究助成 公募要領"), p("助成金額は1件あたり上限100万円です。"), p("対象経費は物品費と旅費です。")], T)), "grant");
  assert.equal(guessKind(detect([p("お問い合わせはこちら")], T)), "contest"); // 手がかりが無い時はコンテストの組
});

test("種類ごとの論点：共通の3つに、種類ごとの論点が続く", () => {
  const ids = (k: Parameters<typeof topicsFor>[0]) => topicsFor(k).map((t) => t.id);
  assert.deepEqual(ids("scholarship").slice(0, 3), ["eligibility", "deadline", "documents"]);
  for (const id of ["amount", "repay", "income", "grades", "combine", "recommend", "duties"]) assert.ok(ids("scholarship").includes(id), id);
  assert.ok(!ids("scholarship").includes("ai"));
  assert.ok(ids("contest").includes("team") && ids("contest").includes("ai"));
  for (const id of ["grant-amount", "period", "report", "overlap"]) assert.ok(ids("grant").includes(id), id);
});

test("奨学金・助成金では、給付額・助成額の文に数量の印を付ける（コンテストの賞金には付けない）", async () => {
  const { markAmounts } = await import("../src/core/topics.ts");
  const blocks = [p("給付額は月額4万円、給付期間は2年間です。"), p("助成金額は1件あたり上限100万円です。"), p("グランプリ 賞金100万円")];
  const sch = detect(blocks, T); markAmounts(sch, "scholarship");
  assert.deepEqual(sch.map((s) => s.labels.includes("quantity")), [true, true, false]);
  const con = detect(blocks, T); markAmounts(con, "contest");
  assert.deepEqual(con.map((s) => s.labels.includes("quantity")), [false, false, false]);
});

test("論点：金額に数量の線が引かれた文は金額の論点に入る・見出しに論点の語があればその下の文も入る（10/19 千代田区）", async () => {
  const { markAmounts, topicsFor, topicStatus, headingsOf } = await import("../src/core/topics.ts");
  const blocks: Block[] = [
    { type: "h3", text: "対象者（申請条件）" },
    { type: "li", text: "区内に住所を有する方" },
    { type: "li", text: "障害者手帳をお持ちの方" },
    { type: "h3", text: "奨励金の額" },
    { type: "p", text: "1人1時間当たり200円を支給します。" },
    { type: "p", text: "お問い合わせ" },
    { type: "p", text: "電話番号：03-5211-4219" },
  ];
  const ss = detect(blocks, T);
  markAmounts(ss, "grant");
  const isH = (s: (typeof ss)[number]) => blocks[s.block].type.startsWith("h");
  const head = headingsOf(ss, blocks);
  const st = (id: string) => topicStatus(topicsFor("grant").find((t) => t.id === id)!, ss, isH, head);
  assert.equal(st("eligibility").status, "引用あり");
  assert.deepEqual(st("eligibility").sentences.map((s) => s.text), ["区内に住所を有する方", "障害者手帳をお持ちの方"]);
  assert.deepEqual(st("grant-amount").sentences.map((s) => s.text), ["1人1時間当たり200円を支給します。"]);
});

test("区の補助金ページ35件（10/19）で見つけた誤り", async () => {
  const { markAmounts } = await import("../src/core/topics.ts");
  const L = (text: string, kind: "grant" | "contest" = "grant") => { const ss = detect([p(text)], T); markAmounts(ss, kind); return ss[0].labels; };
  assert.ok(!L("【10月1日受付開始】東京都シルバーパスの購入費を助成します").includes("deadline"));
  assert.ok(!L("8.人材育成").includes("quantity"));
  assert.ok(!L("汎用機器の上限20万円は補助額のことですか、経費のことですか？").includes("quantity"));
  assert.ok(!L("↓（約1ヶ月） 助成決定・助成金額決定").includes("quantity"));
  // 正しく拾えている物はそのまま
  assert.ok(L("補助限度額：1商店会あたり20万円、2回まで。").includes("quantity"));
  assert.ok(L("申請者を含む２人以上の世帯員が移住元において、同一世帯に属していたこと。").includes("quantity"));
});

test("「項目名｜値」の値は、項目名を見出しとして論点に入る（10/19 東京AIハッカソン「対象｜大学生…」）", async () => {
  const { detect } = await import("../src/core/detect.ts");
  const { topicsFor, topicStatus, headingsOf } = await import("../src/core/topics.ts");
  const blocks = [{ type: "p" as const, text: "参加費" }, { type: "p" as const, text: "無料" }, { type: "p" as const, text: "対象" }, { type: "p" as const, text: "大学生・大学院生・高専生・専門学校生" }];
  const ss = detect(blocks, new Date(Date.UTC(2026, 9, 19)));
  const r = topicStatus(topicsFor("contest").find((t) => t.id === "eligibility")!, ss, () => false, headingsOf(ss, blocks));
  assert.deepEqual(r.sentences.map((s) => s.text), ["大学生・大学院生・高専生・専門学校生"]);
});
