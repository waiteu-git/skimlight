/**
 * 論点ごとの3値と、自分の立場による「薄くする条項」の決め方（コードだけで決める）。
 *   引用あり：その論点に関わる文が在る（文を並べる）
 *   引用なし：関わる語が1つも見つからなかった（条件が無いという意味ではない＝規約 第2条と同じ言い方）
 *   要確認  ：関わる文に例外の語（ただし・除く・以外…）がある、食い違いがある、締切に時刻が無い
 * 条件の語（場合・とき…）だけでは要確認にしない：Web は文を丸ごと並べるので「切り取り」が起きない（CLI との違い）。
 * どれも「当たる／当たらない」は言わない。
 */
import { NO_QUOTE, QUOTED, REVIEW, type Status } from "./adjudicate.ts";
import { type Audience, isQuestion, type Sentence } from "./detect.ts";
// 見落とすと困る「例外」の語。「限ります」「のみ」は要件そのものの言い方なので、ここでは数えない。
export const WEB_EXCEPTION = /ただし|但し|除く|除き|除いて|除外|以外|例外|特例|免除|適用除外|この限りで|もっとも/gu;

/** 「引用なし」の意味（画面・規約・応募文で同じ言い方にする） */
export const NO_QUOTE_MEANING = "読み取った文章に、関連する文が見つかりませんでした。条件が無いという意味ではありません。";

export interface Topic { id: string; q: string; terms: RegExp }
export const TOPICS: Topic[] = [
  { id: "eligibility", q: "応募資格・対象", terms: /応募資格|参加資格|応募条件|参加条件|対象(?:者|となる|は)|在住|お住まい|在学|年齢|\d+\s*[歳才]/u },
  { id: "deadline", q: "締切の日時", terms: /締切|締め切|〆切|期限|必着|応募期間|募集期間|受付期間|申込期間/u },
  { id: "team", q: "1人・チームの扱い", terms: /個人|チーム|グループ|共同制作|1人|一人|ひとり|\d+\s*名(?:まで|以内|以上)/u },
  { id: "published", q: "公開済み・既存の作品", terms: /公開(?:した|された|済|中)|既存|未発表|発表済|オリジナル|前に(?:作|公開)|二重|重複|他のコンテスト|併願/u },
  { id: "ai", q: "生成AIの利用", terms: /生成\s*AI|AI|ChatGPT|人工知能/u },
  { id: "rights", q: "作品の権利", terms: /著作権|知的財産|権利.{0,6}(?:帰属|譲渡|取得)|利用許諾|二次利用/u },
  { id: "minor", q: "未成年の扱い", terms: /未成年|保護者|18歳未満|20歳未満/u },
  { id: "cost", q: "費用", terms: /費用|料金|無料|有料|参加費|応募料|かかりません/u },
];

export interface TopicResult { topic: Topic; status: Status; sentences: Sentence[]; reasons: string[] }

export function topicStatus(topic: Topic, ss: Sentence[], isHeading: (s: Sentence) => boolean): TopicResult {
  const direct = ss.filter((s) => !isHeading(s) &&
    (topic.terms.test(s.text.normalize("NFKC")) || (topic.id === "deadline" && s.labels.includes("deadline"))));
  // よくある質問：問いに語が出たら、続く答えの文（次の問い・見出しまで・3文まで）も含める
  const ids = new Set(direct.map((s) => s.id));
  for (const q of direct.filter(isQuestion)) {
    for (let k = q.id + 1, n = 0; k < ss.length && n < 3; k++, n++) {
      if (isHeading(ss[k]) || isQuestion(ss[k])) break;
      ids.add(ss[k].id);
    }
  }
  // ただし書き：論点の文の直後に「ただし・但し・なお・もっとも」で始まる文があれば含める（同じブロックの中だけ）
  for (const d of direct) {
    const next = ss[d.id + 1];
    if (next && next.block === d.block && /^(?:ただし|但し|なお|もっとも)/u.test(next.text)) ids.add(next.id);
  }
  const hits = ss.filter((s) => ids.has(s.id));
  if (!hits.length) return { topic, status: NO_QUOTE, sentences: [], reasons: [NO_QUOTE_MEANING] };
  const reasons: string[] = [];
  if (hits.some((s) => s.labels.includes("conflict"))) reasons.push("食い違う記述があります");
  const exc = [...new Set(hits.flatMap((s) => [...s.text.matchAll(WEB_EXCEPTION)].map((m) => m[0])))];
  if (exc.length) reasons.push(`例外の語があります（${exc.slice(0, 4).join("・")}）`);
  if (topic.id === "deadline" && !hits.some((s) => s.dates.some((d) => d.time))) reasons.push("時刻が書かれていません");
  return { topic, status: reasons.length ? REVIEW : QUOTED, sentences: hits, reasons };
}

// --- 自分の立場 -----------------------------------------------------------------------------------
export interface Profile {
  role?: "student" | "worker";
  party?: "solo" | "team";
  age?: "minor" | "adult";
  home?: "domestic" | "overseas";
}

/** この文が「ほかの立場向け」か（＝薄くしてよいか）。分からない時は薄くしない。 */
export function otherAudience(s: Sentence, p: Profile): boolean {
  const a = new Set<Audience>(s.audiences);
  if (!a.size) return false;
  const not: Audience[] = [];
  if (p.party === "solo") not.push("team");
  if (p.party === "team") not.push("solo");
  if (p.age === "adult") not.push("minor");
  if (p.home === "domestic") not.push("overseas");
  if (p.role) not.push("corp");
  // 文が向く立場のどれかが自分に当てはまるなら薄くしない（「チームでも個人でも」）
  const mine: Audience[] = [];
  if (p.party) mine.push(p.party);
  if (p.age === "minor") mine.push("minor");
  if (p.home === "overseas") mine.push("overseas");
  if (p.role) mine.push(p.role);
  if (mine.some((m) => a.has(m))) return false;
  return [...a].some((x) => not.includes(x));
}
