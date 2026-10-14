/**
 * ページの重さを同じ条件で比べる（依存なし・隔離したヘッドレス Chrome・キャッシュなし）。
 *   node scripts/compare-weight.mjs <URL>... [--runs 5]
 * 測るもの：最初に読み込むファイルの数・大きさ（そのまま／gzip した時）・最初の描画（中央値）・読み込み完了（中央値）
 * 大きさは「サーバーが圧縮して送るか」に左右されないよう、中身を手元で gzip した値も出す（公平に比べるため）。
 * 時間はネットワークの距離に左右される＝手元のサーバーと外のサイトの時間は直接は比べない。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const runs = args.includes("--runs") ? Number(args[args.indexOf("--runs") + 1]) : 5;
const urls = args.filter((a, i) => /^https?:\/\//.test(a) && args[i - 1] !== "--runs");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "skimlight-weight-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking",
  "--disable-component-update", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore", detached: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

try {
  let t;
  for (let i = 0; i < 50 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === "page"); } catch { /* */ } await sleep(200); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let seq = 0; const waiting = new Map(); const events = [];
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else if (m.method) events.push(m); });
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send("Network.enable"); await send("Page.enable"); await send("Runtime.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  for (const url of urls) {
    const fcps = []; const loads = []; let files = null;
    for (let i = 0; i < runs; i++) {
      events.length = 0;
      await send("Page.navigate", { url });
      await sleep(4000);
      const perf = (await send("Runtime.evaluate", { expression: "JSON.stringify({ fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, load: performance.getEntriesByType('navigation')[0]?.loadEventEnd ?? null })", returnByValue: true })).result.result.value;
      const p = JSON.parse(perf); if (p.fcp != null) fcps.push(p.fcp); if (p.load) loads.push(p.load);
      if (i === 0) {
        // 1回目だけ、読み込んだファイルの一覧と大きさを取る（そのまま・gzip した時）
        const resp = events.filter((e) => e.method === "Network.responseReceived");
        const done = new Map(events.filter((e) => e.method === "Network.loadingFinished").map((e) => [e.params.requestId, e.params.encodedDataLength]));
        files = [];
        for (const r of resp) {
          if (!/^https?:/.test(r.params.response.url)) continue;
          let raw = 0, gz = 0;
          try {
            const b = (await send("Network.getResponseBody", { requestId: r.params.requestId })).result;
            const buf = Buffer.from(b.body, b.base64Encoded ? "base64" : "utf-8");
            raw = buf.length; gz = gzipSync(buf).length;
          } catch { /* 本文が取れないもの */ }
          files.push({ url: r.params.response.url, type: r.params.type, wire: done.get(r.params.requestId) ?? 0, raw, gz });
        }
      }
    }
    const sum = (k) => files.reduce((a, f) => a + f[k], 0);
    console.log(JSON.stringify({
      url, files: files.length, wireKB: +(sum("wire") / 1024).toFixed(1), rawKB: +(sum("raw") / 1024).toFixed(1), gzipKB: +(sum("gz") / 1024).toFixed(1),
      fcpMs: fcps.length ? Math.round(median(fcps)) : null, loadMs: loads.length ? Math.round(median(loads)) : null, runs,
      list: files.map((f) => `${f.type} ${(f.raw / 1024).toFixed(1)}KB ${f.url.slice(0, 70)}`),
    }, null, 1));
  }
  ws.close();
} finally {
  try { process.kill(-chrome.pid, "SIGTERM"); } catch { /* */ }
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
