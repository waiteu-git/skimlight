/**
 * 検出器を手元の控え（CLI の .cache/）に当て、種類ごとに拾った文を出す（精度の目視確認用）。
 *   node scripts/eval-detect.ts [subject...]
 * 控えは1行1ブロック。16字以下で句読点・数字の無い行を見出しとみなす（実際の画面の HTML より粗い）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Block, detect, LABEL_JA, LABELS } from "../src/core/detect.ts";

const root = new URL("../../.cache/snapshots/", import.meta.url).pathname;
const subjects = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(root);
const today = new Date(Date.UTC(2026, 9, 12));
for (const subj of subjects) {
  const dir = join(root, subj, "S1");
  const txt = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort().at(-1)!;
  const blocks: Block[] = readFileSync(join(dir, txt), "utf-8").split("\n").map((t) => ({ type: t.length <= 16 && !/[。、]/u.test(t) && !/\d/u.test(t) ? "h3" : "p", text: t }));
  const ss = detect(blocks, today);
  console.log(`\n### ${subj}（文 ${ss.length}）`);
  for (const l of LABELS) {
    const hit = ss.filter((s) => s.labels.includes(l));
    console.log(`\n[${LABEL_JA[l]}] ${hit.length}`);
    for (const s of hit) {
      const extra = l === "deadline" ? ` → ${s.dates.map((d) => d.iso + (d.time ? " " + d.time : "")).join(", ")}` : "";
      console.log(`  #${s.id} ${s.text.slice(0, 70)}${extra}`);
    }
  }
}
