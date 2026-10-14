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
// 「免除」は「授業料の免除」のように恩恵の名前で使われることが多い＝ただし書きの語から外した（10/18 実ページ）。「以外も」は範囲を広げる言い方なので外す
// 「以外」は「本人以外」「メールアドレス以外」のように範囲を言うだけのことが多い＝外した（10/19）。窓口の受付時間の「土日祝・年末年始を除く」も数えない
export const WEB_EXCEPTION = /ただし(?![いくさ])|但し(?![いくさ])|(?<!(?:祝日|祝祭日|年末年始|休日|閉庁日)を?)(?:除く(?!ため|よう|こと|目的)|除き|除いて)|(?<!社会的)除外|例外|特例(?!子会社|的)|適用除外|この限りで|(?<=^|[。．])もっとも(?=[、,])|やむを得な/gu;

/** 「引用なし」の意味（画面・規約・応募文で同じ言い方にする） */
export const NO_QUOTE_MEANING = "読み取った文章に、関連する文が見つかりませんでした。条件が無いという意味ではありません。";

// money＝金額の論点（金額に数量の線が引かれた文を、言い方に関係なく入れる）
export interface Topic { id: string; q: string; terms: RegExp; money?: boolean }
// 要項の種類ごとに出す論点。どの種類でも、応募資格・締切・提出書類を先に出す。
// 種類は本文の語から選ぶ（guessKind）。利用者が切り替えられる。合否の判定ではなく「どの論点の一覧を出すか」だけを決める。
export type Kind = "contest" | "scholarship" | "grant";
export const KIND_JA: Record<Kind, string> = { contest: "コンテスト・ハッカソン", scholarship: "奨学金", grant: "助成金・補助金" };
const COMMON: Topic[] = [
  { id: "eligibility", q: "応募資格・対象", terms: /応募資格|参加資格|応募条件|参加条件|申請条件|申請資格|要件|対象(?:者|となる|は)|(?:^|\n)(?:応募|参加|募集)?対象(?:者)?(?:\n|$)|在住|お住まい|在学|在籍|籍を置|年齢|\d+\s*[歳才]|生まれ(?:た|の)|国籍|どなたでも|(?:を|は|が)問わず|(?:者|方|学生|生徒|人|団体|法人|企業|事業者)(?:を|が|は)対象/u },
  { id: "deadline", q: "締切の日時", terms: /締切|締め切|〆切|期限|必着|応募期間|募集期間|受付期間|申込期間/u },
  { id: "documents", q: "提出書類", terms: /提出書類|必要書類|応募書類|申請書|推薦書|証明書|添付|提出物|提出(?:して|し)?ください|提出すること|アップロード|写し|成績表|所見|(?:登録|郵送)してください/u },
];
const SCHOLARSHIP: Topic[] = [
  { id: "amount", q: "給付額・期間", terms: /給付額|月額|年額|支給額|奨学金額|給付期間|支給期間|給付の内容|支援金|奨励金|給付金|毎月|一時金|最長\s*\d+\s*年/u, money: true },
  { id: "repay", q: "返還の有無", terms: /返還|返済|貸与|給付型|返還不要|返済不要/u },
  { id: "income", q: "家計・所得の基準", terms: /所得|収入|家計|世帯|住民税|非課税|源泉徴収|生計|生活保護|児童養護|経済(?:的|状況|状態)|年収|課税/u },
  { id: "grades", q: "成績の基準", terms: /成績|GPA|評定|学業|学力/u },
  { id: "combine", q: "他の奨学金との併用", terms: /併用|併給|重複(?:受給|して)|他の奨学金|他の給付/u },
  { id: "recommend", q: "推薦・学内選考", terms: /推薦|学校長|学内選考|学内締切|奨学金窓口|大学を通じ|所属(?:大学|学校)を通/u },
  { id: "duties", q: "採用後の義務", terms: /近況報告|報告書|交流会|面談|在籍(?:報告|確認)|採用後|奨学生の義務|継続(?:手続|申請)/u },
];
const GRANT: Topic[] = [
  { id: "grant-amount", q: "助成額・対象経費", terms: /助成(?:額|金額|上限)|補助(?:額|率|上限)|対象経費|経費|上限\s*\d|援助金の額|奨励金の額|支給額|(?:援助金|奨励金|助成金|補助金)として/u, money: true },
  { id: "period", q: "対象期間", terms: /助成期間|実施期間|事業期間|対象期間|研究期間/u },
  { id: "report", q: "報告・成果の公開", terms: /報告書|実績報告|成果(?:の|を)?(?:報告|公表|公開|発表)|公表/u },
  { id: "overlap", q: "他の助成との重複", terms: /重複|併願|他の助成|他の補助|二重/u },
];
const CONTEST: Topic[] = [
  { id: "team", q: "1人・チームの扱い", terms: /個人|チーム|グループ|共同制作|1人|一人|ひとり|\d+\s*名(?:まで|以内|以上)/u },
  { id: "published", q: "公開済み・既存の作品", terms: /公開(?:した|された|済|中)|既存|未発表|発表済|オリジナル|前に(?:作|公開)|二重|重複|他のコンテスト|併願/u },
  { id: "ai", q: "生成AIの利用", terms: /生成\s*AI|AI|ChatGPT|人工知能|画像生成|自動(?:作成|生成)|Midjourney|Stable\s*Diffusion|大規模言語モデル|LLM/u },
  { id: "rights", q: "作品の権利", terms: /著作権|知的財産|権利.{0,6}(?:帰属|譲渡|取得)|利用許諾|二次利用|所有権|版権|肖像|無償で(?:掲載|利用|使用)|承諾を得/u },
  { id: "minor", q: "未成年の扱い", terms: /未成年|保護者|18歳未満|20歳未満/u },
  { id: "cost", q: "費用", terms: /費用|料金|無料|有料|参加費|応募料|かかりません|負担|手数料|送料|郵送代|金銭的/u },
];
const SETS: Record<Kind, Topic[]> = { contest: [...COMMON, ...CONTEST], scholarship: [...COMMON, ...SCHOLARSHIP], grant: [...COMMON, ...GRANT] };
export const topicsFor = (k: Kind): Topic[] => SETS[k];
/** 今までの呼び方（コンテストの組） */
export const TOPICS: Topic[] = SETS.contest;

/** 奨学金・助成金では、給付額・助成額などの金額の文に「数量」の印を付ける（コンテストの賞金は付けない＝賞の一覧が印だらけになるため） */
export function markAmounts(ss: Sentence[], kind: Kind, blocks?: Array<{ type: string; text: string }>): void {
  if (kind === "contest") return;
  const rate = /補助率|助成率|\d+\s*[%％]\s*(?:以内|以下|を上限)|\d+\s*[/／]\s*\d+\s*(?:以内|以下)|(?:\d+|[一二三四五六七八九十]+)\s*分の\s*(?:\d+|[一二三四五六七八九十]+)/u;
  const label = /月額|年額|給付額|支給額|貸与額|補助(?:上限)?額|補助限度額|助成(?:金)?額|助成上限|上限額|限度額|金額|助成金の額|補助金の額|基礎単価|単価|一律/u;
  const money = /\d[\d,.]*\s*(?:万|千)?\s*(?:円|ドル)/u;
  const benefit = /加算|増額|上乗せ|[/／]\s*(?:月|年)|給付|支給|貸与|奨学金|支援金|奨励金|助成|補助|月額|年額|上限|対象経費|経費|毎月|一時金|振り込|送金|生活費/u;
  for (const s of ss) {
    const t = s.text.normalize("NFKC");
    // 問いの文（FAQ の「上限20万円は補助額のことですか？」）には付けない
    if (money.test(t) && benefit.test(t) && !/賞金|副賞|賞品/u.test(t) && !/[？?]\s*$/u.test(t) && !s.labels.includes("quantity")) s.labels.push("quantity");
    // 補助率（「補助率：3分の2」「対象経費の50％以内」）
    if (rate.test(t) && /\d/u.test(t) && /補助|助成|対象経費|経費/u.test(t) && !/[？?]\s*$/u.test(t) && !(blocks?.[s.block].type ?? "").startsWith("h") && !s.labels.includes("quantity")) s.labels.push("quantity");
    // 金額の上限・下限（「最大10万円」「税抜単価1万円以上」「世帯収入が800万円以下」）
    if (/\d[\d,.]*\s*(?:万|千)?\s*円\s*(?:以内|以下|未満|以上|を超え|まで)|(?:最大|上限|限度)\s*(?:額)?\s*(?:は|が|で|:|：)?\s*\d[\d,.]*\s*(?:万|千)?\s*円/u.test(t) && !/賞金|副賞|賞品/u.test(t) && !/[？?]\s*$/u.test(t) && !(blocks?.[s.block].type ?? "").startsWith("h") && !s.labels.includes("quantity")) s.labels.push("quantity");
    // 値だけの升目（「月額｜30,000円」「補助上限額｜75万円」「3分の1」）：直前の項目名（dt・th・短い行）から、何の金額かを受け継ぐ。項目名が近くに無い巨大な表（施設ごとの単価の羅列）は付けない
    if (blocks && !s.labels.includes("quantity") && !blocks[s.block].type.startsWith("h") && t.trim().length <= 30) {
      const tt = t.trim();
      if (/^(?:補助率\s*[:：]?\s*)?(?:\d+|[一二三四五六七八九十]+)\s*分の\s*(?:\d+|[一二三四五六七八九十]+)(?:\s*以内)?$/u.test(tt)) s.labels.push("quantity");
      else if (/^※?\s*(?:約|最大|上限|一律)?\s*\d[\d,.]*\s*(?:万|千)?\s*(?:円|ドル)(?:[^。]{0,12})?$/u.test(tt)) {
        for (let k = s.block - 1; k >= Math.max(0, s.block - 4); k--) {
          const b = blocks[k];
          if ((b.type === "dt" || b.type === "th" || b.type.startsWith("h") || b.text.trim().length <= 16) && label.test(b.text.normalize("NFKC"))) { s.labels.push("quantity"); break; }
          // 間にある短い升目（「大学院生」「38,000円」）は飛ばして、さらに前の項目名を探す
          if (b.text.trim().length > 20) break;
        }
      }
    }
  }
}

/** 本文の語の数から要項の種類を選ぶ。手がかりが無い時はコンテストの組 */
export function guessKind(ss: Sentence[]): Kind {
  const text = ss.map((s) => s.text).join("\n").normalize("NFKC");
  const n = (re: RegExp) => (text.match(re) ?? []).length;
  const score: Record<Kind, number> = {
    scholarship: n(/奨学|育英|給付型|貸与型|奨学生/gu),
    grant: n(/助成|補助金|公募要領|研究費|交付申請|対象経費/gu),
    contest: n(/コンテスト|ハッカソン|応募作品|作品|賞金|受賞|審査員/gu),
  };
  // 奨学金・助成金の語が、コンテストの語より多い時だけその組にする
  const other: Kind = score.scholarship >= score.grant ? "scholarship" : "grant";
  return score[other] > score.contest ? other : "contest";
}

export interface TopicResult { topic: Topic; status: Status; sentences: Sentence[]; reasons: string[] }

/** 文ごとの節の見出し（直前の見出しの文）。論点の語が見出しにある時、その下の文も論点に入れるために使う */
export function headingsOf(ss: Sentence[], blocks: Array<{ type: string; text: string }>): (s: Sentence) => string | null {
  const at = new Map<number, string | null>();
  let cur: string | null = null;
  let from = 0;
  blocks.forEach((b, bi) => {
    if (b.type.startsWith("h")) { cur = b.text; from = bi; }
    // ページの末尾（お問い合わせ・関連リンクなど）と、見出しから離れすぎた所では、見出しの範囲を止める
    else if (/^(?:お問い?合わせ|問い?合わせ先|関連(?:情報|リンク|ページ)|このページ|ページの先頭|Copyright|©)/u.test(b.text.trim())) cur = null;
    // 表やdivの「項目名｜値」（「対象｜大学生・大学院生…」）：直前の短い項目名も、その値の見出しとして見る
    const prev = blocks[bi - 1];
    const label = prev && !prev.type.startsWith("h") && prev.text.trim().length <= 8 && !/[。．、\d]/u.test(prev.text) ? prev.text.trim() : null;
    const h = cur && bi - from <= 10 ? cur : null;
    at.set(bi, label ? (h ? `${label}\n${h}` : label) : h);
  });
  return (s) => (blocks[s.block].type.startsWith("h") ? null : at.get(s.block) ?? null);
}

const MONEY = /\d[\d,.]*\s*(?:万|千)?\s*円/u;

export function topicStatus(topic: Topic, ss: Sentence[], isHeading: (s: Sentence) => boolean, headingOf?: (s: Sentence) => string | null): TopicResult {
  const direct = ss.filter((s) => {
    if (isHeading(s)) return false;
    const t = s.text.normalize("NFKC");
    // 項目名だけの文（「対象」「参加費」）は引かない＝続く値の文が、項目名を見出しとして引かれる
    if (headingOf && t.trim().length <= 8 && !/[。．\d]/u.test(t)) return false;
    if (topic.terms.test(t)) return true;
    if (topic.id === "deadline" && s.labels.includes("deadline")) return true;
    if (topic.money && s.labels.includes("quantity") && MONEY.test(t)) return true;
    const h = headingOf?.(s);
    return !!h && topic.terms.test(h.normalize("NFKC"));
  });
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
