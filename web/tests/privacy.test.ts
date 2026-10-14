/**
 * プライバシーの約束を実装で固定する（規約・PP の清書の根拠）。
 * 1. サーバーのログに、IP・URL・本文が出ない（URL は sha256 の先頭12桁だけ）
 * 2. ブラウザ側のコードが外へ送るのは「取得口へ URL を送る」1か所だけ。貼り付け・ブックマークレットの本文は送らない
 * 3. ブックマークレットの postMessage は、宛先の origin を固定している
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { POST } from "../src/pages/api/page.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf-8");
const NET = /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts)\b|new\s+Image\b|\.src\s*=/g;

async function capture(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig) as Array<keyof typeof orig>) console[k] = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try { await fn(); } finally { Object.assign(console, orig); }
  return lines.join("\n");
}

const call = (url: string, ip: string) => POST({
  request: new Request("http://127.0.0.1/api/page", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.9, ${ip}` }, body: JSON.stringify({ url }),
  }),
  clientAddress: ip,
} as never);

test("サーバーのログに IP・URL・URL から作った記号が出ない（拒否・回数超過の経路）", async () => {
  const ip = "198.51.100.77";
  const secretUrl = "https://printer.local/private/path?token=abc123";
  const out = await capture(async () => { for (let i = 0; i < 7; i++) await call(secretUrl, ip); });
  for (const leak of [ip, "203.0.113.9", "printer.local", "private/path", "abc123"]) assert.ok(!out.includes(leak), `ログに ${leak} が出ています:\n${out}`);
  for (const line of out.split("\n").filter(Boolean)) {
    const j = JSON.parse(line);
    assert.deepEqual(Object.keys(j).sort().filter((k) => !["bytes", "code"].includes(k)), ["ev", "ok"]);
  }
});

test("サーバーのログ出力は取得口の2か所だけ", () => {
  for (const f of ["server/safefetch.ts", "core/detect.ts", "core/extract.ts", "core/topics.ts", "core/quotes.ts", "core/adjudicate.ts", "core/textnorm.ts", "core/vocab.ts"]) {
    assert.ok(!/console\./.test(src(f)), f);
  }
  const page = src("pages/api/page.ts");
  assert.equal((page.match(/console\./g) ?? []).length, 2);
  for (const m of page.matchAll(/console\.log\((.*)\);/g)) assert.ok(!/url/i.test(m[1]), "ログに URL 由来の値がある");
  assert.ok(!/createHash|digest\(/.test(page), "URL の記号（ハッシュ）を作っている");
});

test("ブラウザ側が外へ送るのは、取得口への URL だけ", () => {
  const app = src("client/app.ts");
  const calls = [...app.matchAll(NET)].map((m) => m[0]);
  assert.deepEqual(calls, ["fetch"]);
  assert.match(app, /fetch\("\/api\/page", \{ method: "POST", headers: \{ "Content-Type": "application\/json" \}, body: JSON\.stringify\(\{ url \}\) \}\)/);
  // 貼り付け・ブックマークレットの本文は、表示の関数に渡るだけ
  assert.match(app, /readPasted\(\$<HTMLTextAreaElement>\("paste-text"\)\.value\)/);
  for (const f of ["bookmarklet/overlay.ts", "core/extract.ts", "core/detect.ts", "core/topics.ts", "core/pdflayout.ts", "client/pdf.ts"]) {
    assert.deepEqual([...src(f).matchAll(NET)].map((m) => m[0]), [], f);
  }
});

test("ブックマークレットの受け渡しは宛先の origin を固定する", () => {
  const overlay = src("bookmarklet/overlay.ts");
  assert.match(overlay, /win\.postMessage\(payload, ORIGIN\)/);
  assert.match(overlay, /e\.origin !== ORIGIN/);
  const loader = src("bookmarklet/loader.ts");
  assert.match(loader, /w\.postMessage\(\{type:'tadashigaki\/text'.*?\},o\)/);
  assert.match(loader, /e\.origin===o&&e\.source===w/);
  // 読み取りビュー側：開いた窓からだけ受け、「準備できた」には中身を載せない
  const app = src("client/app.ts");
  assert.match(app, /if \(e\.source !== window\.opener\) return;/);
  assert.match(app, /window\.opener\.postMessage\(\{ type: "tadashigaki\/ready" \}, "\*"\)/);
});

test("立場の選択は端末の localStorage だけ。選び直すと消える", () => {
  const app = src("client/app.ts");
  assert.match(app, /localStorage\.setItem\(PROFILE_KEY/);
  assert.match(app, /localStorage\.removeItem\(PROFILE_KEY\)/);
  assert.ok(!/profile|PROFILE/.test(app.slice(app.indexOf('fetch("/api/page"'), app.indexOf('fetch("/api/page"') + 200)));
});

test("PDF はこの端末の中で読む。pdf.js の資産はこのサイトから配る（外部 CDN なし）", () => {
  const pdf = src("client/pdf.ts");
  assert.match(pdf, /workerSrc = "\/pdfjs\/pdf\.worker\.min\.mjs"/);
  assert.match(pdf, /cMapUrl: "\/pdfjs\/cmaps\/"/);
  assert.match(pdf, /getDocument\(\{\s*data,/);
  assert.ok(!/https?:\/\//.test(pdf.replace(/\/\*[\s\S]*?\*\//g, "")), "PDF の読み込みに外部の URL がある");
  assert.match(pdf, /isEvalSupported: false/);
});

test("規約・プライバシーポリシーの文が、実装の事実と対応している（どちらかを変えたら両方直す）", () => {
  const pp = src("pages/privacy.astro");
  const app = src("client/app.ts");
  const page = src("pages/api/page.ts");
  // 立場：選ぶと保存・選び直すで消える
  assert.match(pp, /立場を選ぶと、このブラウザの中（localStorage）に保存されます。「選び直す」で消えます。/);
  assert.match(app, /localStorage\.removeItem\(PROFILE_KEY\)/);
  // URL：記録に残さない（記号も）
  assert.match(pp, /URL も、URL から作った記号も残しません/);
  assert.ok(!/createHash/.test(page));
  // IP：約1分で掃除
  assert.match(pp, /最後に使ってから約1分を過ぎると、30秒ごとの掃除で消えます/);
  assert.match(page, /setInterval\(/);
  assert.match(page, /const WINDOW_MS = 60_000/);
  // PDF・貼り付け：送らない／pdf.js はこのサイトから
  assert.match(pp, /PDF・貼り付けた文章：ブラウザの中だけで読み取り、サーバーへ送りません/);
  assert.match(pp, /pdf\.js）は、このサイトから配ります/);
  // ブックマークレット：部品の読み込みにアドレスを付けない
  assert.match(pp, /部品を読み込む時の通信には、開いていたページのアドレスを付けません/);
  assert.match(src("bookmarklet/loader.ts"), /referrerPolicy='no-referrer'/);
  // 判定しない：トップの固定表示と規約
  assert.match(src("pages/index.astro"), /このページは判定しません。/);
  assert.match(src("pages/terms.astro"), /応募の条件を満たすかどうかは判定しません/);
});

test("「引用なし」の意味は、画面・論点・規約で同じ言い方（条件が無いという意味ではない）", () => {
  const phrase = /条件が無いという意味ではありません/;
  assert.match(src("pages/index.astro"), phrase);
  assert.match(src("pages/terms.astro"), phrase);
  assert.match(src("core/topics.ts"), /NO_QUOTE_MEANING = ".*条件が無いという意味ではありません。"/);
  // 「書いていない」と言い切る言い方を画面に残さない
  for (const f of ["pages/index.astro", "client/app.ts", "core/topics.ts"]) {
    assert.ok(!/引用なし」は書いていない|引用なし＝書いていない/.test(src(f)), f);
  }
});

test("IP は窓（1分）を過ぎると掃除で消える（覚えたままにしない）", async (t) => {
  const { _rememberedClients } = await import("../src/pages/api/page.ts");
  await call("https://printer.local/a", "198.51.100.1");
  await call("https://printer.local/a", "198.51.100.2");
  assert.ok(_rememberedClients() >= 2);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 5 * 60_000 }); // 5分後
  await call("https://printer.local/a", "198.51.100.3");
  assert.equal(_rememberedClients(), 1); // 古い IP は消え、いまの1件だけ
});

test("全体の上限では「混み合っています」（回数超過とは別の文）", () => {
  const page = src("pages/api/page.ts");
  assert.match(page, /code: "BUSY", message: "いま混み合っています/);
  assert.match(page, /code: "RATE", message: "続けて読みすぎです/);
});
