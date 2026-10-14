/**
 * POST /api/page {"url": "https://..."} → {"ok": true, "url", "html"} | {"ok": false, "code", "message", "detail?"}
 * 1回の要求で GET を1回だけ。解析はしない（ブラウザがする）。URL も URL から作った記号も記録しない（残すのは結果の種類と大きさだけ）。
 * URL を本文で受ける（アクセスログの URL に載せないため POST にしている）。
 */
import type { APIRoute } from "astro";

import { FetchRefused, safeGet } from "../../server/safefetch.ts";

export const prerender = false;

const WINDOW_MS = 60_000;
const PER_WINDOW = 5;
// 全体の上限（無料枠の CPU と、取りに行く先への負荷を守る）。超えたら全員に「混んでいます」
const GLOBAL_PER_WINDOW = 60;
const hits = new Map<string, number[]>();
let globalHits: number[] = [];
let lastSweep = 0;

function clientKey(request: Request, clientAddress: string | undefined): string {
  // 前段のプロキシが足した右端の値を使う（左端は利用者が偽れる）
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return clientAddress || "unknown";
}

type Verdict = "ok" | "rate" | "busy";

/** 回数の数え。IP はメモリの上だけに置き、最後に使ってから1分（窓）を過ぎたものは掃除のたびに消す。 */
function allow(key: string): Verdict {
  const now = Date.now();
  if (now - lastSweep > 10_000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
    lastSweep = now;
  }
  globalHits = globalHits.filter((t) => now - t < WINDOW_MS);
  if (globalHits.length >= GLOBAL_PER_WINDOW) return "busy";
  const list = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= PER_WINDOW) { hits.set(key, list); return "rate"; }
  list.push(now);
  hits.set(key, list);
  globalHits.push(now);
  return "ok";
}

// 要求が来ない間も、30秒ごとに掃除する（来なければ残り続ける、を無くす）
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  lastSweep = now;
}, 30_000);
sweeper.unref?.();

/** テスト用：いま覚えている IP の数 */
export const _rememberedClients = () => hits.size;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let url = "";
  try {
    const body = await request.json();
    url = typeof body?.url === "string" ? body.url.slice(0, 2048) : "";
  } catch { /* 下で扱う */ }
  if (!url) return json(400, { ok: false, code: "BAD_URL", message: "URL を入れてください" });
  const v = allow(clientKey(request, clientAddress));
  if (v === "busy") return json(429, { ok: false, code: "BUSY", message: "いま混み合っています。少し待ってからもう一度どうぞ" });
  if (v === "rate") return json(429, { ok: false, code: "RATE", message: "続けて読みすぎです。1分ほど待ってからもう一度どうぞ" });
  try {
    const got = await safeGet(url);
    console.log(JSON.stringify({ ev: "page", ok: true, bytes: got.bytes }));
    return json(200, { ok: true, url: got.url, html: got.body, contentType: got.contentType });
  } catch (e) {
    const r = e instanceof FetchRefused ? e : new FetchRefused("NETWORK", "ページを取得できませんでした");
    console.log(JSON.stringify({ ev: "page", ok: false, code: r.code }));
    return json(200, { ok: false, code: r.code, message: r.message, detail: r.detail });
  }
};
