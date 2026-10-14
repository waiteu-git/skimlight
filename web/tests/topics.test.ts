import assert from "node:assert/strict";
import { test } from "node:test";

import { type Block, detect } from "../src/core/detect.ts";
import { otherAudience, TOPICS, topicStatus } from "../src/core/topics.ts";

const T = new Date(Date.UTC(2026, 9, 12));
const p = (text: string): Block => ({ type: "p", text });
const topic = (id: string) => TOPICS.find((t) => t.id === id)!;
const noHead = () => false;

test("論点の3値", () => {
  const ss = detect([
    p("応募は日本国内にお住まいの方に限ります。"),
    p("応募期間は2026年9月10日から2026年12月8日23:59までです。"),
    p("デプロイナウで公開した作品のみ応募できます。"),
  ], T);
  assert.equal(topicStatus(topic("eligibility"), ss, noHead).status, "引用あり");
  assert.equal(topicStatus(topic("deadline"), ss, noHead).status, "引用あり");
  assert.equal(topicStatus(topic("published"), ss, noHead).status, "引用あり"); // 「のみ」は要件の言い方＝例外に数えない
  const exc = detect([p("公開した作品も応募できます。ただし、他のコンテストで受賞した作品を除きます。")], T);
  assert.equal(topicStatus(topic("published"), exc, noHead).status, "要確認");
  assert.equal(topicStatus(topic("ai"), ss, noHead).status, "引用なし");
  const noTime = detect([p("応募締切は2026年12月8日です。")], T);
  assert.equal(topicStatus(topic("deadline"), noTime, noHead).status, "要確認");
});

test("締切の論点は、締切として拾った文も含める（語が「まで」だけの文）", () => {
  const ss = detect([{ type: "h3", text: "応募期間" }, p("作品概要：2026年11月15日(日) 23:59 まで")], T);
  assert.equal(topicStatus(topic("deadline"), ss, (s) => s.block === 0).status, "引用あり");
});

test("論点の文の直後のただし書きも論点に含める", () => {
  const ss = detect([p("同じ作品を他のコンテストへ応募することは禁止します。ただし、学内の授業で発表した作品は除きます。")], T);
  const r = topicStatus(topic("published"), ss, noHead);
  assert.equal(r.sentences.length, 2);
  assert.equal(r.status, "要確認");
});

test("よくある質問は、問いに続く答えも論点に含める", () => {
  const ss = detect([p("AIで作った作品も応募できますか"), p("ご応募いただけます。ただし、第三者の権利を侵害しないでください。"), p("費用はかかりますか")], T);
  const r = topicStatus(topic("ai"), ss, noHead);
  assert.equal(r.status, "要確認");
  assert.equal(r.sentences.length, 3); // 問い＋答えの2文（次の問いで止まる）
});

test("ほかの立場向けの文だけを薄くする", () => {
  const [team, minor, both] = detect([p("チームの場合は代表者が応募してください。"), p("未成年の方は保護者の同意が必要です。"),
    p("個人でもチームで参加でも応募できます。")], T);
  assert.equal(otherAudience(team, { party: "solo" }), true);
  assert.equal(otherAudience(team, { party: "team" }), false);
  assert.equal(otherAudience(team, {}), false);
  assert.equal(otherAudience(minor, { age: "adult" }), true);
  assert.equal(otherAudience(minor, { age: "minor" }), false);
  assert.equal(otherAudience(both, { party: "solo" }), false); // 自分の立場も含む文は薄くしない
});

test("ただし書きの語：「ただしく」「もっとも重視」「障壁を除くために」「社会的除外」「特例的」は例外ではない（10/19）", async () => {
  const { WEB_EXCEPTION } = await import("../src/core/topics.ts");
  const has = (t: string) => new RegExp(WEB_EXCEPTION.source, "u").test(t);
  for (const t of ["ただしく入力してください。", "応募動機はもっとも重視される項目です。", "障壁を除くために創設されました。", "社会的除外や孤立を防ぐ。", "特例的な物価高騰を受け"]) assert.ok(!has(t), t);
  for (const t of ["ただし、1回に限る。", "もっとも、例外がある。", "学生を除く。", "天災などやむを得ない事由がある場合に承認します。"]) assert.ok(has(t), t);
});

test("論点の語：言い換えの文も拾う（10/19 Geminiの意地悪な文：在籍・毎月○円・源泉徴収・肖像・手数料・Midjourney）", async () => {
  const { detect } = await import("../src/core/detect.ts");
  const { topicsFor, topicStatus, markAmounts } = await import("../src/core/topics.ts");
  const hit = (kind: "contest" | "scholarship" | "grant", id: string, text: string) => {
    const ss = detect([{ type: "p", text }], new Date(Date.UTC(2026, 9, 19)));
    markAmounts(ss, kind);
    return topicStatus(topicsFor(kind).find((t) => t.id === id)!, ss, () => false).sentences.length > 0;
  };
  assert.ok(hit("contest", "eligibility", "国内の大学院に籍を置く学生に限ります。"));
  assert.ok(hit("contest", "documents", "学生証の写しをマイページへアップロードしてください。"));
  assert.ok(hit("scholarship", "amount", "採用された方には毎月5万円を振り込みます。"));
  assert.ok(hit("scholarship", "income", "主たる生計維持者の源泉徴収票の支払金額が500万円未満であること。"));
  assert.ok(hit("contest", "rights", "第三者の肖像を使用する場合は、事前に承諾を得てください。"));
  assert.ok(hit("contest", "ai", "MidjourneyやStable Diffusionによる素材の流用は失格となります。"));
  assert.ok(hit("contest", "cost", "審査事務手数料として1点につき2,000円をお振込みください。"));
});
