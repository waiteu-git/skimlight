import assert from "node:assert/strict";
import { test } from "node:test";

import { type Block, detect } from "../src/core/detect.ts";
import { pickWatchouts } from "../src/core/watchouts.ts";
import { SAMPLE_BLOCKS } from "../src/core/sample.ts";

const T = new Date(Date.UTC(2026, 9, 18));
const p = (text: string): Block => ({ type: "p", text });

test("見落としやすい文：食い違いを先に、次に印のあるただし書き、最大3つ", () => {
  const blocks = [
    p("応募締切は2026年12月8日（火）23:59です。"),
    p("ただし、学内の授業で発表した作品は除きます。"),
    p("作品は1人3点まで応募できます。ただし、チームの場合は1点に限ります。"),
    p("なお、応募締切は2026年12月10日です。"),
    p("詳しくは事務局にお問い合わせください。"),
  ];
  const ss = detect(blocks, T);
  const w = pickWatchouts(ss, () => false);
  assert.ok(w.length <= 3);
  assert.equal(w[0].reason, "食い違い");
  assert.ok(w.some((x) => x.reason === "ただし書き"));
  // 同じ食い違いの組は1つだけ出す
  assert.equal(w.filter((x) => x.reason === "食い違い").length, 1);
});

test("見本の要項では、見落としやすい文が1つ以上出る", () => {
  const ss = detect(SAMPLE_BLOCKS, T);
  assert.ok(pickWatchouts(ss, () => false).length >= 1);
});

test("見出しとただし書きの無い文は出さない", () => {
  const ss = detect([{ type: "h2", text: "ただし書きについて" }, p("作品を提出してください。")], T);
  assert.deepEqual(pickWatchouts(ss, (s) => s.block === 0), []);
});

test("「授業料の免除」「得意な領域以外も」はただし書きにしない（10/18）", () => {
  const ss = detect([p("授業料・入学金の免除・減額は各大学等に確認してください。"), p("いま自分が得意とする領域以外も積極的に学べる力を重視します。"), p("ただし、学生でなくなった場合は実費負担です。")], T);
  assert.deepEqual(pickWatchouts(ss, () => false).map((w) => w.sid), [2]);
});

test("窓口の受付時間の「土日祝を除く」と「以外」は、ただし書きにしない（10/19）", () => {
  const ss = detect([p("（注釈）持参の場合の受付は、8時30分から17時15分まで（土曜日・日曜日祝日・年末年始を除く）"), p("奨学金を借り受けているのが本人以外（親など）の場合は、対象になりますか。"), p("ただし、入社日から3か月までに事前申請する必要があります。")], T);
  assert.deepEqual(pickWatchouts(ss, () => false).map((w) => w.sid), [2]);
});
