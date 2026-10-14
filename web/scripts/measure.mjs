/**
 * 重さの計測（docs/perf-log.md の3つ）。依存なし：端末の Chrome を隔離した使い捨てのプロファイルで起動し、
 * DevTools のプロトコル（Node の WebSocket）で操作する。
 *
 *   node scripts/measure.mjs [http://127.0.0.1:4391/] [--width 390] [--sample|--paste <file>]
 *
 * 測るもの：初期表示の転送量（HTML＋読み込んだ JS/CSS。キャッシュなし）・最初の描画（first-contentful-paint）・
 *           マーカー完走（解析を始めてから最後の <mark> の animationend まで）。
 * --sample はサンプル（デプロイナウの要項）を読む＝外部へ GET が1回出る。--paste は手元のファイルを貼り付けとして読む（外へ出ない）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4391/";
const width = Number(args[args.indexOf("--width") + 1]) || 1280;
const height = width < 600 ? 844 : 900;
const mode = args.includes("--sample") ? "sample" : args.includes("--paste") ? "paste" : "none";
const pasteFile = mode === "paste" ? args[args.indexOf("--paste") + 1] : null;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9300 + Math.floor(Math.random() * 500);

const profile = mkdtempSync(join(tmpdir(), "rule-audit-measure-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-background-networking", "--disable-component-update", "--disable-sync",
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, `--window-size=${width},${height}`, "about:blank",
], { stdio: "ignore", detached: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 起動待ち */ }
    await sleep(200);
  }
  throw new Error("Chrome に接続できませんでした");
}

let ws; let seq = 0; const waiting = new Map(); const events = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  waiting.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

try {
  ws = new WebSocket(await target());
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); }
    else if (m.method) events.push(m);
  });
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await send("Page.navigate", { url });
  for (let i = 0; i < 100 && !events.some((e) => e.method === "Page.loadEventFired"); i++) await sleep(100);
  await sleep(300);
  // 初期表示の転送量：最初の読み込みで受けた全リソースの符号化後の長さ（サーバーが圧縮しない時は生のまま）
  const finished = events.filter((e) => e.method === "Network.loadingFinished").reduce((a, e) => a + e.params.encodedDataLength, 0);
  const res = await evaluate(`(async () => {
    const urls = [location.href, ...performance.getEntriesByType('resource').map(r => r.name)];
    const sizes = [];
    for (const u of urls) { const b = await (await fetch(u, {cache: 'no-store'})).arrayBuffer(); sizes.push([u.split('/').pop() || 'index.html', b.byteLength]); }
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return { sizes, fcp: fcp ? Math.round(fcp.startTime) : null };
  })()`);
  // gzip にした時の大きさ（配信側が圧縮する前提の予算と比べる）
  let gz = 0;
  for (const [name] of res.sizes) {
    const u = name === "index.html" ? url : new URL(`_astro/${name}`, url).toString();
    gz += gzipSync(Buffer.from(await (await fetch(u)).arrayBuffer()), { level: 9 }).length;
  }
  let marker = null;
  // 初めて開いた時の見本（通信なし）のマーカー完走
  const initial = await evaluate(`(async () => { for (let i = 0; i < 100 && !window.__tadashigakiPerf?.markerMs; i++) await new Promise(r => setTimeout(r, 50));
    const p = window.__tadashigakiPerf; const doc = document.getElementById('doc'); const top = doc ? Math.round(doc.getBoundingClientRect().top) : null;
    return { markerMs: p?.markerMs, visibleMarks: p?.markerVisible, docTop: top, viewport: innerHeight }; })()`);
  if (mode !== "none") {
    const text = pasteFile ? readFileSync(pasteFile, "utf-8") : "";
    marker = await evaluate(`(async () => {
      const done = () => window.__tadashigakiPerf.markerMs;
      ${mode === "sample"
        ? "document.getElementById('sample').click();"
        : `document.getElementById('toggle-paste').click(); document.getElementById('paste-text').value = ${JSON.stringify(text)}; document.getElementById('paste-go').click();`}
      for (let i = 0; i < 300 && !done(); i++) await new Promise(r => setTimeout(r, 50));
      const p = window.__tadashigakiPerf; return { markerMs: p.markerMs, visibleMarks: p.markerVisible, plannedAllMs: p.markerPlannedMs, marks: document.querySelectorAll('#doc mark').length, step: getComputedStyle(document.documentElement).getPropertyValue('--step') };
    })()`);
  }
  const out = { url, width, transferWire: finished, files: res.sizes, gzipTotal: gz, fcpMs: res.fcp, initial, marker };
  console.log(JSON.stringify(out, null, 1));
} finally {
  try { ws?.close(); } catch { /* */ }
  try { process.kill(-chrome.pid, "SIGTERM"); } catch { /* */ }
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
