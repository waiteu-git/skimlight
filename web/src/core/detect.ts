/**
 * 要項の文を5種類（締切・必須・数量・禁止・矛盾）に塗り分ける検出器。規則ベース（モデルなし）。
 * 拾う単位は原文の「文」そのもの＝作り話が入り込む経路が無い。判定はしない（どの文に何が書いてあるかだけ）。
 */
import { normalize } from "./textnorm.ts";
import { qualifiers } from "./vocab.ts";

export type BlockType = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "li" | "th" | "td" | "dt" | "dd" | "caption";
export interface Block { type: BlockType; text: string; /** 表の行・リストなどのまとまり（描画用） */ group?: number }

export type Label = "deadline" | "required" | "quantity" | "prohibited" | "conflict";
export const LABELS: Label[] = ["required", "deadline", "quantity", "prohibited", "conflict"];
export const LABEL_JA: Record<Label, string> = { required: "必須", deadline: "締切", quantity: "数量", prohibited: "禁止", conflict: "食い違い" };
/** 印を押した時に出す一言（判定ではなく、何を拾ったかの説明） */
export const LABEL_HELP: Record<Label, string> = {
  required: "しなければならないこと（必須・〜すること・〜してください）を書いた文",
  deadline: "日付と「締切・まで・期限」などが一緒に書かれた文",
  quantity: "字数・枚数・人数・金額などの上限や下限、範囲を書いた文",
  prohibited: "してはいけないこと・無効になること・受け付けないことを書いた文",
  conflict: "同じ締切について、別の場所と違う日付が書かれた文（どちらが正しいかは原文で確かめてください）",
};
export const LABEL_MARK: Record<Label, string> = { required: "必", deadline: "締", quantity: "数", prohibited: "禁", conflict: "違" };

export interface DateHit { iso: string; time?: string; raw: string; yearGuessed: boolean }
export interface Sentence {
  id: number;
  block: number;
  /** ブロックの本文の中の位置（コード単位） */
  start: number;
  end: number;
  text: string;
  labels: Label[];
  dates: DateHit[];
  /** この文が向けられている立場（チーム・法人・未成年 など） */
  audiences: Audience[];
  /** 矛盾の相手の文 ID */
  conflictWith: number[];
  /** 条件・例外の語（要確認の材料） */
  qualifiers: string[];
}

// --- 文に分ける -----------------------------------------------------------------------------------
// 「。」と改行で切る。「！」「？」は後ろが空白・改行・終わり・閉じ括弧の時だけ切る（「ロリポップ！デプロイナウ」を切らない）。
// 括弧（「」『』（）()【】）の中では切らない（「（以下「応募作品等」といいます。）」を切らない）。
const OPEN = "「『（(【〔";
const CLOSE = "」』）)】〕";
const TRAIL = new Set([..."」』）)】〕"]);

function cutPoints(text: string): number[] {
  const cuts: number[] = [];
  let depth = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (OPEN.includes(c)) depth += 1;
    else if (CLOSE.includes(c)) depth = Math.max(0, depth - 1);
    if (c === "\n") { cuts.push(i + 1); depth = 0; continue; }
    if (depth > 0) continue;
    // 1つの段落につながった箇条（「… （１）15歳以上… （２）18歳未満…」「… ・居住 ・在学」）は、空白の後ろの番号・記号で切る
    if ((c === " " || c === "　") && i + 1 < n) {
      const seg = text.slice(cuts.length ? cuts[cuts.length - 1] : 0, i).trim();
      if (seg.length >= 8 && /^(?:[（(][\d０-９]{1,2}[）)]|[・●■◆])/u.test(text.slice(i + 1))) { cuts.push(i + 1); continue; }
    }
    let end = -1;
    // 「3．」「３．」「①.」のような番号の後ろでは切らない
    const sofar = text.slice(cuts.length ? cuts[cuts.length - 1] : 0, i).trim();
    const isNumbering = /^(?:[\d０-９]{1,3}|[①-⑳]|[a-zA-Z])$/u.test(sofar);
    if ((c === "。" || c === "．" || c === ".") && isNumbering) continue;
    if (c === "．" && /[\d０-９]/u.test(text[i - 1] ?? "") && /[\d０-９]/u.test(text[i + 1] ?? "")) continue;
    if (c === "。" || c === "．") end = i + 1;
    else if ("！？!?".includes(c)) {
      const nx = text[i + 1];
      if (nx === undefined || /\s/u.test(nx) || TRAIL.has(nx) || "！？!?。".includes(nx)) end = i + 1;
    }
    if (end > 0) {
      while (end < n && ("！？!?。".includes(text[end]) || TRAIL.has(text[end]))) end += 1;
      cuts.push(end);
      i = end - 1;
    }
  }
  if (!cuts.length || cuts[cuts.length - 1] !== n) cuts.push(n);
  return cuts;
}

export function splitSentences(blocks: Block[]): Sentence[] {
  const out: Sentence[] = [];
  blocks.forEach((b, bi) => {
    let prev = 0;
    for (const cut of cutPoints(b.text)) {
      const raw = b.text.slice(prev, cut);
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      if (text) {
        const start = prev + lead;
        out.push({ id: out.length, block: bi, start, end: start + text.length, text, labels: [], dates: [], audiences: [], conflictWith: [], qualifiers: [] });
      }
      prev = cut;
    }
  });
  return out;
}

// --- 日付 -----------------------------------------------------------------------------------------
// 文は NFKC をかけてから見る（全角数字・全角記号を半角に）。
const KNUM: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanjiNum(k: string): number {
  if (k === "元") return 1;
  if (k.includes("十")) { const [a, b] = k.split("十"); return (a ? KNUM[a] : 1) * 10 + (b ? KNUM[b] : 0); }
  return [...k].reduce((n, c) => n * 10 + KNUM[c], 0);
}
// 漢数字で書かれた日付（「令和八年十月二十三日」）は、算用数字の日付に直してから読む
const nf = (s: string) => s.normalize("NFKC").replace(/([〇一二三四五六七八九十元]{1,4})年([〇一二三四五六七八九十]{1,3})月([〇一二三四五六七八九十]{1,3})日/gu, (_m, y: string, mo: string, d: string) => `${kanjiNum(y)}年${kanjiNum(mo)}月${kanjiNum(d)}日`);
// 和暦（令和・平成）は西暦に直す（区や都の補助金のページは和暦で書く）
const ERA: Record<string, number> = { 令和: 2018, 平成: 1988 };
const DATE_PATTERNS: RegExp[] = [
  /(?<era>令和|平成)\s*(?<ey>元|\d{1,2})\s*年\s*(?<m>\d{1,2})\s*月\s*(?<d>\d{1,2})\s*日/gu,
  /(?<y>20\d{2})\s*年\s*(?<m>\d{1,2})\s*月\s*(?<d>\d{1,2})\s*日/gu,
  /(?<y>20\d{2})[./-](?<m>\d{1,2})[./-](?<d>\d{1,2})(?!\d)/gu,
  /(?<![\d./年])(?<m>\d{1,2})\s*月\s*(?<d>\d{1,2})\s*日/gu,
  // 「8月26（水曜日）」のように「日」が抜けて曜日が続く日付
  /(?<y>20\d{2})\s*年\s*(?<m>\d{1,2})\s*月\s*(?<d>\d{1,2})(?=\s*[（(]\s*[日月火水木金土])/gu,
  /(?<![\d./年])(?<m>\d{1,2})\s*月\s*(?<d>\d{1,2})(?=\s*[（(]\s*[日月火水木金土])/gu,
  // 「11月末まで」＝その月の最後の日
  /(?<![\d./毎])(?:(?<y>20\d{2})\s*年\s*)?(?<m>\d{1,2})\s*月\s*(?<last>末)日?/gu,
  // 「1/4以内」「2/3以上」は割合で、日付ではない
  /(?<![\d./])(?<m>\d{1,2})\/(?<d>\d{1,2})(?![\d/]|\s*(?:以内|以上|以下|未満|程度|を超|超))/gu,
  // 点で区切った月日（「11.7（土）まで」「11.20 最終提出」）。小数・版数と取り違えないよう、使える所を findDates で絞る
  /(?<![\d./vV])(?<m>\d{1,2})\.(?<d>\d{1,2})(?![\d.]|\s*(?:以内|以上|以下|未満|程度|を超|超))/gu,
];
const DOT_DATE = DATE_PATTERNS[DATE_PATTERNS.length - 1];
// 点の月日として読むのは、文の頭にある時か、すぐ後ろに曜日・「まで」・範囲の記号・日程の語がある時だけ
const DOT_DATE_AFTER = /^\s*(?:[（(]\s*(?:[日月火水木金土]|SUN|MON|TUE|WED|THU|FRI|SAT)|(?:SUN|MON|TUE|WED|THU|FRI|SAT)\b|まで|迄|〆|締|[〜～~–—-]|最終|一次|二次|本選|提出|エントリー|開催|発表)/iu;
const DOT_NOT_DATE = /^\s*(?:倍|点|%|％|万|億|千|kg|g\b|cm|mm|km|m\b|時間|秒|分|GB|MB|KB|版|x|×|ポイント|pt|インチ|型)/iu;
const TIME = /(?<![\d:])(?<h>[0-2]?\d)\s*[:：時]\s*(?<min>[0-5]\d)?(?:分)?/u;

const pad = (n: number) => String(n).padStart(2, "0");

/** 文書全体で最初に明記された年（年を省いた日付の補完に使う）。無ければ today の年。 */
export function baseYear(sentences: Sentence[], today: Date): number {
  for (const s of sentences) {
    const m = nf(s.text).match(/(20\d{2})\s*(?:年|[./-]\d)/u);
    if (m) return Number(m[1]);
    const w = nf(s.text).match(/令和\s*(元|\d{1,2})\s*年/u);
    if (w) return 2018 + (w[1] === "元" ? 1 : Number(w[1]));
  }
  return today.getUTCFullYear();
}

export function findDates(text: string, year: number): DateHit[] {
  const t = nf(text).replace(/\s*[（(]\s*20\d{2}\s*年?\s*[）)]/gu, "").replace(/同年/gu, "");
  const hits: Array<DateHit & { at: number; len: number }> = [];
  const taken: Array<[number, number]> = [];
  for (const re of DATE_PATTERNS) {
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0;
      const len = m[0].length;
      if (taken.some(([a, b]) => at < b && a < at + len)) continue;
      const g = m.groups!;
      if (re === DOT_DATE) {
        const rest = t.slice(at + len);
        if (DOT_NOT_DATE.test(rest) || !(t.slice(0, at).trim() === "" || DOT_DATE_AFTER.test(rest))) continue;
      }
      const mo = Number(g.m), d = g.last ? 1 : Number(g.d);
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      const y = g.era ? ERA[g.era] + (g.ey === "元" ? 1 : Number(g.ey)) : g.y ? Number(g.y) : year;
      const explicitYear = !!(g.y || g.era);
      // 範囲「9月10日〜12月8日」の後半は、前半の年を受け継ぐ。年を跨ぐ（12月→1月）時は翌年。
      let yy = y;
      // 前の日付＝文の中でこの日付より前にある日付（パターンごとに拾うので、拾った順ではなく位置で選ぶ）
      const before = hits.filter((h) => h.at < at).sort((a, b) => b.at - a.at);
      if (!explicitYear && before.length) {
        const prev = before[0];
        const [py, pm] = prev.iso.split("-").map(Number);
        yy = mo < pm ? py + 1 : py;
      }
      // 年が書かれていない時、すぐ後ろの曜日（「1月20日（水曜日）」）と合わなければ、前後の年で曜日の合う方にする
      if (!explicitYear && !g.last) {
        const wd = t.slice(at + len, at + len + 6).match(/^\s*[（(]\s*([日月火水木金土])/u);
        if (wd) {
          const want = "日月火水木金土".indexOf(wd[1]);
          const dow = (yr: number) => new Date(Date.UTC(yr, mo - 1, d)).getUTCDay();
          if (dow(yy) !== want) yy = dow(yy + 1) === want ? yy + 1 : dow(yy - 1) === want ? yy - 1 : yy;
        }
      }
      taken.push([at, at + len]);
      const dd = g.last ? new Date(Date.UTC(yy, mo, 0)).getUTCDate() : d;
      const after = t.slice(at + len, at + len + 14);
      const tm = after.match(TIME);
      hits.push({
        iso: `${yy}-${pad(mo)}-${pad(dd)}`, raw: m[0], yearGuessed: !explicitYear, at, len,
        time: tm && tm.index! <= 6 ? `${pad(Number(tm.groups!.h))}:${tm.groups!.min ?? "00"}` : undefined,
      });
    }
  }
  return hits.sort((a, b) => a.at - b.at).map(({ at: _a, len: _l, ...h }) => h);
}

// --- 種類の検出 -----------------------------------------------------------------------------------
const EN_DEADLINE = /\b(?:deadline|due(?:\s+date)?|closes?|until)\b/i;
const EN_REQUIRED = /\b(?:must|required|mandatory)\b/i;
const EN_PROHIBITED = /\b(?:do\s+not|must\s+not|not\s+allowed|prohibited|forbidden|disqualified)\b/i;
const EN_QUANTITY = /\b(?:up\s+to|at\s+most|no\s+more\s+than|maximum|max\.?|at\s+least|minimum)\s*\d|\d[\d,.]*\s*(?:MB|GB|KB|minutes?|mins?|pages?|words?|members?)\s*(?:or\s+(?:less|fewer|more)|max(?:imum)?)\b/i;
const DEADLINE_WORDS = /申請期間|提出期日|期日|終了日|締切|締め切|〆切|〆|期限|必着|まで|迄|受付|募集期間|応募期間|提出期間|エントリー期間|申込期間|消印|最終日|をもって(?:終了|受付終了|締切|締め切)/u;
const REQUIRED = new RegExp(
  "(?<![非不無])必須(?!では(?:ない|ありません)|でない)|不可欠|必ず(?!しも|[^。]{0,24}(?:ものではあり|わけではあり|とは限り|ではありません))|なくては(?:ならない|ならず|なりません|いけない|いけません)|なければ(?:ならない|ならず|なりません|いけない|いけません)" +
    "|(?<!不)必要(?:が|は)?(?:あります|ある(?!と[^。．]*とき)|です|になります|となります|となる(?!経費|設備|改修|費用|書類|工事|機器|資金|もの|事項|場合)|とします|とする(?!従業員|者|人|方|事業)|である|とされ)" +
    "|が要件(?:です|となります|になります)|のみ(?:となります|です|とします)|(?:が|も)要件(?:[】）)。．]|$|と|に)|(?:に限って|に限り)(?:募集|受け付け|受付|対象)|(?:入力|アップロード|送付|添付|提出|記載)[。．]$|(?:ない|なく)(?:者|人|もの|方)[。．）)]*$" +
    "|ものとします|要します|に限ります|に限らせて|に限る|が条件|を条件|遵守(?:してください|すること|願います|いただ|しなければ)|お守りいただ|同意いただける|ご同意いただいた|ご(?:同意|承諾|了承)いただきます|(?:承諾|許可|了承|同意|許諾)を(?:得て|取って|お取りの上|得た上で)[^。．]*(?:ください|下さい)|条件と(?:します|する|なります)[。．]?$|こと[。．]?$|(?:する|である|いる|ある|できる|ない|れる|なる)事[。．]?$" +
    "|(?<!させ)(?:て|で)いただきます[。．]?$" +
    "|(?<!ぜひ|ぜひご|ぜひお|お気軽にご|お気軽に)(?:提出|添付|記入|入力|送信|登録|郵送|提供|応募|参加|同意|送付|お送り|申請|回答|申し込み|申込|明記|設定|用意|準備|作成|完了(?:さ?せ)?|持参|出席|取得|実装|公開|アップロード)(?:して|し)?(?:ください|下さい)" +
    "|忘れずに|(?:を|は|で)(?:提出|添付|記入|送信|郵送)(?:のこと)?[。．!！\\p{Extended_Pictographic}\\s]*$" +
    // 義務付け・求められる・資格の定め（「〜を対象とします」「〜の作品とします」）・方法の限定（「郵送でのみ受け付けます」）・「〜をお願いいたします」の丁寧な依頼
    "|義務(?:付け|づけ|が(?:あります|ある|生じ))|が求められ(?:ます|る|ています)|(?:作品|もの|方|者|人|グループ|チーム|団体|学生|生徒)とします[。．]?$|を対象(?:と)?(?:します|とする)|(?:方|者|人|学生|生徒|世帯|企業|団体|事業者|法人|事業|もの)(?:が|は|のみ(?:が)?)対象(?:です|となります|になります|とします)|のみ(?:受け付け|受付|応募可能|対象|有効)" +
    "|(?:提出|添付|記入|入力|送信|登録|申請|回答|申込|応募|郵送|確認)(?:を|のほど)お願い(?:いたし|し)ます",
  "u",
);
// 「〜してください」一般。確認・問い合わせ・利用・閲覧などの案内の動詞は、義務に数えない
const TE_KUDASAI = /[^、。]{0,10}(?:て|で)(?:ください|下さい)/gu;
const SOFT_TE = /(?:確認|問い?合わせ|問合せ|覧|参照|利用|待ち|注意|安心|相談|検討|参考|活用|訪れ|アクセス|クリック|ダウンロード|お越し|来場|読ん|見|知っ|知らせ|連絡|声がけ|お寄せ|お送り(?:いただ)?|ご記入|お書き|お読み|お試し|教え)(?:の上)?(?:し)?(?:て|で)(?:ください|下さい)/u;
const KUDASAI_NOUN = /(?:共有|承諾|了承|同意|協力|参加|出席|提出|記入|入力|登録|確認|準備|用意|送付|返信|対応|来場|プレゼンテーション|発表|お持ち)(?:いただ|頂)(?:きます|くことに)/u;
const ONEGAI = /お願い(?:いたし|し)ます[。．]?$/u;
// 資格の言い方（「〜を有する者」「〜に在籍する学生」）・ご〜ください／願います（提案・記入・提出・留意など）
const ELIGIBLE_SHAPE = /(?:有する|有している|満たす|満たして|該当する|在籍(?:する|している)|在学(?:する|している)|居住(?:する|している)|所在(?:する|している)|所有(?:する|している)|修了(?:した|している)|卒業(?:した|している|見込み)|受けて(?:いる|おり)|である)(?:者|方|人|もの|団体|事業者|学生|生徒)[。．）)]*$/u;
// 速やかに・十分に・各自などの語があれば、確認・連絡・相談・負担の依頼も応募する人への義務
const GO_HARD = /(?:速やかに|直ちに|至急|各自で?|十分に|あらかじめ|事前に)[^。]{0,30}(?:ご連絡|ご相談|ご負担|ご確認|確認|連絡|注意|ご注意|お知らせ|ご報告)(?:の上|して|し)?(?:ください|下さい)|(?:ご負担|ご持参|ご用意|ご準備|お持ち)(?:ください|下さい)/u;
const ELIGIBLE2 = /(?:認められる|認めた|優れている|推薦する|推薦された|困難な|以上の|以下の|未満の|以内の)(?:者|方|人)[。．）)]*$/u;
const GO_TE = /(?:お|ご)(?:提案|記入|記載|提出|添付|留意|送付|返信|入力|登録|応募|申請|申込|申し込み|回答|準備|用意|持参|同意|承諾|遵守|厳守)[^\s。、]{0,6}(?:ください|下さい|願います|願いします|いただき)/u;
const SOFT_ONEGAI = /(?:ご協力|ご理解|ご了承|ご了解|ご承知|ご留意|ご注意|お問い合わせ|ご連絡|ご相談|ご確認|よろしく|ご配慮|ご容赦|ご支援|ご参加|ご応募|ご来場|ご活用|ご利用)(?:を|のほど)?お願い/u;
const teMust = (t: string) => KUDASAI_NOUN.test(t) || GO_TE.test(t) || GO_HARD.test(t) || ELIGIBLE2.test(t) || (ELIGIBLE_SHAPE.test(t) && !/募集|歓迎|紹介|ありません/u.test(t)) || (ONEGAI.test(t) && !SOFT_ONEGAI.test(t) && !/お問い?合わせ|問合せ|ご質問|ご連絡/u.test(t)) || (t.match(TE_KUDASAI) ?? []).some((x) => !SOFT_TE.test(x));
// 閲覧ソフトの案内（「Adobe Reader が必要です」）・例示（「たとえば、…こと。」）・括弧だけの見出し・運営側のお詫び（「ご了承下さい」）は必須にしない
const NOT_REQUIRED_SHAPE = (t: string) =>
  /(?:Adobe|Acrobat|アドビ)[^。]{0,40}(?:Reader|ダウンロード)|閲覧ソフト|Reader[^。]{0,10}(?:必要|ダウンロード)/u.test(t) ||
  /^(?:たとえば|例えば|例)[、,]/u.test(t) || /(?:次|以下|下記)のとおり(?:です|となります)[。．]?$/u.test(t) || /[（(](?:PDF|ZIP|Word|Excel|DOCX?|XLSX?)[：:\s]/iu.test(t) || /^(?:[（(]例[）)]|例[：:])/u.test(t) ||
  (/^[【［\[（(][^】］\]）)]{1,24}[】］\]）)]$/u.test(t.trim()) && !/^[（(]必須[）)]$/u.test(t.trim()) && !/(?:あります|です|ます|ください|下さい)[。．]?[】］\]）)]$/u.test(t.trim()) && !/(?:が|も|を)要件/u.test(t)) ||
  (/ご了承(?:ください|下さい)[。．]?$/u.test(t) && !/応募|参加|申込|申し込み|提出/u.test(t));
// 指示の形（〜ください）に頼らない強い義務語
const REQUIRED_STRONG = /(?<![非不無])必須|不可欠|必ず(?!しも|[^。]{0,24}(?:ものではあり|わけではあり|とは限り|ではありません))|なければ(?:ならない|ならず|なりません)|(?<!不)必要(?:が|は)?(?:あります|です|となります)/u;
const PROHIBITED = new RegExp(
  "禁止|禁じ|(?<!なく)てはならな|(?<!なく)てはなりません|(?<!なく)てはいけな|(?<!なく)てはいけません|不可(?!欠|避|分|逆|侵)|認められません|認めません" +
    "|できません|できかねます|応じかねます|無効|失格|取消|取り消|お断り|ご遠慮|対象外" +
    // 婉曲な禁止（お控えください・慎んでください）・受け付けない・選考から外れる・禁止事項への抵触
    "|厳禁|^[×✕✖]\\s*\\S{2,}|(?:応募|申請|受給|対象|参加|提出|選考|採用|受付)(?:は|も)?(?:でき|出来)ない|(?:者|方|もの|場合)は(?:対象から)?除き(?:ます|とする|とします)|応じて(?:い|お)りません|不認可|出来(?:ません|ない)|(?:受付|受理|受け付け|審査|選考|応募|参加)(?:は)?(?:いた)?しかねます|対象(?:と)?は?(?:なり|なら|し)(?:ません|ない)|対象にならない|応じられません|受け付けられません|(?:提出|応募)とみなしません|受理しません|返還(?:となります|を求めます|を求める)|対象に(?:は)?(?:なり|なら)(?:ません|ない)|対象と(?:は)?(?:し|して)(?:ません|いません|おりません|ない)|受付け(?:ません|ておりません)|受付(?:は)?して(?:い|お)りません|不採用|不受理|認められて(?:い|お)りません|(?:対象|選考|審査)から(?:除外|外れ|外し)|(?:応募|参加|出品)(?:い)?ただけません|認めない(?:こと|場合)|(?:給付|支給)を(?:一時)?(?:中止|打ち切)|辞退したと(?:み|見)なし|選外(?:となり|とし|とさせ)|不採択|選考外|資格を失|(?:給付|支給)を(?:停止|打ち切)|受け付けておりません|(?:受付|受理)(?:して|いた)おりません|認めておりません|認めていません|(?:辞退|無効)したものとみなし|(?<!ためらわ|遠慮し|迷わ)ないでください|(?:し|行わ|使わ|使用し|用い|含め|転載し|公表し|複製し|利用し)ないこと[。．]?$|ないよう(?:に)?(?:お願い|注意|ご注意|してください)|お控え(?:ください|いただ)|慎んで(?:ください|いただ)|(?:受理|受付|受け付け)(?:いた)?しません|受け付けません|選考(?:から|の対象から)外れ|抵触",
  "u",
);
// 禁止の語の否定（「無効とはなりません」「取消すことはありません」「ご遠慮なく」）は、禁止ではない
// 運営ができないという約束（「返却できません」「お答えいたしかねます」「交付できません」）は、応募する人の禁止ではない
const OPERATOR_CANNOT = /(?:返却|返還|返送|お返し|お答え|回答|公表|開示|交付|返信)(?:は|も)?(?:でき|いたし|致し)(?:ません|かねます)|(?:お問い合わせ|ご質問|ご相談)[^。]{0,16}応じられません|通知(?:は)?(?:いた)?しません|返却(?:不可|しません|いたしません)/gu;
const NEGATED_PROHIBITION = /(?:無効|失格|取消|取り消|対象外|禁止|お断り)(?:し|す|する)?(?:と|に|で|を)?(?:は|も)?(?:こと(?:は|も)?)?(?:なり|し|いたし|あり)(?:ません|はしません)|ご遠慮(?:なく|無く)/gu;
const UNITS = "篇|割|面|台|部|つ|カ月|ケ月|ヵ月|編|倍|事業|か所|箇所|カ所|字|文字|字以内|枚|ページ|頁|名|人|チーム|点|作品|件|分|秒|時間|日間|か月|ヶ月|MB|GB|KB|メガ|円|万円|歳|才|回|行|語|ワード|words?|px";
// 数量＝制限の言い方（以内・以上・上限・先着…）を伴う数、または表・箇条の短い項目の中の「数＋単位」。
// 「約1,700人が参加しました」のような実績の数は拾わない。
const QUANTITY_LIMIT = new RegExp(
  `(?:(?:最大|最小|最低|上限|下限|先着|定員)\\s*\\d)|(?:(?:採用予定|募集人数|採用人数|募集定員|定員)[^。、]{0,10}\\d[\\d,.]*\\s*(?:名|人|件|校|組))|(?:[一二三四五六七八九十]+\\s*(?:編|枚|点|名|人|件|通|部|冊)\\s*(?:まで|以内|以下|以上))|(?:\\d[\\d,.]*\\s*(?:分|秒|ページ|頁|枚|字|文字)程度)|(?:(?:継続|使用|保存|定住|居住|営業|経過|勤務|在籍|従事|維持|保管|利用)[^。、]{0,8}\\d+\\s*年(?:間)?(?:以上|以内)?)|(?:\\d+\\s*年(?:間)?(?:以上)?[^。、]{0,6}(?:継続|使用|保存|定住|居住|営業|経過|勤務|在籍|従事|維持|保管|利用|住んで|住所|在住|活動))|(?:(?:卒業|修了|創業|設立|取得)後?\\s*\\d+\\s*年(?:以内|未満|以上))|(?:[一1１]\\s*回\\s*限り|[一1１]\\s*回のみ)|(?:一人\\s*[一二三四五六七八九十\\d]+\\s*(?:篇|編|作品|点|枚|件))|(?:\\d[\\d,.]*\\s*(?:${UNITS}|％|%|日|週間|週)?\\s*(?:以内|以上|以下|未満|まで|を超え|を上限))|(?:\\d[\\d,.]*\\s*(?:${UNITS})?\\s*(?:が|を)?\\s*(?:上限|下限|限度|最大|最少|最低))|(?:につき\\s*\\d[\\d,.]*\\s*(?:点|作品|件|枚|本|回|通|部))|(?:\\d[\\d,.]*\\s*(?:${UNITS})\\s*(?:に限|のみ|だけ))|(?:\\d[\\d,.]*\\s*(?:枚|ページ|頁|字|文字|分|秒|行)(?:程度|前後)?(?:に|で)(?:まとめ|収め|作成|記述|記入))|(?:\\d\\s*(?:${UNITS})?\\s*[〜~～-]\\s*\\d[\\d,.]*\\s*(?:${UNITS}))`,
  "u",
);
// 短い項目の単位からは、ファイルの大きさと金額を外す（「50万円」「月額3.0万円」は賞金・給付・家賃で、応募する側の上限ではない）
const UNITS_ITEM = UNITS.replace("|MB|GB|KB|メガ", "").replace("|円|万円", "");
const QUANTITY_UNIT = new RegExp(`\\d[\\d,.]*\\s*(?:${UNITS_ITEM})`, "u");
// 日付の「日」「月」を数量と取り違えない
const DATEISH = /(?:令和|平成)\s*(?:元|\d{1,2})\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}\s*年|\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}\s*[:：]\s*\d{2}/gu;

/** 問いの文：？で終わる・Q. で始まる・「〜ますか」「〜ですか」で終わる（？を付けない FAQ もある）。 */
export const isQuestion = (s: { text: string }) =>
  /[?？]\s*$/u.test(s.text) || /^Q\s*[.．:：]/u.test(s.text.normalize("NFKC")) || /(?:ます|です|ません|でしょう)か\s*$/u.test(s.text);

// --- 立場 -----------------------------------------------------------------------------------------
export type Audience = "team" | "solo" | "corp" | "minor" | "overseas" | "student" | "worker";
const AUDIENCE: Record<Audience, RegExp> = {
  team: /チーム(?:の場合|で(?:の)?(?:参加|応募)|代表|メンバー)|グループ(?:の場合|で)|複数人|共同制作|(?:2|２)名以上/u,
  solo: /個人(?:の場合|で(?:の)?(?:参加|応募)|でも|・|or|参加)|1人(?:参加|でも|で)|1名で|ひとり(?:で|でも)|個人チーム/u,
  corp: /法人(?:の場合|で(?:の)?(?:応募|参加)|の方)|企業(?:の場合|から)/u,
  minor: /未成年|保護者の同意|18歳未満|20歳未満/u,
  overseas: /海外(?:在住|から|の方)|留学生|外国籍|国外/u,
  student: /(?<!留)学生(?:の方|の場合|であること)|在学(?:中|証明)/u,
  worker: /社会人(?:の方|の場合)|就業経験|正社員/u,
};

export function detect(blocks: Block[], today: Date): Sentence[] {
  const ss = splitSentences(blocks);
  const year = baseYear(ss, today);
  const byBlock = new Map<number, Sentence[]>();
  for (const x of ss) byBlock.set(x.block, [...(byBlock.get(x.block) ?? []), x]);
  for (const s of ss) {
    const t = nf(s.text);
    s.dates = findDates(s.text, year);
    // 見出しは塗らない（「応募が無効になる場合」は節の名前で、条項ではない）
    if (blocks[s.block].type.startsWith("h")) { s.qualifiers = []; continue; }
    // 日程表の行：期間（〜）と「エントリー・応募・提出…」が一緒にある行は、終わりの日を締切として拾う（「8月28日～11月19日 本エントリー」）
    const scheduleRow = (s.dates.length >= 2 && /[〜～~]|から/u.test(t) && /エントリー|応募|提出|申込|申し込み|募集|受付|登録/u.test(t))
      // 日程の並び（「11.20 最終提出 資料・デモURL」）：文の頭が日付で、範囲の始まり（「9.30 –」）ではない
      || (s.dates.length === 1 && t.trimStart().startsWith(s.dates[0].raw) && !/^\s*[〜～~–—-]|^\s*から/u.test(t.trimStart().slice(s.dates[0].raw.length)) && /提出|応募|エントリー|申込|申し込み/u.test(t));
    // 運営が連絡・通知する日（「〜までにご連絡します」）、参加する日程（「全日程に参加できること」）、お知らせ欄の「受付を開始しました」は締切ではない
    const notDeadline = /(?:ご連絡|連絡|お送り|送付|通知|発表|お知らせ|ご案内)(?:いたし|し)?ます[。．]?$|全日程|開始しました|開始して(?:い|お)ます|開始いたします|開始されます|受付開始|(?:募集|応募|エントリー|申込|申し込み)開始|開始します|開始予定|公開しました|掲載しました|更新しました|有効とします|有効です|予定日|(?:交付|お支払い|発表|通知)(?:し|いた)ます[。．]?$|更新日|ページID|最終更新|閉所日|時点|から適用|以降の[^。]{0,12}適用|実施して(?:い|お)ます|\d日現在|現在で|(?:でした|ました)[。．]?$|\d\s*[)）]?\s*現在|(?:振り込|振込|支給|送金)(?:み)?(?:ます|いたします|予定)|再開(?:いたし)?ます|審議|(?:いたしました|しました|されました)[。．]?$/u.test(t) && !/締切|締め切|〆切|必着|期限/u.test(t)
      // 支給・助成・事業などの「期間」（始まりから終わりまで）は、応募の締切ではない
      || /(?:支給|給付|貸与|助成|事業|実施|開催|対象|活動|研究|交付|補助)期間/u.test(t) && !/締切|締め切|〆切|必着|期限|応募|申請|申込|申し込み|募集|受付|提出|エントリー/u.test(t);
    // 「応募を締め切りました」（過去の報告）・「日時：」「会場：」（行事の案内）・合格や進学の条件の日付は、応募の締切ではない
    const pastClosed = /(?:締め切り|締切り|受付(?:を)?終了|募集(?:を)?終了|終了いたし|終了し)(?:ました|ております|ています)[。．]?$/u.test(t) ||
      (/(?:実施|開催|撮影|制作|発行)(?:する|される|した|され)/u.test(t) && !/応募|申請|申込|申し込み|提出|受付|締切|締め切|必着|期限/u.test(t)) || /^(?:日時|開催日|会場)[：:]/u.test(t) ||
      (/合格|進学|卒業|入学/u.test(t) && !/応募|提出|申請|申込|申し込み|受付|締切|締め切/u.test(t));
    if (s.dates.length && !notDeadline && !pastClosed && (DEADLINE_WORDS.test(t) || EN_DEADLINE.test(t) || scheduleRow || nearDeadlineHeading(blocks, s.block) || dateCellBeforeDeadline(blocks, s, t))) s.labels.push("deadline");
    // よくある質問の「問い」の文（？で終わる）は、必須・禁止に数えない（答えの文で数える）
    const question = isQuestion(s);
    // 項目名・見出しの名詞止め（dt・th の「助成対象外となる団体等」）には、必須も禁止も付けない
    const labelish = ["dt", "th"].includes(blocks[s.block].type) && t.length <= 24 && !/(?:ます|です|ません|こと|ください|下さい|ない)[。．]?$/u.test(t);
    // 「お気軽に〜ご登録ください」「ぜひご応募ください」のような誘いは、指示の形でも必須に数えない
    const invite = /お気軽に|ぜひ|是非|推奨|目安|望まし|できれば|可能であれば|問題ありません|不問|緩和あり|歓迎(?:し|いた)ます|ご覧いただけます|認めるものとします|いただける場合|よろしければ|差し支えなければ|余裕を(?:もって|持って)|お早め|早めに|ご遠慮なく|ご遠慮無く|皆さん|皆様|みなさん|みなさま/u.test(t) && !REQUIRED_STRONG.test(t);
    // 「〜をまとめています」のような節の案内は、中身が義務でも案内の文そのものは必須に数えない
    const guide = /まとめています|まとめました|ご案内しています|記載しています/u.test(t) && !REQUIRED_STRONG.test(t);
    // 「当社は、〜を使用できるものとします」のように主語が運営の文は、応募する人がすることではない（運営側の約束・権利）
    const operator = (OPERATOR_SUBJECT.test(t) || OPERATOR_ACTION.test(t) || /(?:が|にて|で)(?:判断|決定|審査|選考)(?:いた)?し?ます[。．]?$/u.test(t) || (/(?<!お願い|お願い申し上げ)いたし(?:ます|ません)[。．]?$/u.test(t) && !/^(?:応募者|申請者|参加者|受賞者)/u.test(t))) && !/(?:ください|下さい)[。．]?$/u.test(t);
    // 「〜場合があります」は可能性、「〜を除く。」は例外の注記＝それだけでは必須に数えない
    const maybe = /ではないかと(?:考え|思い)|であると考え|と考えます|と考えるからです|認識されつつ|必要があるのでは|(?:場合|こと)があります[）)]?[。．]?$|帰属(?:する)?(?:もの)?とします[。．]?$|責任を負(?:わない|いません)|保証(?:でき|し)かね|^[^。．、をがはにで]{1,12}こと$|(?:を|は)除く[。．]?$|除きます[。．]?$/u.test(t) && !REQUIRED_STRONG.test(t);
    // 文末の注記（※1）・（…）・「等」を外した形でも見る（「〜であること（※1）」）
    const tEnd = t.replace(/[（(][^）)]*[）)][。．]?$/u, "").replace(/\s*等$/u, "");
    // 受賞者の紹介・スピーチ要旨・開催結果の節の文は、応募する人への条件ではない
    const inStory = nearestHeadingMatches(blocks, s.block, STORY_HEADING);
    if ((REQUIRED.test(t) || REQUIRED.test(tEnd) || EN_REQUIRED.test(t) || teMust(t)) && !NOT_REQUIRED_SHAPE(t) && !inStory && !labelish && !question && !invite && !guide && !operator && !maybe) s.labels.push("required");
    // 数量は、日付・電話番号・「第N回」・年だけの数字・金額を外してから測る（「…7707まで」「第4回」「チャレンジ2026」「年間最大120万円」）
    const tq = s.dates.reduce((a, d) => a.replace(d.raw, " "), t).replace(/^\s*\d{1,2}\s*[.．、)）]\s*/u, " ").replace(/\d{2,4}-\d{2,4}-\d{3,4}/gu, " ").replace(DATEISH, " ").replace(/第\s*\d+\s*回/gu, " ").replace(/(?:19|20)\d{2}(?!\s*[年./-])/gu, " ").replace(/\d[\d,.]*\s*万?円/gu, " ").replace(/[$＄]\s*\d[\d,.]*/gu, " ").replace(/\d{1,2}\s*時\s*(?:\d{1,2}\s*分)?/gu, " ").replace(/徒歩\s*約?\s*\d+\s*分/gu, " ").replace(/〒?\s*\d{3}-\d{4}|\d+丁目\d+番(?:\d+号)?/gu, " ");
    // 運営の実績（「延べ65,000人」「年間150回以上のイベントを開催」）は数量に数えない
    const stats = /延べ|累計|これまでに|過去\s*\d+\s*年|を開催$|開催しています|^(?:審査(?:委員会|委員|員)|選考委員会?)(?:は|では|には)|参加しており|参加しています|参加いただき|昨年|例年|年\s*\d+\s*回|推計|と言われ|徒歩|所要|点満点|配点|(?:送付|通知|連絡|返信|回答)(?:を)?(?:いた)?(?:し)?ます[。．]?$|端数|切(?:り)?捨|切(?:り)?上げ|各月\d+日|年に\d+\s*回|半年に\d+\s*回|(?:振り込|振込|送金|支給|返還)[^。]{0,10}\d+\s*回|\d+\s*回[^。]{0,6}(?:に分け|振り込|振込|支給)|[^。、]{0,10}の\s*\d+\s*[〜～~-]\s*\d+\s*(?:ページ|頁)/u.test(t);
    // 「〜のリンク集です」のような文は、句点が無くても項目ではない
    // 「提出物は3点。」のような、項目名＋数＋単位だけの短い文
    const shortNominal = /^[^。．、]{1,12}は\s*\d[\d,.]*\s*(?:点|名|人|件|枚|チーム|作品|ページ)[。．]?$/u.test(tq.trim());
    const shortItem = !/[。．]/u.test(t) && t.length <= 30 && !/(?:です|ます)$/u.test(t) && !/^[↓→⇒]/u.test(t);
    // 賞の数・賞金・受賞作の紹介は、応募する側の上限ではない（「1作品」「賞金100万円」「1,600件以上の目録」）
    const prize = /賞金|副賞|賞品|最優秀賞|優秀賞|佳作|大賞|金賞|銀賞|銅賞|入選|入賞|特別賞|審査員賞|奨励賞|審査通過|通過（/u.test(t) || inPrizeSection(blocks, s.block);
    // 賞の表の升目（「1名」「1名5万円」）は、直前が賞名の行なら応募する人の上限ではない
    const prevText = nf(blocks[s.block - 1]?.text ?? "");
    const prizeCell = /^\s*\d+\s*名(?:\s*各?\s*[\d,]+\s*万?円(?:\s*[+＋].*)?)?\s*$/u.test(t) && (prevText.length <= 24 && /賞|入選|入賞|大賞|グランプリ|金|銀|銅/u.test(prevText));
    const bareCell = prizeCell || /^\s*\d+\s*(?:分|点|秒|時間|回目)\s*$/u.test(tq);
    if (!prize && !stats && !question && !bareCell && (QUANTITY_LIMIT.test(tq) || EN_QUANTITY.test(tq) || (shortItem && QUANTITY_UNIT.test(tq)) || shortNominal)) s.labels.push("quantity");
    // 「東京都火災予防条例上の禁止行為」や「…（PDF）」のように、禁止の語が文書や項目の名前の中にあるだけの文は禁止に数えない
    const tp = t.replace(/「[^」]*」/gu, "「」").replace(/[^。．]*[（(]PDF[）)]/gu, " ").replace(NEGATED_PROHIBITION, " ").replace(OPERATOR_CANNOT, " ");
    if ((PROHIBITED.test(tp) || EN_PROHIBITED.test(tp)) && !question && !labelish && !/(?:について|とは)[。．]?[】］\]）)]?$/u.test(t.trim().slice(-12)) ) s.labels.push("prohibited");
    // 箇条書き・表のセルは、属する見出しの意味を受け継ぐ（「応募が無効になる場合」の下の各項目＝禁止）
    // 項目名だけのセル（「対象大学」）と、注の番号だけの行（「注1：」「※1」）
    const headingish = (t.length <= 40 && /(?:について|とは|に関して)[。．]?[】］\]）)]?$/u.test(t)) || (/^[【［\[][^】］\]]{1,40}[】］\]]$/u.test(t.trim()) && !/(?:あります|です|ます|ください|下さい)[。．]?[】］\]]$/u.test(t.trim()));
    const labelOnly = headingish || (s.text.length <= 6 && !/\d/u.test(s.text)) || /^(?:注|※)\s*\d*\s*[：:]?$/u.test(s.text.trim()) || /^[\d０-９]{1,3}[.．)）]?$/u.test(s.text.trim());
    // 「任意です」「応募できます」は許可の言い方＝見出しが「提出物」「応募資格」でも必須を受け継がない
    const permissive = /任意|自由|できます|可能です|かまいません|構いません|問いません|問わず|いずれも可|可[）)]?[。．]?$/u.test(t);
    const hIdx = sectionHeadingIdx(blocks, s.block);
    // 資格の節の直下にある、短い本文の文（「〜に在籍する学生。」）も、見出しの意味を受け継ぐ（必須だけ・見出しから6ブロックまで）
    const shortProse = blocks[s.block].type === "p" && s.text.length <= 90 && hIdx >= 0 && s.block - hIdx <= 6;
    if ((["li", "dd", "td"].includes(blocks[s.block].type) || (!s.text.includes("。") && !["dt", "th"].includes(blocks[s.block].type)) || shortProse) && !labelOnly) {
      const h = sectionHeading(blocks, s.block);
      if (h && !shortProse && HEADING_PROHIBITED.test(nf(h)) && !/対象(?:事業|経費|者|団体)\s*[・、･]\s*(?:助成|補助)?対象外|対象外\s*[・、･]\s*対象/u.test(nf(h)) && !s.labels.includes("prohibited")) s.labels.push("prohibited");
      if (h && HEADING_REQUIRED.test(nf(h)) && !HEADING_PROHIBITED.test(nf(h)) && !s.labels.includes("required") && !permissive && !maybe && !operator && !inStory && !labelish && !NOT_REQUIRED_SHAPE(t)) s.labels.push("required");
    }
    // 箇条書きの項目は、直前の導入文（「以下の書類を提出してください」「次のいずれかに該当する場合は失格」）の意味を受け継ぐ
    const lead = !labelOnly && !question ? listLead(blocks, s.block) : null;
    if (lead != null) {
      const lt = nf(blocks[lead].text);
      const leadSs = byBlock.get(lead) ?? [];
      const intro = /以下|次の|下記|左記|[：:]\s*$|いずれか|すべて|全て|のとおり/u.test(lt);
      const leadPro = leadSs.some((x) => x.labels.includes("prohibited"));
      if (((intro && leadSs.some((x) => x.labels.includes("required"))) || (lt.length <= 50 && HEADING_REQUIRED.test(lt))) && !leadPro && !s.labels.includes("required") && !permissive && !maybe && !operator && !inStory && !labelish && !NOT_REQUIRED_SHAPE(t)) s.labels.push("required");
      // 失格・無効の導入文の下でも、「〜こと」で終わる肯定の条件は禁止ではない
      if (((intro && leadPro) || (lt.length <= 50 && HEADING_PROHIBITED.test(lt))) && !s.labels.includes("prohibited") && !permissive && !labelish && !/こと[。．]?$/u.test(tEnd)) s.labels.push("prohibited");
    }
    s.audiences = (Object.keys(AUDIENCE) as Audience[]).filter((a) => AUDIENCE[a].test(t));
    s.qualifiers = qualifiers(s.text, false);
  }
  markConflicts(ss);
  return ss;
}

const HEADING_PROHIBITED = /無効|禁止|失格|できないこと|ご遠慮|対象外|対象と(?:は)?ならない|対象にならない|資格(?:を)?(?:喪失|失う)|併給(?:不可|できない)|取り消し|取消し|交付停止|給付の停止|応募できない/u;
const HEADING_REQUIRED = /応募資格|参加資格|応募条件|参加条件|募集対象|応募対象|対象者|必要書類|提出物|提出書類|必須|申請書類|報告書類|添付書類|必要な書類|ご用意|応募要件|資格要件|奨学生の資格|給付資格|採用資格|資格(?!証明|喪失|を喪失|を失)|補助対象(?:者|事業者?)|助成対象(?:者|団体|事業)|申請資格|申請要件|^\s*(?:要件|対象)\s*$/u;

const OPERATOR_SUBJECT = /^(?:\d+\s*[.．、)）]\s*|[（(]\d+[）)]\s*|[①-⑳]\s*)?(?:なお|また|ただし)?[、,]?(?:当社|弊社|運営|運営事務局|事務局|主催者|主催|本財団|当財団|財団|当法人|本学|当機構|IPA)(?:は|では|において)/u;

// 「〜を交付するものとします」のように、運営がすること（お金を渡す）を書いた文
const OPERATOR_ACTION = /(?:交付|支給|給付|貸与|入金|振り込|振込|支払)(?:する|いたす|します)?ものとします|(?:補助|助成|支給|支払|お支払い|交付|給付|貸与|使用|利用)(?:を)?(?:行い|いた)?(?:し)?ます[。．]?$|切り(?:捨て|上げ)るものとします/u;

// 賞・受賞作・審査員と、寮・施設の案内の節（応募する側の上限ではない数が並ぶ）
const HEADING_PRIZE = /受賞内容|受賞作品|賞金|賞品|表彰|審査員|お披露目|寮|施設|アクセス|所在地|設備|間取り|実績|採用情報|採択者|採択結果|選考結果|開催結果|応募状況|過去の|受賞者|インタビュー|INTERVIEW|PROFILE|スピーチ|出場者|ファイナリスト/u;
// 受賞者の紹介・スピーチ要旨・インタビュー・開催結果の節（応募する人への条件ではない文が並ぶ）
const STORY_HEADING = /受賞者|開催結果|インタビュー|INTERVIEW|PROFILE|スピーチ|出場者|ファイナリスト紹介|助成実績|採用実績|採択結果/u;
function nearestHeadingMatches(blocks: Block[], bi: number, re: RegExp): boolean {
  for (let k = bi - 1; k >= Math.max(0, bi - 60); k--) {
    if (blocks[k].type.startsWith("h")) return re.test(nf(blocks[k].text));
  }
  return false;
}

/** 賞・受賞作・審査員の節の中か（直前の見出しで決める。表の升目が多くても届くよう 60 ブロックまで遡る）。 */
function inPrizeSection(blocks: Block[], bi: number): boolean {
  for (let k = bi - 1; k >= Math.max(0, bi - 60); k--) {
    if (blocks[k].type.startsWith("h")) return HEADING_PRIZE.test(nf(blocks[k].text));
  }
  return false;
}

/** そのブロックが属する節の見出し（直前の h1〜h6）。8ブロックより遠い見出しは使わない。 */
function sectionHeadingIdx(blocks: Block[], bi: number): number {
  for (let k = bi - 1; k >= Math.max(0, bi - 12); k--) {
    if (blocks[k].type.startsWith("h")) return k;
    if ((blocks[k].type === "dt" || blocks[k].type === "th") && blocks[k].text.trim().length <= 14) return k;
  }
  return -1;
}

// 箇条書き・番号つきの行（「・」「①」「(1)」「ア）」）か。注記の「※」は含めない
const LIST_MARK = /^\s*(?:[・●■□◆◇○◯▪•]|[（(]?[0-9０-９]{1,2}[)）.．、]|[（(]?[一二三四五六七八九十]{1,2}[)）.．、]|[①-⑳]|[ア-ン][)）.．]|[a-zA-Zａ-ｚＡ-Ｚ][)）.．])/u;
/** 箇条書きの項目の直前にある導入文（「以下の書類を提出してください」）のブロック。見出しが先に来たら無し。 */
function listLead(blocks: Block[], bi: number): number | null {
  const isItem = (b: Block) => b.type === "li" || LIST_MARK.test(b.text);
  if (!isItem(blocks[bi])) return null;
  let k = bi - 1;
  while (k >= 0 && k > bi - 40 && isItem(blocks[k])) k--;
  if (k < 0 || blocks[k].type.startsWith("h")) return null;
  return k;
}

function sectionHeading(blocks: Block[], bi: number): string | null {
  for (let k = bi - 1; k >= Math.max(0, bi - 12); k--) {
    if (blocks[k].type.startsWith("h")) return blocks[k].text;
    // 「対象｜大学生…」「応募資格｜…」のような項目名（dt・th の短い文字）も見出しとして見る
    if ((blocks[k].type === "dt" || blocks[k].type === "th") && blocks[k].text.trim().length <= 14) return blocks[k].text;
  }
  return null;
}

/** 日付だけの升目（日程の並び「11.20｜最終提出｜資料・デモURL」）で、すぐ後ろの2つの升目が提出・締切を言っているか。 */
function dateCellBeforeDeadline(blocks: Block[], s: Sentence, t: string): boolean {
  if (s.dates.length !== 1 || t.replace(s.dates[0].raw, "").replace(/[（(][^）)]{1,4}[）)]|\s/gu, "") !== "") return false;
  const next = blocks.slice(s.block + 1, s.block + 3).map((b) => nf(b.text)).join(" ");
  return /締切|締め切|〆切|提出|応募|エントリー|申込|申し込み/u.test(next) && !/開始|スタート|発表(?:会|日)?$/u.test(next);
}

/** 直前の見出し・項目名（dt・th・短い行）が「期間・締切」を言っているか（表の「応募期間｜9月10日〜」の形）。 */
function nearDeadlineHeading(blocks: Block[], bi: number): boolean {
  for (let k = bi - 1; k >= Math.max(0, bi - 2); k--) {
    const b = blocks[k];
    const short = b.text.length <= 12;
    if ((b.type.startsWith("h") || b.type === "dt" || b.type === "th" || short) && /期間|締切|締め切|期限|〆|受付/u.test(nf(b.text)) && !/開催|開発期間|開始/u.test(nf(b.text))) return true;
  }
  return false;
}

// --- 矛盾（同じ対象に違う日付） -------------------------------------------------------------------
// 対象語ごとに、締切として拾った文の「最後の日付」（＝終わりの日）を集め、違う日付があれば文同士を結ぶ。
const SUBJECTS: Array<[string, RegExp]> = [
  ["応募の締切", /応募(?:の)?(?:締切|締め切|期間|期限)|応募締切|応募受付|エントリー(?:締切|期間)|申込(?:締切|期間)|募集(?:期間|受付|締切)/u],
  ["提出の締切", /提出(?:の)?(?:締切|期限|期間)|作品提出|本応募/u],
];

/** 締切として比べる日付：「まで・締切・必着」の直前の日付（日程を1文に並べた行で、後ろの審査日・発表日を拾わない）。無ければ最後の日付 */
function deadlineDateOf(s: Sentence): string {
  const m = /まで|迄|締切|締め切|〆切|必着|期限/u.exec(s.text);
  if (m) {
    let best: { at: number; iso: string } | null = null;
    for (const d of s.dates) {
      const at = s.text.indexOf(d.raw);
      if (at >= 0 && at < m.index && (!best || at > best.at)) best = { at, iso: d.iso };
    }
    if (best) return best.iso;
  }
  return s.dates[s.dates.length - 1].iso;
}

export function markConflicts(ss: Sentence[]): void {
  for (const [, re] of SUBJECTS) {
    const group = ss.filter((s) => s.labels.includes("deadline") && re.test(nf(s.text)) && s.dates.length);
    const ends = new Map<string, Sentence[]>();
    for (const s of group) {
      // 月間・各月・次回のような別の締切の話は除く
      if (/月間|各月|毎月|次回|翌月/u.test(s.text)) continue;
      const last = deadlineDateOf(s);
      ends.set(last, [...(ends.get(last) ?? []), s]);
    }
    if (ends.size > 1) {
      const all = [...ends.values()].flat();
      for (const s of all) {
        if (!s.labels.includes("conflict")) s.labels.push("conflict");
        s.conflictWith = all.filter((o) => o.id !== s.id).map((o) => o.id);
      }
    }
  }
}

/** 同じ文かどうかを正規化して比べる（見出しの重複・ナビの繰り返しを数え過ぎない）。 */
export const sameText = (a: string, b: string) => normalize(a).text === normalize(b).text;
