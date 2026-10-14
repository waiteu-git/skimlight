/**
 * 公開した後の実地確認4点を1回で測る。依存なし。
 *   node scripts/field-check.mjs <公開 URL の origin> [--no-browser]
 * 1. /api/page が動く：デプロイナウの応募要項を1回だけ読む
 * 2. 配信が圧縮されるか：トップと /_astro/ の JS・CSS を、圧縮を受け付ける要求で取り、content-encoding と転送量を見る
 * 3. 回数制限の鍵（X-Forwarded-For の右端）：
 *    a. 取りに行かない URL（https://127.0.0.1/ ＝送る前に断る）で上限まで送り、次が RATE になるか（鍵が毎回同じか）
 *    b. 自分で X-Forwarded-For を付けて送り、まだ RATE か（付けた値が鍵に使われていれば、制限をすり抜けられる）
 *    c. 端末から実行していれば、別の回線（スマホのモバイル回線）で読めるかを人に確かめてもらう
 *       （読めなければ鍵が全員で同じ＝制限が全員に効いている）
 * 4. ブックマークレット：普通のページ（マーカーが付く）と、CSP が厳しいページ（読み取りビューの窓へ逃げる）を
 *    隔離したヘッドレス Chrome で1つずつ確かめる（e2e-bookmarklet.mjs を順に呼ぶ）
 * 手元のサーバー（http://127.0.0.1:4391）にも使える。手元には前段のプロキシが無いので、3b は NG になるのが正しい（検査が効いている対照）。
 * 送る要求は全部で10回ほど。結果は ../.cache/field-check.json にも残す（git の外）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createInterface } from "node:readline/promises";

const origin = process.argv.slice(2).find((a) => /^https?:\/\//.test(a))?.replace(/\/+$/, "");
const noBrowser = process.argv.includes("--no-browser");
if (!origin) { console.error("使い方: node scripts/field-check.mjs https://<公開 URL> [--no-browser]"); process.exit(2); }
const SAMPLE = "https://lolipop.jp/deploy-now/contest/";
const NOFETCH = "http://example.com/"; // 送る前に断られる URL（https でない）。127.0.0.1 は公開側の防御（WAF）が手前で 403 にしてアプリまで届かない（10/19）
const CSP_PAGE = "https://github.com/waiteu-git/skimlight";
const result = { origin, at: new Date().toISOString() };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 自動で展開しない GET（転送された実際のバイト数を数える） */
function rawGet(url) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? httpsRequest : httpRequest)(url, { headers: { "Accept-Encoding": "br, gzip", "User-Agent": "skimlight-field-check" } }, (res) => {
      let bytes = 0; const chunks = [];
      res.on("data", (c) => { bytes += c.length; chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function api(url, extraHeaders = {}) {
  const r = await fetch(`${origin}/api/page`, { method: "POST", headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify({ url }) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: j.ok, code: j.code, htmlBytes: j.html?.length };
}

// 1. /api/page
const a = await api(SAMPLE);
result.api = { ...a, pass: a.status === 200 && a.ok === true && a.htmlBytes > 1000 };
console.log("1. /api/page", result.api.pass ? "OK" : "NG", JSON.stringify(a));

// 2. 圧縮（トップは展開して /_astro/ の参照を拾う）
const top = await rawGet(`${origin}/`);
const plain = (await (await fetch(`${origin}/`)).text());
const assets = [...new Set([...plain.matchAll(/(?:src|href)="(\/_astro\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]))];
const rows = [{ path: "/", status: top.status, enc: top.headers["content-encoding"] ?? "なし", bytes: top.bytes }];
for (const p of assets) { const g = await rawGet(origin + p); rows.push({ path: p, status: g.status, enc: g.headers["content-encoding"] ?? "なし", bytes: g.bytes }); }
const total = rows.reduce((s, r) => s + r.bytes, 0);
result.compression = { rows, totalBytes: total, server: top.headers.server ?? null, via: top.headers.via ?? null, pass: rows.every((r) => r.enc !== "なし") };
console.log("2. 圧縮", result.compression.pass ? "OK" : "圧縮なし（転送量は生のまま記録する）", `計 ${(total / 1024).toFixed(1)}KB`);
for (const r of rows) console.log(`   ${r.status} ${r.enc.padEnd(4)} ${String(r.bytes).padStart(7)}B ${r.path}`);

// 3. 回数制限の鍵
const seq = [];
for (let i = 0; i < 5; i++) seq.push((await api(NOFETCH)).code ?? "?");
const spoof = await api(NOFETCH, { "X-Forwarded-For": `203.0.113.${1 + Math.floor(Math.random() * 250)}` });
const limited = seq.includes("RATE");
result.rateKey = { seq, spoofed: spoof.code, stableKey: limited, spoofIgnored: spoof.code === "RATE" };
console.log("3a. 鍵が毎回同じ（上限で RATE になる）", limited ? "OK" : "NG", seq.join(" "));
console.log("3b. 自分で付けた X-Forwarded-For は鍵に使われない", spoof.code === "RATE" ? "OK" : "NG（すり抜けられる）", spoof.code);
if (process.stdin.isTTY && limited) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("\n3c. いまこの端末は1分間の上限に達しています。50秒以内に、スマホ（Wi-Fi を切ってモバイル回線）で");
  console.log(`    ${origin} を開き「デプロイナウの要項で試す」を押してください。`);
  const ans = (await rl.question("    要項が読めたら y、「続けて読みすぎです」が出たら n: ")).trim().toLowerCase();
  rl.close();
  result.rateKey.otherNetwork = ans === "y" ? "読めた" : ans === "n" ? "止まった" : ans;
  console.log("3c. 別の回線は止まらない", ans === "y" ? "OK" : "NG（制限が全員に効いている）");
} else {
  result.rateKey.otherNetwork = "未確認（端末から実行すると聞く）";
  console.log("3c. 別の回線での確認は飛ばした（端末から実行すると聞きます）");
}

// 4. ブックマークレット（Chrome は1つずつ）
if (noBrowser) {
  result.bookmarklet = "飛ばした（--no-browser）";
} else {
  console.log("4. ブックマークレット（1分待ってから。3 の上限が残っていると読み取りビューの取得が止まるため）");
  await sleep(61_000);
  const runs = [];
  for (const page of [SAMPLE, CSP_PAGE]) {
    const r = spawnSync(process.execPath, [new URL("./e2e-bookmarklet.mjs", import.meta.url).pathname, page, origin], { encoding: "utf-8", timeout: 60_000 });
    let j = null; try { j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))); } catch { /* */ }
    runs.push({ page, out: j, err: j ? undefined : (r.stderr || r.stdout).slice(0, 300) });
  }
  const [plainPage, cspPage] = runs;
  result.bookmarklet = {
    runs,
    onPagePass: (plainPage.out?.onPage?.marks ?? 0) > 0,
    cspFallbackPass: !!cspPage.out?.readerOpened && !!cspPage.out?.readerState?.shown,
  };
  console.log("4a. 普通のページでマーカーが付く", result.bookmarklet.onPagePass ? "OK" : "NG", plainPage.out?.onPage ?? plainPage.err);
  console.log("4b. CSP が厳しいページで読み取りビューへ逃げる", result.bookmarklet.cspFallbackPass ? "OK" : "NG", cspPage.out?.readerState ?? cspPage.err);
}

const out = new URL("../../.cache/field-check.json", import.meta.url).pathname;
mkdirSync(new URL("../../.cache/", import.meta.url).pathname, { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
console.log(`\n記録: ${out}`);
