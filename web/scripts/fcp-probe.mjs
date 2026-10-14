/**
 * 最初の描画（first-contentful-paint）の切り分け。条件ごとに N 回測って中央値を出す（依存なし・隔離したヘッドレス Chrome）。
 *   node scripts/fcp-probe.mjs [N] [base] [--plain]   --plain＝通常の開き方だけ（前の版との比較用）
 * 条件：見本あり（/）・見本なし（/#bm＝見本を組み立てない）・JS なし（HTML と CSS だけ）
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = Number(process.argv[2] || 5);
const base = process.argv[3] || "http://127.0.0.1:4391/";
const onlyFirst = process.argv.includes("--plain");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(url, jsOff) {
  const PORT = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "tadashigaki-fcp-"));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking",
    "--disable-component-update", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--window-size=1280,900", "about:blank"], { stdio: "ignore", detached: true });
  try {
    let t;
    for (let i = 0; i < 50 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === "page"); } catch { /* */ } await sleep(150); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let seq = 0; const waiting = new Map();
    ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
    const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true }); await send("Page.enable");
    if (jsOff) await send("Emulation.setScriptExecutionDisabled", { value: true });
    await send("Page.navigate", { url });
    await sleep(2500);
    if (jsOff) await send("Emulation.setScriptExecutionDisabled", { value: false });
    const r = await send("Runtime.evaluate", { expression: "JSON.stringify({fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, resp: performance.getEntriesByType('navigation')[0]?.responseEnd, dcl: performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd})", returnByValue: true });
    ws.close();
    return JSON.parse(r.result.result.value);
  } finally {
    try { process.kill(-chrome.pid, "SIGTERM"); } catch { /* */ }
    await sleep(200);
    rmSync(profile, { recursive: true, force: true });
  }
}

const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor(s.length / 2)]) : null; };
const cases = [["見本あり", base, false], ["見本なし（#bm）", `${base}#bm`, false], ["JS なし", base, true]];
for (const [name, url, jsOff] of onlyFirst ? [["通常", base, false]] : cases) {
  const runs = [];
  for (let i = 0; i < N; i++) runs.push(await once(url, jsOff));
  console.log(`${name}: FCP 中央値 ${med(runs.map((r) => r.fcp))}ms（${runs.map((r) => Math.round(r.fcp ?? -1)).join(", ")}）・応答の終わり ${med(runs.map((r) => r.resp))}ms・DOMContentLoaded ${med(runs.map((r) => r.dcl))}ms`);
}
