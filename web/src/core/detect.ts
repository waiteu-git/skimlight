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
  quantity: "字数・枚数・人数などの上限や下限を書いた文",
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
    let end = -1;
    // 「3．」「３．」「①.」のような番号の後ろでは切らない
    const sofar = text.slice(cuts.length ? cuts[cuts.length - 1] : 0, i).trim();
    const isNumbering = /^(?:[\d０-９]{1,3}|[①-⑳]|[a-zA-Z])$/u.test(sofar);
    if ((c === "。" || c === "．" || c === ".") && isNumbering) continue;
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
const nf = (s: string) => s.normalize("NFKC");
const DATE_PATTERNS: RegExp[] = [
  /(?<y>20\d{2})\s*年\s*(?<m>\d{1,2})\s*月\s*(?<d>\d{1,2})\s*日/gu,
  /(?<y>20\d{2})[./-](?<m>\d{1,2})[./-](?<d>\d{1,2})(?!\d)/gu,
  /(?<![\d./年])(?<m>\d{1,2})\s*月\s*(?<d>\d{1,2})\s*日/gu,
  /(?<![\d./])(?<m>\d{1,2})\/(?<d>\d{1,2})(?![\d/])/gu,
];
const TIME = /(?<![\d:])(?<h>[0-2]?\d)\s*[:：時]\s*(?<min>[0-5]\d)?(?:分)?/u;

const pad = (n: number) => String(n).padStart(2, "0");

/** 文書全体で最初に明記された年（年を省いた日付の補完に使う）。無ければ today の年。 */
export function baseYear(sentences: Sentence[], today: Date): number {
  for (const s of sentences) {
    const m = nf(s.text).match(/(20\d{2})\s*(?:年|[./-]\d)/u);
    if (m) return Number(m[1]);
  }
  return today.getUTCFullYear();
}

export function findDates(text: string, year: number): DateHit[] {
  const t = nf(text);
  const hits: Array<DateHit & { at: number; len: number }> = [];
  const taken: Array<[number, number]> = [];
  for (const re of DATE_PATTERNS) {
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0;
      const len = m[0].length;
      if (taken.some(([a, b]) => at < b && a < at + len)) continue;
      const g = m.groups!;
      const mo = Number(g.m), d = Number(g.d);
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      const y = g.y ? Number(g.y) : year;
      // 範囲「9月10日〜12月8日」の後半は、前半の年を受け継ぐ。年を跨ぐ（12月→1月）時は翌年。
      let yy = y;
      if (!g.y && hits.length) {
        const prev = hits[hits.length - 1];
        const [py, pm] = prev.iso.split("-").map(Number);
        yy = mo < pm ? py + 1 : py;
      }
      taken.push([at, at + len]);
      const after = t.slice(at + len, at + len + 14);
      const tm = after.match(TIME);
      hits.push({
        iso: `${yy}-${pad(mo)}-${pad(d)}`, raw: m[0], yearGuessed: !g.y, at, len,
        time: tm && tm.index! <= 6 ? `${pad(Number(tm.groups!.h))}:${tm.groups!.min ?? "00"}` : undefined,
      });
    }
  }
  return hits.sort((a, b) => a.at - b.at).map(({ at: _a, len: _l, ...h }) => h);
}

// --- 種類の検出 -----------------------------------------------------------------------------------
const DEADLINE_WORDS = /締切|締め切|〆切|〆|期限|必着|まで|迄|受付|募集期間|応募期間|提出期間|エントリー期間|申込期間|消印/u;
const REQUIRED = new RegExp(
  "(?<![非不無])必須|不可欠|必ず(?!しも)|なければ(?:ならない|ならず|なりません|いけない|いけません)" +
    "|(?<!不)必要(?:が|は)?(?:あります|ある|です|となります|となる|とします|とする|である|とされ)" +
    "|ものとします|要します|に限ります|に限らせて|に限る|が条件|を条件|遵守(?:してください|すること|願います|いただ|しなければ)|お守りいただ|同意いただける|ご同意いただいた|(?<!ない)こと[。．]?$" +
    "|(?<!させ)(?:て|で)いただきます[。．]?$" +
    "|(?<!ぜひ|ぜひご|ぜひお|お気軽にご|お気軽に)(?:提出|添付|記入|入力|送信|登録|郵送|提供|応募|参加|同意|送付|お送り|申請|回答|申し込み|申込)(?:して|し)?(?:ください|下さい)",
  "u",
);
// 指示の形（〜ください）に頼らない強い義務語
const REQUIRED_STRONG = /(?<![非不無])必須|不可欠|必ず(?!しも)|なければ(?:ならない|ならず|なりません)|(?<!不)必要(?:が|は)?(?:あります|です|となります)/u;
const PROHIBITED = new RegExp(
  "禁止|禁じ|てはならな|てはなりません|てはいけな|てはいけません|不可(?!欠|避|分|逆|侵)|認められません|認めません" +
    "|できません|できかねます|応じかねます|無効|失格|取消|取り消|お断り|ご遠慮|対象外",
  "u",
);
const UNITS = "字|文字|字以内|枚|ページ|頁|名|人|チーム|点|作品|件|分|秒|時間|日間|か月|ヶ月|MB|GB|KB|メガ|円|万円|歳|才|回|行|語|ワード|words?|px";
// 数量＝制限の言い方（以内・以上・上限・先着…）を伴う数、または表・箇条の短い項目の中の「数＋単位」。
// 「約1,700人が参加しました」のような実績の数は拾わない。
const QUANTITY_LIMIT = new RegExp(
  `(?:(?:最大|最小|最低|上限|下限|先着|定員)\\s*\\d)|(?:\\d[\\d,.]*\\s*(?:${UNITS})?\\s*(?:以内|以上|以下|未満|まで|を超え|を上限))|(?:\\d\\s*[〜~～-]\\s*\\d[\\d,.]*\\s*(?:${UNITS}))`,
  "u",
);
const UNITS_ITEM = UNITS.replace("|MB|GB|KB|メガ", "");
const QUANTITY_UNIT = new RegExp(`\\d[\\d,.]*\\s*(?:${UNITS_ITEM})`, "u");
// 日付の「日」「月」を数量と取り違えない
const DATEISH = /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}\s*年|\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}\s*[:：]\s*\d{2}/gu;

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
  for (const s of ss) {
    const t = nf(s.text);
    s.dates = findDates(s.text, year);
    // 見出しは塗らない（「応募が無効になる場合」は節の名前で、条項ではない）
    if (blocks[s.block].type.startsWith("h")) { s.qualifiers = []; continue; }
    // 日程表の行：期間（〜）と「エントリー・応募・提出…」が一緒にある行は、終わりの日を締切として拾う（「8月28日～11月19日 本エントリー」）
    const scheduleRow = s.dates.length >= 2 && /[〜～~]|から/u.test(t) && /エントリー|応募|提出|申込|申し込み|募集|受付|登録/u.test(t);
    if (s.dates.length && (DEADLINE_WORDS.test(t) || scheduleRow || nearDeadlineHeading(blocks, s.block))) s.labels.push("deadline");
    // よくある質問の「問い」の文（？で終わる）は、必須・禁止に数えない（答えの文で数える）
    const question = isQuestion(s);
    // 「お気軽に〜ご登録ください」「ぜひご応募ください」のような誘いは、指示の形でも必須に数えない
    const invite = /お気軽に|ぜひ|是非/u.test(t) && !REQUIRED_STRONG.test(t);
    if (REQUIRED.test(t) && !question && !invite) s.labels.push("required");
    const tq = t.replace(DATEISH, " ");
    const shortItem = !/[。．]/u.test(t) && t.length <= 30;
    if (QUANTITY_LIMIT.test(tq) || (shortItem && QUANTITY_UNIT.test(tq))) s.labels.push("quantity");
    if (PROHIBITED.test(t) && !question) s.labels.push("prohibited");
    // 箇条書き・表のセルは、属する見出しの意味を受け継ぐ（「応募が無効になる場合」の下の各項目＝禁止）
    const labelOnly = s.text.length <= 6 && !/\d/u.test(s.text);
    if ((["li", "dd", "td"].includes(blocks[s.block].type) || !s.text.includes("。")) && !labelOnly) {
      const h = sectionHeading(blocks, s.block);
      if (h && HEADING_PROHIBITED.test(nf(h)) && !s.labels.includes("prohibited")) s.labels.push("prohibited");
      // 「任意です」「応募できます」は許可の言い方＝見出しが「提出物」「応募資格」でも必須を受け継がない
      const permissive = /任意|自由|できます|可能です|かまいません|構いません/u.test(t);
      if (h && HEADING_REQUIRED.test(nf(h)) && !s.labels.includes("required") && !permissive) s.labels.push("required");
    }
    s.audiences = (Object.keys(AUDIENCE) as Audience[]).filter((a) => AUDIENCE[a].test(t));
    s.qualifiers = qualifiers(s.text, false);
  }
  markConflicts(ss);
  return ss;
}

const HEADING_PROHIBITED = /無効|禁止|失格|できないこと|ご遠慮|対象外/u;
const HEADING_REQUIRED = /応募資格|参加資格|応募条件|参加条件|対象者|必要書類|提出物|提出書類|必須/u;

/** そのブロックが属する節の見出し（直前の h1〜h6）。8ブロックより遠い見出しは使わない。 */
function sectionHeading(blocks: Block[], bi: number): string | null {
  for (let k = bi - 1; k >= Math.max(0, bi - 8); k--) {
    if (blocks[k].type.startsWith("h")) return blocks[k].text;
  }
  return null;
}

/** 直前の見出し・項目名（dt・th・短い行）が「期間・締切」を言っているか（表の「応募期間｜9月10日〜」の形）。 */
function nearDeadlineHeading(blocks: Block[], bi: number): boolean {
  for (let k = bi - 1; k >= Math.max(0, bi - 2); k--) {
    const b = blocks[k];
    const short = b.text.length <= 12;
    if ((b.type.startsWith("h") || b.type === "dt" || b.type === "th" || short) && /期間|締切|締め切|期限|〆|受付/u.test(nf(b.text)) && !/開催|開発期間/u.test(nf(b.text))) return true;
  }
  return false;
}

// --- 矛盾（同じ対象に違う日付） -------------------------------------------------------------------
// 対象語ごとに、締切として拾った文の「最後の日付」（＝終わりの日）を集め、違う日付があれば文同士を結ぶ。
const SUBJECTS: Array<[string, RegExp]> = [
  ["応募の締切", /応募(?:の)?(?:締切|締め切|期間|期限)|応募締切|応募受付|エントリー(?:締切|期間)|申込(?:締切|期間)|募集(?:期間|受付|締切)/u],
  ["提出の締切", /提出(?:の)?(?:締切|期限|期間)|作品提出|本応募/u],
];

export function markConflicts(ss: Sentence[]): void {
  for (const [, re] of SUBJECTS) {
    const group = ss.filter((s) => s.labels.includes("deadline") && re.test(nf(s.text)) && s.dates.length);
    const ends = new Map<string, Sentence[]>();
    for (const s of group) {
      // 月間・各月・次回のような別の締切の話は除く
      if (/月間|各月|毎月|次回|翌月/u.test(s.text)) continue;
      const last = s.dates[s.dates.length - 1].iso;
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
