/** 清書（docs/legal/*.md）と、画面のページ（src/pages/*.astro）の文が一字違わず同じであること。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf-8");
const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function fromMd(md: string): string[] {
  return md.replace(/〔(\/pdfjs\/\S+) へのリンク〕/g, "$1").split("\n")
    .filter((l) => l.trim() && !l.startsWith("# ") && !l.startsWith("施行日"))
    .map((l) => l.replace(/^(## |\d+\. |- )/, "").trim());
}
function fromAstro(src: string): string[] {
  const body = src.split("---")[2].replace(/<a href="[^"]+">([^<]+)<\/a>/g, "$1").replace(/\{EFFECTIVE_DATE[^}]*\}　/g, "");
  return [...body.matchAll(/<(?:h2|p|li)(?: class="meta")?>([\s\S]*?)<\/(?:h2|p|li)>/g)].map((m) => unescape(m[1]).replace("施行日：", "").trim());
}

for (const name of ["terms", "privacy"]) {
  test(`清書と画面の文が同じ（${name}）`, () => {
    assert.deepEqual(fromAstro(read(`../src/pages/${name}.astro`)), fromMd(read(`../../docs/legal/${name}.md`)));
  });
}
