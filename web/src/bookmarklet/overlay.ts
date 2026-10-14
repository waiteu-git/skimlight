/**
 * ブックマークレットの本体（public/bm.js に束ねる）。開いている要項ページの上に、同じ検出器でマーカーを引く。
 * - ページの本文の文字を読むだけ。ページの外へは何も送らない（読み取りビューへ渡す時だけ、このサイトの窓へ postMessage）。
 * - 文字は書き換えない。テキストノードを <mark> で包むだけで、もう一度押すと外して元に戻す。
 * - 見た目は adoptedStyleSheets（ページの CSP で style 要素が止められても使える）。
 */
import { type Block, detect, LABEL_JA, LABEL_MARK, type Label, type Sentence } from "../core/detect.ts";
import { extractBlocks } from "../core/extract.ts";

declare const __ORIGIN__: string;
const ORIGIN = __ORIGIN__;
const PRIORITY: Label[] = ["conflict", "prohibited", "deadline", "required", "quantity"];
const COLORS: Record<Label, string> = { required: "#e69f00", deadline: "#56b4e9", quantity: "#009e73", prohibited: "#d55e00", conflict: "#cc79a7" };
const DECO: Record<Label, string> = { required: "solid", deadline: "double", quantity: "dotted", prohibited: "wavy", conflict: "dashed" };
const KEY = "__tadashigakiOverlay";
const LEAF = "h1,h2,h3,h4,h5,h6,p,li,dt,dd,th,td,caption,figcaption,blockquote";

type W = Window & { [KEY]?: { undo: () => void } };
const w = window as W;

function css(): string {
  const rules = PRIORITY.map((l) => `mark[data-ra="${l}"]{--mc:${COLORS[l]};text-decoration-style:${DECO[l]}}`).join("");
  return `mark[data-ra]{color:inherit;background:none;border-radius:3px;-webkit-box-decoration-break:clone;box-decoration-break:clone;
text-decoration-line:underline;text-decoration-thickness:2px;text-underline-offset:.22em;text-decoration-color:var(--mc);
background-image:linear-gradient(color-mix(in srgb,var(--mc) 30%,transparent),color-mix(in srgb,var(--mc) 30%,transparent));
background-repeat:no-repeat;background-size:100% 100%;animation:ra-sweep .5s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--ra-i)*var(--ra-step,40ms))}
@keyframes ra-sweep{from{background-size:0% 100%;text-decoration-color:transparent}}
@media (prefers-reduced-motion:reduce){mark[data-ra]{animation:none}}
${rules}
#ra-panel{all:initial;position:fixed;z-index:2147483647;right:12px;bottom:12px;max-width:min(320px,calc(100vw - 24px));background:#fffdf8;color:#1d1d1f;
border:1px solid #e4e0d6;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.18);padding:12px 14px;font:13px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
#ra-panel *{all:revert;font:inherit;color:inherit}
#ra-panel p{margin:0 0 6px}#ra-panel ul{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-wrap:wrap;gap:4px 10px}
#ra-panel button{cursor:pointer;border:1px solid #1d1d1f;background:#1d1d1f;color:#fffdf8;border-radius:8px;padding:4px 10px;margin:0 6px 0 0}
#ra-panel button.ghost{background:transparent;color:#1d1d1f;border-color:#e4e0d6}
#ra-panel b{display:inline-grid;place-items:center;width:1.4em;height:1.4em;border-radius:4px;font-size:11px;margin-right:4px}`;
}

/** 葉の要素の中のテキストノードを、文字位置と一緒に並べる。 */
function textNodes(el: Element): Array<{ node: Text; start: number }> {
  const out: Array<{ node: Text; start: number }> = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let at = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    out.push({ node: t, start: at });
    at += t.data.length;
  }
  return out;
}

/** el の文字の [start, end) を、テキストノードごとに <mark> で包む。 */
function wrap(el: Element, start: number, end: number, label: Label, order: number, title: string, marks: HTMLElement[]) {
  for (const { node, start: ns } of textNodes(el)) {
    const ne = ns + node.data.length;
    const a = Math.max(start, ns), b = Math.min(end, ne);
    if (a >= b) continue;
    let target = node;
    if (b < ne) target.splitText(b - ns);
    if (a > ns) target = target.splitText(a - ns);
    if (!target.data.trim()) continue;
    const m = document.createElement("mark");
    m.dataset.ra = label;
    m.style.setProperty("--ra-i", String(order));
    m.title = title;
    target.replaceWith(m);
    m.append(target);
    marks.push(m);
  }
}

function undoAll(marks: HTMLElement[], panel: HTMLElement, sheet: CSSStyleSheet) {
  for (const m of marks) { const parent = m.parentNode; if (!parent) continue; m.replaceWith(...Array.from(m.childNodes)); parent.normalize(); }
  panel.remove();
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
  delete w[KEY];
}

function openReader() {
  const ex = extractBlocks(document, { live: true });
  const win = window.open(`${ORIGIN}/#bm`, "_blank");
  if (!win) { alert("読み取りビューの窓を開けませんでした（ポップアップを許可してください）"); return; }
  const payload = { type: "tadashigaki/blocks", url: location.href.split("#")[0], title: ex.title, blocks: ex.blocks };
  const onMsg = (e: MessageEvent) => {
    if (e.origin !== ORIGIN || e.source !== win || e.data?.type !== "tadashigaki/ready") return;
    win.postMessage(payload, ORIGIN);
    removeEventListener("message", onMsg);
  };
  addEventListener("message", onMsg);
}

function run() {
  if (w[KEY]) { w[KEY]!.undo(); return; } // 2回目は外す
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css());
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  // 葉の要素ごとに、生の文字（textContent）で文を分けて検出する（位置がそのままテキストノードに対応する）
  const root = document.querySelector("main,[role=main]") ?? document.body;
  const leaves = Array.from(root.querySelectorAll(LEAF)).filter((el) => !el.querySelector(LEAF) && !el.closest("#ra-panel,nav,header,footer,aside,script,style,noscript"));
  const blocks: Block[] = leaves.map((el) => ({ type: (/^H[1-6]$/.test(el.tagName) ? el.tagName.toLowerCase() : el.tagName === "LI" ? "li" : "p") as Block["type"], text: el.textContent ?? "" }));
  const ss: Sentence[] = detect(blocks, new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())));
  const marks: HTMLElement[] = [];
  let order = 0;
  for (const s of ss) {
    const lab = PRIORITY.find((l) => s.labels.includes(l));
    if (!lab) continue;
    wrap(leaves[s.block], s.start, s.end, lab, order++, s.labels.map((l) => LABEL_JA[l]).join("・"), marks);
  }
  document.documentElement.style.setProperty("--ra-step", `${Math.min(60, 2000 / Math.max(order, 1)).toFixed(1)}ms`);

  const panel = document.createElement("div");
  panel.id = "ra-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "タダシガキ");
  const p = document.createElement("p");
  p.textContent = "タダシガキ：判定はしません。該当しそうな文に色を付けただけです。";
  const ul = document.createElement("ul");
  for (const l of ["required", "deadline", "quantity", "prohibited", "conflict"] as Label[]) {
    const li = document.createElement("li");
    const b = document.createElement("b");
    b.textContent = LABEL_MARK[l];
    b.style.border = `1.5px solid ${COLORS[l]}`;
    li.append(b, `${LABEL_JA[l]} ${ss.filter((s) => s.labels.includes(l)).length}`);
    ul.append(li);
  }
  const open = document.createElement("button");
  open.textContent = "読み取りビューで開く";
  open.addEventListener("click", openReader);
  const close = document.createElement("button");
  close.className = "ghost";
  close.textContent = "消す";
  close.addEventListener("click", () => w[KEY]?.undo());
  panel.append(p, ul, open, close);
  document.body.append(panel);
  w[KEY] = { undo: () => undoAll(marks, panel, sheet) };
  if (!marks.length) p.textContent = "このページでは、マーカーを引く文が見つかりませんでした。読み取りビューで開くと読めることがあります。";
}

try { run(); } catch (e) { console.error("tadashigaki:", e); openReader(); }
