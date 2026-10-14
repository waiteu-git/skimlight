/**
 * PDF の入口の精度（依存なし・隔離したヘッドレス Chrome）。
 *   node scripts/eval-pdf.mjs [読み取りビューの URL]
 *   node scripts/eval-pdf.mjs --file <手元の PDF> [読み取りビューの URL]   実物の PDF を1本読ませ、拾った文を種類ごとに出す
 * 1. 手元の控え（../.cache の3要項）を簡単な HTML にして、Chrome で PDF に印刷する（外部から PDF は取らない）
 * 2. その PDF を読み取りビューの「PDF を選ぶ」に渡し、種類ごとの件数を数える
 * 3. 同じ本文を「貼り付け」で読んだ件数と並べる（PDF の組み直しで落ちる・増えるものを見る）
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fileArg = process.argv.includes("--file") ? process.argv[process.argv.indexOf("--file") + 1] : null;
const reader = process.argv.slice(2).find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4391/";
const root = new URL("../../.cache/snapshots/", import.meta.url).pathname;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9300 + Math.floor(Math.random() * 500);
const work = mkdtempSync(join(tmpdir(), "rule-audit-pdf-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking",
  "--disable-component-update", `--user-data-dir=${work}/profile`, `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore", detached: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

let ws; let seq = 0; const waiting = new Map();
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const counts = `(() => Object.fromEntries([...document.querySelectorAll('#groups > li > h3')].map(h => { const t = h.textContent.slice(1).trim().split(/\\s+/); return [t[0], Number(t[1])]; })))()`;

try {
  let t;
  for (let i = 0; i < 50 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === "page"); } catch { /* */ } await sleep(200); }
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const logs = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    else if (m.method === "Runtime.consoleAPICalled") logs.push(m.params.args.map((a) => a.description ?? a.value).join(" "));
    else if (m.method === "Runtime.exceptionThrown") logs.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  });
  await send("Page.enable"); await send("DOM.enable"); await send("Runtime.enable");
  const rows = [];
  if (fileArg) {
    await send("Page.navigate", { url: reader });
    await sleep(1500);
    const doc = await send("DOM.getDocument");
    const node = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#pdf" });
    await send("DOM.setFileInputFiles", { nodeId: node.result.nodeId, files: [fileArg] });
    await sleep(4000);
    const r = await evaluate(`(() => ({ src: document.getElementById('src').textContent, msg: document.getElementById('msg').textContent,
      blocks: document.querySelectorAll('#doc > section, #doc > ul > li').length, texts: [...document.querySelectorAll('#doc h2, #doc h3, #doc p, #doc li, #doc dt, #doc dd')].map(e => e.tagName + ' ' + e.textContent.replace(/[必締数禁違]+（[^）]*）$/, '')),
      groups: Object.fromEntries([...document.querySelectorAll('#groups > li')].map(li => [li.querySelector('h3').textContent.slice(1).trim().split(/\\s+/)[0], [...li.querySelectorAll('ol button')].map(b => b.textContent)])),
      topics: [...document.querySelectorAll('#topics summary')].map(x => x.innerText.replace(/\\n/g, ' ')) }))()`);
    console.log(JSON.stringify(r, null, 1));
    if (logs.length) console.log("console:", logs.slice(0, 5).join("\n"));
    process.exitCode = 0;
  }
  for (const subj of fileArg ? [] : readdirSync(root)) {
    const dir = join(root, subj, "S1");
    const txt = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort().at(-1);
    const text = readFileSync(join(dir, txt), "utf-8");
    const html = `<!doctype html><meta charset="utf-8"><style>body{font:11pt/1.7 "Hiragino Sans",sans-serif;margin:18mm}h3{font-size:15pt;margin:14pt 0 4pt}p{margin:0 0 6pt}</style>` +
      text.split("\n").map((l) => (l.length <= 16 && !/[。、]/.test(l) && !/\d/.test(l) ? `<h3>${esc(l)}</h3>` : `<p>${esc(l)}</p>`)).join("");
    const htmlPath = join(work, `${subj}.html`);
    writeFileSync(htmlPath, html);
    await send("Page.navigate", { url: `file://${htmlPath}` });
    await sleep(800);
    const pdf = await send("Page.printToPDF", { printBackground: false, preferCSSPageSize: false });
    const pdfPath = join(work, `${subj}.pdf`);
    writeFileSync(pdfPath, Buffer.from(pdf.result.data, "base64"));
    // 貼り付けで読む
    await send("Page.navigate", { url: reader });
    await sleep(1200);
    await evaluate(`document.getElementById('toggle-paste').click(); document.getElementById('paste-text').value = ${JSON.stringify(text)}; document.getElementById('paste-go').click();`);
    await sleep(600);
    const viaText = await evaluate(counts);
    // PDF を選ぶ
    await send("Page.navigate", { url: reader });
    await sleep(1200);
    const doc = await send("DOM.getDocument");
    const node = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#pdf" });
    await send("DOM.setFileInputFiles", { nodeId: node.result.nodeId, files: [pdfPath] });
    let viaPdf = null;
    for (let i = 0; i < 60; i++) { await sleep(250); if (await evaluate("!document.getElementById('main').hidden")) { await sleep(300); viaPdf = await evaluate(counts); break; } }
    const src = await evaluate("document.getElementById('src').textContent + ' / ' + document.getElementById('msg').textContent");
    rows.push({ subj, viaText, viaPdf, src });
  }
  console.log(JSON.stringify(rows, null, 1));
  if (logs.length) console.log("console:", logs.slice(0, 5).join("\n"));
} finally {
  try { ws?.close(); } catch { /* */ }
  try { process.kill(-chrome.pid, "SIGTERM"); } catch { /* */ }
  await sleep(300);
  rmSync(work, { recursive: true, force: true });
}
