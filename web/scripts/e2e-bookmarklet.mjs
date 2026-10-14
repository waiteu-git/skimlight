/**
 * ブックマークレットの通し確認（依存なし・隔離したヘッドレス Chrome）。
 *   node scripts/e2e-bookmarklet.mjs <要項ページの URL> [読み取りビューの origin]
 * 1. 要項ページを開き、ブックマークレットの1行を「押した」扱い（userGesture）で実行する
 * 2. ページ上にマーカーが付いたか／CSP で止まって読み取りビューの窓が開き、本文が渡ったかを確かめる
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bookmarkletHref } from "../src/bookmarklet/loader.ts";

const page = process.argv[2];
const origin = process.argv[3] ?? "http://localhost:4391";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "rule-audit-e2e-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking",
  "--disable-component-update", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore", detached: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let seq = 0; const waiting = new Map();
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression, userGesture = false) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture })).result?.result?.value;
  return { ws, send, evaluate };
}

try {
  let t;
  for (let i = 0; i < 50 && !t; i++) { try { t = (await list()).find((x) => x.type === "page"); } catch { /* */ } await sleep(200); }
  const a = await connect(t.webSocketDebuggerUrl);
  await a.send("Page.enable");
  await a.send("Page.navigate", { url: page });
  await sleep(2500);
  const code = decodeURIComponent(bookmarkletHref(origin).slice("javascript:".length));
  await a.evaluate(code, true);
  await sleep(3000);
  const onPage = await a.evaluate("({ marks: document.querySelectorAll('mark[data-ra]').length, panel: !!document.getElementById('ra-panel') })");
  // マーカーが付いた時は、表の「読み取りビューで開く」も押してみる（ブロック列を渡す経路）
  if (onPage?.panel) { await a.evaluate("document.querySelector('#ra-panel button').click()", true); await sleep(3000); }
  const pages = (await list()).filter((x) => x.type === "page");
  const reader = pages.find((x) => x.url.startsWith(origin));
  let readerState = null;
  if (reader) {
    const b = await connect(reader.webSocketDebuggerUrl);
    await sleep(1500);
    readerState = await b.evaluate("({ shown: !document.getElementById('main').hidden, src: document.getElementById('src').textContent, marks: document.querySelectorAll('#doc mark').length, msg: document.getElementById('msg').textContent })");
    b.ws.close();
  }
  console.log(JSON.stringify({ page, onPage, readerOpened: !!reader, readerState }, null, 1));
  a.ws.close();
} finally {
  try { process.kill(-chrome.pid, "SIGTERM"); } catch { /* */ }
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
