/**
 * 画面の組み立て。取得した HTML は DOMParser の「動かない文書」で開き、文字だけを取り出す。
 * 画面へ入れるのは textContent だけ（innerHTML に外部の文字を入れない）。
 */
import { type Block, detect, LABEL_HELP, LABEL_JA, LABEL_MARK, type Label, type Sentence } from "../core/detect.ts";
import { extractBlocks } from "../core/extract.ts";
import { NO_QUOTE_MEANING, otherAudience, type Profile, TOPICS, topicStatus, WEB_EXCEPTION } from "../core/topics.ts";
import { SAMPLE_BLOCKS, SAMPLE_TITLE } from "../core/sample.ts";
import { NO_QUOTE, REVIEW } from "../core/adjudicate.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const PRIORITY: Label[] = ["conflict", "prohibited", "deadline", "required", "quantity"];
const PROFILE_KEY = "tadashigaki-profile";

interface State { title: string; source: string; blocks: Block[]; ss: Sentence[] }
let state: State | null = null;

// --- 計測（docs/perf-log.md の3つ） ---------------------------------------------------------------
const perf = { fcp: 0, transfer: 0, markerMs: 0, markerPlannedMs: 0, markerVisible: 0, sentences: 0 };
(window as unknown as { __tadashigakiPerf: typeof perf }).__tadashigakiPerf = perf;
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name === "first-contentful-paint") perf.fcp = Math.round(e.startTime);
  }).observe({ type: "paint", buffered: true });
} catch { /* 計測できない環境は諦める */ }
addEventListener("load", () => {
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  perf.transfer = (nav?.transferSize ?? 0) + res.reduce((a, r) => a + (r.transferSize || 0), 0);
});

// --- 入力 ------------------------------------------------------------------------------------------
const msg = (text: string, err = false) => { const m = $("msg"); m.textContent = text; m.classList.toggle("err", err); };

async function readUrl(url: string) {
  const go = $<HTMLButtonElement>("go");
  go.disabled = true;
  msg("ページを読んでいます…");
  try {
    const res = await fetch("/api/page", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    const data = await res.json();
    if (!data.ok) {
      msg(data.message + (data.detail ? `　転送先：${data.detail}` : ""), true);
      if (data.code === "REDIRECT" && data.detail) $<HTMLInputElement>("url").value = data.detail;
      else if (!["BAD_URL", "NOT_HTTPS", "PRIVATE"].includes(data.code)) offerPaste(url); // 公開ページで取れなかった時だけ
      return;
    }
    const doc = new DOMParser().parseFromString(data.html, "text/html");
    const ex = extractBlocks(doc, { base: data.url });
    showPdfHint(ex.pdfLinks);
    if (ex.blocks.length < 3) {
      msg("本文がほとんど取れませんでした。画面で文字を描くページかもしれません。ブックマークレットか、文章の貼り付けを使ってください。", true);
      return;
    }
    show({ title: ex.title, source: data.url, blocks: ex.blocks });
    msg(ex.truncated ? "長いページなので、途中までを読みました。" : "");
  } catch {
    msg("ページを読めませんでした。時間をおいてもう一度どうぞ。", true);
    offerPaste(url);
  } finally {
    go.disabled = false;
  }
}

/** 取れなかった時の退路：貼り付け欄を開き、元のページを開く導線を出す（見本はそのまま残す） */
function offerPaste(url: string) {
  const box = $("paste");
  box.hidden = false;
  $("toggle-paste").setAttribute("aria-expanded", "true");
  const ta = $<HTMLTextAreaElement>("paste-text");
  ta.placeholder = "元のページを開き、本文をすべて選んでコピーし、ここに貼り付けて「読む」";
  const m = $("msg");
  if (/^https?:\/\//.test(url)) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "元のページを開く";
    m.append("　", a, "（開いて本文をコピーし、下の欄へ貼り付けると読めます）");
  }
}

function showPdfHint(links: Array<{ text: string; href: string }>) {
  const box = $("pdfhint");
  const ul = $("pdfhint-list");
  ul.textContent = "";
  box.hidden = links.length === 0;
  for (const l of links) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = l.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = l.text;
    li.append(a);
    ul.append(li);
  }
}

async function readPdf(file: File) {
  msg("PDF をこの端末の中で読んでいます（送りません）…");
  showPdfHint([]);
  try {
    const { pdfToBlocks } = await import("./pdf.ts");
    const r = await pdfToBlocks(file);
    if (r.blocks.length < 2) {
      msg("PDF から文字を取り出せませんでした。画像だけの PDF（スキャン）は読めません。", true);
      return;
    }
    show({ title: r.title, source: `PDF：${file.name}（${r.pages} ページ・この端末の中だけ）`, blocks: r.blocks });
    msg(r.truncated ? "長い PDF なので、最初の 80 ページまでを読みました。" : "");
  } catch (e) {
    console.warn("tadashigaki: PDF", e); // 利用者の端末のコンソールだけ（どこへも送らない）
    msg(e instanceof Error && e.message.includes("大きすぎ") ? e.message : "PDF を読めませんでした。", true);
  }
}

function readPasted(text: string) {
  const blocks: Block[] = text.split(/\n+/).map((t) => t.trim()).filter(Boolean)
    .map((t) => ({ type: t.length <= 20 && !/[。、，．]/u.test(t) && !/\d/.test(t) ? "h3" : "p", text: t }) as Block);
  if (!blocks.length) { msg("文章を貼り付けてください。", true); return; }
  show({ title: "貼り付けた文章", source: "貼り付けた文章（この端末の中だけ）", blocks });
  msg("");
}

// --- 表示 ------------------------------------------------------------------------------------------
function show(input: { title: string; source: string; blocks: Block[] }, initial = false) {
  const t0 = performance.now();
  $("demo-note").hidden = !initial;
  const ss = detect(input.blocks, todayUtc());
  state = { ...input, ss };
  $("main").hidden = false;
  $("src").textContent = `出典：${input.source}`;
  renderDoc();
  renderSide();
  renderTimeline();
  applyProfile();
  run(t0, initial);
}

const todayUtc = () => { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); };
const primary = (s: Sentence) => PRIORITY.find((l) => s.labels.includes(l));

function renderDoc() {
  const { blocks, ss } = state!;
  const doc = $("doc");
  doc.textContent = "";
  const bySent = new Map<number, Sentence[]>();
  for (const s of ss) bySent.set(s.block, [...(bySent.get(s.block) ?? []), s]);
  let list: HTMLElement | null = null;
  let listGroup = -1;
  let order = 0;
  blocks.forEach((b, bi) => {
    let el: HTMLElement;
    if (b.type === "li") {
      if (!list || listGroup !== b.group) { list = document.createElement("ul"); doc.append(list); listGroup = b.group ?? -1; }
      el = document.createElement("li");
      list.append(el);
    } else {
      list = null;
      const tag = b.type === "th" || b.type === "dt" ? "dt" : b.type === "td" || b.type === "dd" ? "dd" : b.type === "caption" ? "p" : b.type;
      el = document.createElement(tag);
      const sec = document.createElement("section");
      sec.className = "block";
      sec.append(el);
      doc.append(sec);
    }
    let at = 0;
    for (const s of bySent.get(bi) ?? []) {
      if (s.start > at) el.append(b.text.slice(at, s.start));
      const lab = primary(s);
      const node = document.createElement(lab ? "mark" : "span");
      node.dataset.sid = String(s.id);
      appendWithProviso(node, s.text);
      if (lab) {
        node.className = `m-${lab}`;
        node.tabIndex = 0;
        node.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); showPop(node); } });
        node.style.setProperty("--i", String(order++));
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.setAttribute("aria-hidden", "true");
        tag.textContent = s.labels.map((l) => LABEL_MARK[l]).join("");
        const vh = document.createElement("span");
        vh.className = "vh";
        vh.textContent = `（${s.labels.map((l) => LABEL_JA[l]).join("・")}）`;
        node.append(tag, vh);
      }
      el.append(node);
      at = s.end;
    }
    if (at < b.text.length) el.append(b.text.slice(at));
  });
  perf.sentences = order;
}

/** ただし書きの語（ただし・除く・以外…）を太字で包んで足す。文字は textContent で入れる。 */
function appendWithProviso(node: HTMLElement, text: string) {
  let at = 0;
  for (const m of text.matchAll(WEB_EXCEPTION)) {
    const i = m.index ?? 0;
    if (i > at) node.append(text.slice(at, i));
    const b = document.createElement("b");
    b.className = "tg";
    b.textContent = m[0];
    node.append(b);
    at = i + m[0].length;
  }
  if (at < text.length) node.append(text.slice(at));
}

function replay(el: HTMLElement) {
  el.classList.remove("resweep");
  void el.offsetWidth; // 走り直すために一度だけ
  el.classList.add("resweep");
}

function jump(sid: number) {
  const el = document.querySelector<HTMLElement>(`[data-sid="${sid}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1200);
  if (el.tagName === "MARK") replay(el);
  // 食い違いは相手の文も一緒に光らせる
  for (const other of state?.ss[sid]?.conflictWith ?? []) {
    const o = document.querySelector<HTMLElement>(`[data-sid="${other}"]`);
    if (o) { o.classList.add("flash"); replay(o); setTimeout(() => o.classList.remove("flash"), 1600); }
  }
}

function sentenceButton(s: Sentence): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.sid = String(s.id);
  b.textContent = s.text.length > 90 ? s.text.slice(0, 88) + "…" : s.text;
  b.addEventListener("click", () => jump(s.id));
  return b;
}

function renderSide() {
  const { ss, blocks } = state!;
  const isHeading = (s: Sentence) => blocks[s.block].type.startsWith("h");
  const topics = $("topics");
  topics.textContent = "";
  for (const t of TOPICS) {
    const r = topicStatus(t, ss, isHeading);
    const li = document.createElement("li");
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    const q = document.createElement("span");
    q.textContent = t.q;
    const st = document.createElement("span");
    st.className = `st ${r.status === REVIEW ? "s-review" : r.status === NO_QUOTE ? "s-none" : "s-quoted"}`;
    st.textContent = r.status;
    if (r.status === NO_QUOTE) st.title = NO_QUOTE_MEANING;
    sum.append(q, st);
    det.append(sum);
    for (const why of r.reasons) { const p = document.createElement("p"); p.className = "why"; p.textContent = why; det.append(p); }
    for (const s of r.sentences.slice(0, 6)) { const d = document.createElement("div"); d.className = "q"; d.append(sentenceButton(s)); det.append(d); }
    li.append(det);
    topics.append(li);
  }
  const groups = $("groups");
  groups.textContent = "";
  {
    const prov = ss.filter((x) => !isHeading(x) && new RegExp(WEB_EXCEPTION.source, "u").test(x.text));
    const li = document.createElement("li");
    const h = document.createElement("h3");
    const k = document.createElement("span");
    k.className = "k k-tg";
    k.textContent = "但";
    h.append(k, `ただし書き　${prov.length}`);
    li.append(h);
    if (prov.length) {
      const ol = document.createElement("ol");
      for (const x of prov) { const i = document.createElement("li"); i.append(sentenceButton(x)); ol.append(i); }
      li.append(ol);
    } else {
      const p = document.createElement("p"); p.className = "empty"; p.textContent = "見つかりませんでした"; li.append(p);
    }
    groups.append(li);
  }
  for (const l of ["required", "deadline", "quantity", "prohibited", "conflict"] as Label[]) {
    const hit = ss.filter((s) => s.labels.includes(l));
    const li = document.createElement("li");
    const h = document.createElement("h3");
    const k = document.createElement("span");
    k.className = `k k-${l}`;
    k.textContent = LABEL_MARK[l];
    h.append(k, `${LABEL_JA[l]}　${hit.length}`);
    li.append(h);
    if (hit.length) {
      const ol = document.createElement("ol");
      for (const s of hit) { const i = document.createElement("li"); i.append(sentenceButton(s)); ol.append(i); }
      li.append(ol);
    } else {
      const p = document.createElement("p"); p.className = "empty"; p.textContent = "見つかりませんでした"; li.append(p);
    }
    groups.append(li);
  }
}

function renderTimeline() {
  const { ss } = state!;
  const pts = new Map<string, { iso: string; time?: string; label: string; kind: string; sid: number }>();
  for (const s of ss) for (const d of s.dates) {
    const key = d.iso + (d.time ?? "");
    if (pts.has(key)) continue;
    const kind = s.labels.includes("conflict") ? "conflict" : s.labels.includes("deadline") ? "deadline" : "date";
    pts.set(key, { iso: d.iso, time: d.time, label: s.text.replace(/\s+/g, " ").slice(0, 24), kind, sid: s.id });
  }
  const list = [...pts.values()].sort((a, b) => (a.iso + (a.time ?? "")).localeCompare(b.iso + (b.time ?? "")));
  const box = $("timeline");
  box.hidden = list.length === 0;
  if (!list.length) return;
  const ms = (iso: string) => Date.parse(iso + "T00:00:00Z");
  const today = todayUtc().getTime();
  const lo = Math.min(today, ms(list[0].iso));
  const hi = Math.max(today, ms(list[list.length - 1].iso));
  const span = Math.max(hi - lo, 86_400_000);
  const pos = (t: number) => `${(4 + ((t - lo) / span) * 92).toFixed(2)}%`;
  const bar = $("tl-bar");
  bar.textContent = "";
  const td = document.createElement("div");
  td.className = "tl-today";
  td.style.left = pos(today);
  const tl = document.createElement("span"); tl.textContent = "今日"; td.append(tl);
  bar.append(td);
  const ul = $("tl-list");
  ul.textContent = "";
  let lastPct = -100;
  let lower = false;
  for (const p of list) {
    const b = document.createElement("button");
    const pct = 4 + ((ms(p.iso) - lo) / span) * 92;
    lower = pct - lastPct < 7 ? !lower : false; // 近い点はラベルを上下に振り分ける
    lastPct = pct;
    b.type = "button";
    b.className = `tl-pt is-${p.kind}${lower ? " lower" : ""}`;
    b.style.left = pos(ms(p.iso));
    const md = `${Number(p.iso.slice(5, 7))}/${Number(p.iso.slice(8, 10))}`;
    b.title = `${p.iso}${p.time ? " " + p.time : ""}　${p.label}`;
    b.setAttribute("aria-label", b.title);
    const i = document.createElement("i"); const lb = document.createElement("b"); lb.textContent = md;
    b.append(i, lb);
    b.addEventListener("click", () => jump(p.sid));
    bar.append(b);
    const li = document.createElement("li");
    const days = Math.round((ms(p.iso) - today) / 86_400_000);
    const when = days > 0 ? `あと${days}日` : days === 0 ? "今日" : `${-days}日前`;
    li.textContent = `${p.kind === "deadline" ? "締" : p.kind === "conflict" ? "違" : "・"} ${p.iso}${p.time ? " " + p.time : ""}（${when}）${p.label}`;
    ul.append(li);
  }
}

// --- 印を押すと意味が出る（凡例を印そのものに持たせる） ----------------------------------------------
function showPop(target: HTMLElement) {
  const pop = $("pop");
  const sid = Number(target.dataset.sid);
  const s = state?.ss[sid];
  if (!s) return;
  pop.textContent = "";
  for (const l of PRIORITY.filter((x) => s.labels.includes(x))) {
    const row = document.createElement("p");
    const k = document.createElement("span");
    k.className = `k k-${l}`;
    k.textContent = LABEL_MARK[l];
    const b = document.createElement("b");
    b.textContent = LABEL_JA[l];
    row.append(k, b, "：", LABEL_HELP[l]);
    pop.append(row);
  }
  if (target.querySelector("b.tg")) {
    const row = document.createElement("p");
    const b = document.createElement("b");
    b.className = "tg-legend";
    b.textContent = "ただし書き";
    row.append(b, "：条件や例外を足す語。見落としやすい所です");
    pop.append(row);
  }
  if (!pop.childElementCount) return;
  // 押した印の段落（箇条の項目）の中に差し込む＝上の段落の高さが後から変わっても位置がずれない
  const host = target.closest<HTMLElement>("li, section.block") ?? $("doc");
  host.append(pop);
  pop.hidden = false;
}
$("doc").addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("mark, [data-sid]");
  if (t && t.tagName === "MARK") { showPop(t); e.stopPropagation(); }
});
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("#pop")) $("pop").hidden = true;
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("pop").hidden = true; });

// --- 立場 -------------------------------------------------------------------------------------------
function readProfile(): Profile {
  const f = new FormData($<HTMLFormElement>("profile"));
  const p: Profile = {};
  for (const k of ["role", "party", "age", "home"] as const) { const v = f.get(k); if (v) (p as Record<string, string>)[k] = String(v); }
  return p;
}

function applyProfile() {
  if (!state) return;
  const p = readProfile();
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* 保存できなくても動く */ }
  let dimmed = 0;
  for (const s of state.ss) {
    const off = otherAudience(s, p);
    if (off && s.labels.length) dimmed += 1;
    document.querySelectorAll<HTMLElement>(`[data-sid="${s.id}"]`).forEach((el) => el.classList.toggle("dim", off));
  }
  $("dimnote").textContent = dimmed ? `ほかの立場向けの条項 ${dimmed} 件を薄くしています（消してはいません）。` : "";
}

function restoreProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}") as Record<string, string>;
    for (const [k, v] of Object.entries(p)) {
      const el = document.querySelector<HTMLInputElement>(`#profile input[name="${k}"][value="${v}"]`);
      if (el) el.checked = true;
    }
  } catch { /* 無ければ空のまま */ }
}

// --- マーカーを走らせる（CSS だけ） --------------------------------------------------------------
function run(t0: number, initial = false) {
  const main = $("main");
  main.classList.remove("running");
  const n = Math.max(perf.sentences, 1);
  document.documentElement.style.setProperty("--step", `${Math.min(60, 2000 / n).toFixed(1)}ms`);
  void main.offsetWidth; // 走り直すために一度だけ
  main.classList.add("running");
  // 読み込んだら時間軸（無ければ本文）の頭まで送る
  if (!initial) ($("timeline").hidden ? $("paper") : $("timeline")).scrollIntoView({ block: "start" });
  const marks = [...document.querySelectorAll<HTMLElement>("#doc mark")];
  const step = Math.min(60, 2000 / n);
  perf.markerPlannedMs = Math.round(Math.max(marks.length - 1, 0) * step + 500);
  // 画面外の段落は content-visibility で描画を後回しにする＝そこではアニメーションが走らない。
  // 計測は「最初の画面に見えているマーカーの最後」で取る（位置は走らせる前に1回だけ読む）。
  const visible = marks.filter((m) => m.getBoundingClientRect().top < innerHeight);
  const last = visible[visible.length - 1];
  if (!last || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    perf.markerMs = Math.max(1, Math.round(performance.now() - t0));
    return;
  }
  last.addEventListener("animationend", () => {
    perf.markerMs = Math.round(performance.now() - t0);
    perf.markerVisible = visible.length;
    performance.mark("tadashigaki:marker-done");
  }, { once: true });
}

// --- つなぐ -------------------------------------------------------------------------------------------
$<HTMLFormElement>("ask").addEventListener("submit", (e) => { e.preventDefault(); readUrl($<HTMLInputElement>("url").value); });
$("sample").addEventListener("click", (e) => {
  const url = (e.currentTarget as HTMLElement).dataset.url!;
  $<HTMLInputElement>("url").value = url;
  readUrl(url);
});
// 約束：押すと短い説明を1つだけ開く（スマホでも見える。もう一度押すと閉じる）
for (const b of document.querySelectorAll<HTMLButtonElement>(".promises button")) {
  b.addEventListener("click", () => {
    const note = $("promise-note");
    const open = b.getAttribute("aria-expanded") !== "true";
    document.querySelectorAll(".promises button").forEach((x) => x.setAttribute("aria-expanded", "false"));
    b.setAttribute("aria-expanded", String(open));
    note.textContent = open ? b.dataset.note ?? "" : "";
    note.hidden = !open;
  });
}
$("toggle-paste").addEventListener("click", (e) => {
  const box = $("paste");
  box.hidden = !box.hidden;
  (e.currentTarget as HTMLElement).setAttribute("aria-expanded", String(!box.hidden));
});
$("paste-go").addEventListener("click", () => readPasted($<HTMLTextAreaElement>("paste-text").value));
$<HTMLInputElement>("pdf").addEventListener("change", (e) => {
  const input = e.currentTarget as HTMLInputElement;
  const f = input.files?.[0];
  if (f) readPdf(f);
  input.value = "";
});
$("profile").addEventListener("change", applyProfile);

// --- ブックマークレットから受け取る（このサイトの窓を開いた要項ページだけから） -----------------------------
const BLOCK_TYPES = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "th", "td", "dt", "dd", "caption"]);
function fromBookmarklet() {
  if (location.hash !== "#bm" || !window.opener) return;
  msg("要項のページから文章を受け取っています…");
  addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window.opener) return;
    const d = e.data as { type?: string; url?: unknown; title?: unknown; blocks?: unknown; text?: unknown };
    const src = typeof d?.url === "string" && /^https?:\/\//.test(d.url) ? d.url.slice(0, 2048) : "要項のページ";
    const title = typeof d?.title === "string" ? d.title.slice(0, 200) : "";
    if (d?.type === "tadashigaki/blocks" && Array.isArray(d.blocks)) {
      const blocks = (d.blocks as Array<{ type?: unknown; text?: unknown }>).slice(0, 3000)
        .filter((b) => typeof b?.text === "string" && BLOCK_TYPES.has(String(b.type)))
        .map((b) => ({ type: b.type, text: (b.text as string).slice(0, 10_000) }) as Block);
      if (blocks.length) { show({ title, source: src, blocks }); msg(""); }
    } else if (d?.type === "tadashigaki/text" && typeof d.text === "string") {
      readPasted(d.text.slice(0, 200_000));
      $("src").textContent = `出典：${src}（ページの上で読んだ文字）`;
    }
  });
  // 準備できたことだけを知らせる（中身は何も送らない）
  window.opener.postMessage({ type: "tadashigaki/ready" }, "*");
}
fromBookmarklet();

// 初めて開いた時：通信なしで見本（架空の要項）を走らせる＝触る前に何が起きるかが見える
// 見出しと入力欄を先に描いてから組み立てる（最初の描画を待たせない）
// 背景のタブでは requestAnimationFrame が来ないので、時間でも必ず組み立てる（どちらか早い方の1回だけ）
if (location.hash !== "#bm") {
  let done = false;
  const demo = () => {
    if (done || state) return;
    done = true;
    show({ title: SAMPLE_TITLE, source: "見本（架空の要項・この端末の中だけ）", blocks: SAMPLE_BLOCKS }, true);
  };
  requestAnimationFrame(() => setTimeout(demo, 0));
  setTimeout(demo, 250);
}
$("profile").addEventListener("reset", () => setTimeout(() => {
  applyProfile();
  try { localStorage.removeItem(PROFILE_KEY); } catch { /* 無くても動く */ }
}, 0));
restoreProfile();
// 立場の選択は、広い画面では開いておく（スマホでは畳んで本文を先に見せる）
if (matchMedia("(min-width: 700px)").matches) ($("profile-box") as HTMLDetailsElement).open = true;
