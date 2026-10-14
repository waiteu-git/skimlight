/**
 * README 用の画面写真（架空の見本が表示された初期画面）を撮る。依存なし・隔離したヘッドレス Chrome。
 *   node scripts/screenshot.mjs [読み取りビューの URL] [出力先]
 * 既定の出力先は ../../assets/screenshot.webp。幅 1200・高さ 900・WebP（品質 80）で軽くする。
 * 撮った後は必ず目で見る（生成した画像は grep できない）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const reader = process.argv[2] ?? "http://127.0.0.1:4391/";
const out = process.argv[3] ?? new URL("../../assets/screenshot.webp", import.meta.url).pathname;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "tadashigaki-shot-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking",
  "--disable-component-update", "--hide-scrollbars", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore", detached: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let t;
  for (let i = 0; i < 50 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === "page"); } catch { /* */ } await sleep(200); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let seq = 0; const waiting = new Map();
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await send("Page.enable");
  await send("Page.navigate", { url: reader });
  await sleep(3000); // 見本のマーカーが走り終わるまで
  const shot = await send("Page.captureScreenshot", { format: "webp", quality: 80 });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log(`${out}（${(Buffer.from(shot.result.data, "base64").length / 1024).toFixed(1)}KB）`);
  ws.close();
} finally {
  try { process.kill(-chrome.pid, "SIGTERM"); } catch { /* */ }
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
