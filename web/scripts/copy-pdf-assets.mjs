/** pdf.js のワーカーと日本語の CMap を public/pdfjs/ へ写す（このサイトから配る。外部 CDN を使わない）。 */
import { cpSync, mkdirSync, readdirSync } from "node:fs";

const src = "node_modules/pdfjs-dist";
mkdirSync("public/pdfjs/cmaps", { recursive: true });
cpSync(`${src}/build/pdf.worker.min.mjs`, "public/pdfjs/pdf.worker.min.mjs");
cpSync(`${src}/LICENSE`, "public/pdfjs/LICENSE"); // Apache License 2.0 の全文（規約 第9条からリンク）
// 日本語（Adobe-Japan1）と、横書きの Unicode 系の CMap だけ（全部だと 1.6MB）
const keep = readdirSync(`${src}/cmaps`).filter((f) => /^(Adobe-Japan1|UniJIS|90ms|90pv|83pv|Add-|EUC-|H\.bcmap|V\.bcmap|Ext-|NWP-|RKSJ|Hankaku|Hiragana|Katakana|Roman|WP-Symbol|Identity|UniAKR|LICENSE)/.test(f));
for (const f of keep) cpSync(`${src}/cmaps/${f}`, `public/pdfjs/cmaps/${f}`);
console.log(`pdf.js の資産：ワーカー1・CMap ${keep.length} 本`);
