import assert from "node:assert/strict";
import { test } from "node:test";

import { detect, LABELS } from "../src/core/detect.ts";
import { SAMPLE_BLOCKS } from "../src/core/sample.ts";

test("見本の要項は5色とただし書きを全部出す", () => {
  const ss = detect(SAMPLE_BLOCKS, new Date(Date.UTC(2026, 9, 13)));
  for (const l of LABELS) assert.ok(ss.some((s) => s.labels.includes(l)), `${l} が出ない`);
  assert.ok(ss.some((s) => /ただし|除き/.test(s.text)));
  const by = (t: string) => ss.find((s) => s.text.startsWith(t))!.labels;
  assert.ok(!by("紹介動画").includes("required"), "任意の文に必須が付いた");
  assert.ok(!by("1人または3名").includes("required"), "許可の文に必須が付いた");
});
