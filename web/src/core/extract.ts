/**
 * HTML の文書から、本文のブロック列（見出し・段落・箇条書き・表のセル）を取り出す。
 * 使う所は2つ：サーバーから受けた HTML を DOMParser で開いた「動かない文書」と、ブックマークレットが読む表示中のページ。
 * どちらも文字（textContent）だけを取り出し、HTML を画面へ差し込むことはしない。
 */
import type { Block, BlockType } from "./detect.ts";

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "EMBED", "CANVAS", "VIDEO", "AUDIO", "SELECT", "BUTTON", "INPUT", "TEXTAREA", "FORM", "DIALOG"]);
const CHROME = new Set(["NAV", "HEADER", "FOOTER", "ASIDE"]);
const CHROME_ROLE = /^(navigation|banner|contentinfo|complementary|search|menu|menubar|dialog)$/;
const CHROME_HINT = /(^|[\s_-])(nav|navbar|menu|header|footer|breadcrumb|sidebar|share|sns|cookie|banner|related|pagetop|gnav|global-nav)([\s_-]|$)/i;
const LEAF: Record<string, BlockType> = {
  H1: "h1", H2: "h2", H3: "h3", H4: "h4", H5: "h5", H6: "h6", P: "p", LI: "li", TH: "th", TD: "td", DT: "dt", DD: "dd", CAPTION: "caption",
  FIGCAPTION: "p", BLOCKQUOTE: "p", PRE: "p", SUMMARY: "h4",
};
const BLOCKISH = new Set(["DIV", "SECTION", "ARTICLE", "MAIN", "UL", "OL", "DL", "TABLE", "TBODY", "THEAD", "TR", "BODY", "DETAILS", "FIGURE", "CENTER"]);
const MAX_BLOCKS = 3000;
const MAX_CHARS = 200_000;

function hidden(el: Element, live: boolean): boolean {
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
  const style = (el.getAttribute("style") || "").replace(/\s/g, "").toLowerCase();
  if (style.includes("display:none") || style.includes("visibility:hidden")) return true;
  if (live && typeof getComputedStyle === "function") {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return true;
  }
  return false;
}

function isChrome(el: Element): boolean {
  if (CHROME.has(el.tagName)) return true;
  const role = el.getAttribute("role");
  if (role && CHROME_ROLE.test(role)) return true;
  const hint = `${el.id} ${typeof el.className === "string" ? el.className : ""}`;
  return CHROME_HINT.test(hint);
}

/** 本文の根：<main>／role=main／<article> が1つならそれ。無ければ body。 */
export function contentRoot(doc: Document): Element {
  const main = doc.querySelector("main, [role=main]");
  if (main) return main;
  const arts = doc.querySelectorAll("article");
  if (arts.length === 1) return arts[0];
  return doc.body ?? doc.documentElement;
}

const squash = (s: string) => s.replace(/[\u0009\u000a\u000b\u000c\u000d  ]+/g, " ").trim();

export interface PdfLink { text: string; href: string }
export interface Extracted { title: string; blocks: Block[]; truncated: boolean; pdfLinks: PdfLink[] }

/** 本文から PDF へのリンク（要項の正本が PDF のことが多い）。http(s) の絶対 URL に直す。最大10本。 */
export function pdfLinks(doc: Document, base: string): PdfLink[] {
  const out: PdfLink[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const raw = a.getAttribute("href") || "";
    let u: URL;
    try { u = new URL(raw, base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || !/\.pdf$/i.test(u.pathname) || seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ text: squash(a.textContent || "").slice(0, 80) || decodeURIComponent(u.pathname.split("/").pop() || "PDF"), href: u.href });
    if (out.length >= 10) break;
  }
  return out;
}

export function extractBlocks(doc: Document, opts: { live?: boolean; keepChrome?: boolean; base?: string } = {}): Extracted {
  const live = !!opts.live;
  const root = contentRoot(doc);
  const usingBody = root === doc.body;
  const blocks: Block[] = [];
  let chars = 0;
  let truncated = false;
  let group = 0;

  // 葉（見出し・段落・項目・セル）の文字を1ブロックに。ブロック要素の外に裸で書かれた文字（div 直下）も1ブロックに。
  const push = (type: BlockType, text: string) => {
    const t = squash(text);
    if (!t) return;
    if (blocks.length >= MAX_BLOCKS || chars + t.length > MAX_CHARS) { truncated = true; return; }
    const prev = blocks[blocks.length - 1];
    if (prev && prev.text === t && prev.type === type) return; // 同じ文の繰り返し（PC／スマホ用の重複）を1つに
    blocks.push({ type, text: t, group });
    chars += t.length;
  };

  const walk = (el: Element) => {
    if (truncated) return;
    if (SKIP.has(el.tagName) || hidden(el, live)) return;
    // body から読む時だけ、ナビ・ヘッダ・フッタらしい所を飛ばす（main が見つかった時は信じる）
    if (!opts.keepChrome && usingBody && el !== root && isChrome(el)) return;
    const leaf = LEAF[el.tagName];
    if (leaf && !el.querySelector("p, li, h1, h2, h3, h4, h5, h6, table, dl, ul, ol")) {
      push(leaf, el.textContent || "");
      return;
    }
    if (el.tagName === "UL" || el.tagName === "OL" || el.tagName === "TABLE" || el.tagName === "DL") group += 1;
    let loose = "";
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) { loose += node.textContent || ""; continue; }
      if (node.nodeType !== 1) continue;
      const child = node as Element;
      const inline = !LEAF[child.tagName] && !BLOCKISH.has(child.tagName) && !SKIP.has(child.tagName) &&
        !child.querySelector("p, li, h1, h2, h3, h4, h5, h6, table, div, section, ul, ol, dl");
      if (inline) {
        if (child.tagName === "BR") loose += "\n";
        else if (!hidden(child, live)) loose += child.textContent || "";
        continue;
      }
      for (const line of loose.split("\n")) push("p", line);
      loose = "";
      walk(child);
    }
    for (const line of loose.split("\n")) push("p", line);
  };

  walk(root);
  const title = squash(doc.querySelector("h1")?.textContent || doc.title || "");
  return { title, blocks, truncated, pdfLinks: opts.base ? pdfLinks(doc, opts.base) : [] };
}
