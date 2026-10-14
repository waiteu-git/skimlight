/**
 * 本文の上に出す「見落としやすい文」を選ぶ（最大3つ）。判定はしない＝原文の文を並べるだけ。
 * 1. 食い違い（同じ対象に違う日付）：組ごとに1つ
 * 2. 印（必須・締切・数量・禁止）があり、ただし書きの語を含む文
 * 3. 残りのただし書きの文
 */
import type { Sentence } from "./detect.ts";
import { WEB_EXCEPTION } from "./topics.ts";

export interface Watchout { sid: number; reason: "食い違い" | "ただし書き"; text: string }

export function pickWatchouts(ss: Sentence[], isHeading: (s: Sentence) => boolean, max = 3): Watchout[] {
  const out: Watchout[] = [];
  const seen = new Set<number>();
  const exc = new RegExp(WEB_EXCEPTION.source, "u");
  for (const s of ss) {
    if (out.length >= max) return out;
    if (isHeading(s) || !s.labels.includes("conflict") || seen.has(s.id)) continue;
    out.push({ sid: s.id, reason: "食い違い", text: s.text });
    seen.add(s.id);
    for (const o of s.conflictWith) seen.add(o);
  }
  const prov = ss.filter((s) => !isHeading(s) && !seen.has(s.id) && exc.test(s.text));
  const labeled = prov.filter((s) => s.labels.some((l) => l !== "conflict"));
  for (const s of [...labeled, ...prov.filter((s) => !labeled.includes(s))]) {
    if (out.length >= max) break;
    out.push({ sid: s.id, reason: "ただし書き", text: s.text });
  }
  return out;
}
