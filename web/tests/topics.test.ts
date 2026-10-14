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
