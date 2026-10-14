/**
 * 実際の要項ページで検出器を測る（読み取りビューの本物の経路を通す・隔離したヘッドレス Chrome）。
 *   node scripts/eval-pages.mjs <out.json> <url|js:url>...
 *   url    … 開いた時に本文が書かれたページ：読み取りビューの URL の入口から読む（サーバーが GET 1回）
 *   js:url … 読み込んでから本文が出るページ：Chrome で開いて描画後の本文を取り、貼り付けの入口から読む
 * 出力：ページごとの種類別の件数と、拾った文（目視で誤りを数えるため）。取得は1ページ1回・13秒あける。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [out, ...targets] = process.argv.slice(2);
const reader = "http://127.0.0.1:4391/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "tadashigaki-eval-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking",
  "--disable-component-update", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--window-size=1280,900", "about:blank"], { stdio: "ignore", detached: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let seq = 0; const waiting = new Map();
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const collect = `(() => {
  const groups = {};
  for (const li of document.querySelectorAll('#groups > li')) {
    const name = li.querySelector('h3').textContent.slice(1).trim().split(/\\s+/)[0];
    groups[name] = [...li.querySelectorAll('ol button')].map(b => b.textContent);
  }
  const topics = [...document.querySelectorAll('#topics summary')].map(s => s.innerText.replace(/\\n/g, ' '));
  return { src: document.getElementById('src').textContent, msg: document.getElementById('msg').textContent, groups, topics,
    pdfLinks: [...document.querySelectorAll('#pdfhint-list a')].map(a => a.textContent + ' ' + a.href) };
})()`;

const results = [];
try {
  let t;
  for (let i = 0; i < 50 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === "page"); } catch { /* */ } await sleep(200); }
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  await send("Page.enable");
  for (const target of targets) {
    const js = target.startsWith("js:");
    const url = js ? target.slice(3) : target;
    let text = null;
    if (js) {
      await send("Page.navigate", { url });
      await sleep(7000);
      text = await evaluate("((document.querySelector('main,[role=main]')||document.body).innerText||'').slice(0,200000)");
    }
    await send("Page.navigate", { url: reader });
    await sleep(1200);
    if (js) {
      await evaluate(`document.getElementById('toggle-paste').click(); document.getElementById('paste-text').value = ${JSON.stringify(text ?? "")}; document.getElementById('paste-go').click();`);
    } else {
      await evaluate(`document.getElementById('url').value = ${JSON.stringify(url)}; document.getElementById('go').click();`);
    }
    let r = null;
    for (let i = 0; i < 60; i++) { await sleep(300); if (await evaluate("!document.getElementById('main').hidden || document.getElementById('msg').classList.contains('err')")) { await sleep(400); r = await evaluate(collect); break; } }
    results.push({ url, route: js ? "描画後の本文を貼り付け" : "URL", chars: text?.length ?? null, ...r });
    console.log(url, r ? Object.fromEntries(Object.entries(r.groups).map(([k, v]) => [k, v.length])) : "失敗", r?.msg ?? "");
    await sleep(13000); // 取得口の回数制限（1分に5回）と、取りに行く先への負荷を守る
  }
  writeFileSync(out, JSON.stringify(results, null, 1));
} finally {
  try { ws?.close(); } catch { /* */ }
  try { process.kill(-chrome.pid, "SIGTERM"); } catch { /* */ }
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
