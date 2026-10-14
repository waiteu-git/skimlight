/**
 * PDF をブラウザの中で読む（ファイルはサーバーへ送らない）。pdf.js は「PDF を選ぶ」を押した時だけ読み込む（初期の重さに入れない）。
 * pdf.js・ワーカー・日本語の CMap は、このサイトから配る（外部の CDN を使わない）。
 */
import type { Block } from "../core/detect.ts";
import { blocksFromLines, linesOf, type PdfItem } from "../core/pdflayout.ts";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PAGES = 80;

export async function pdfToBlocks(file: File): Promise<{ title: string; blocks: Block[]; pages: number; truncated: boolean }> {
  if (file.size > MAX_PDF_BYTES) throw new Error("PDF が大きすぎます（20MB まで）");
  const pdfjs = await import("pdfjs-dist/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
  });
  const doc = await task.promise;
  const n = Math.min(doc.numPages, MAX_PAGES);
  const pages = [];
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items: PdfItem[] = [];
    for (const raw of tc.items as Array<{ str?: string; transform?: number[]; height?: number; hasEOL?: boolean }>) {
      if (typeof raw.str !== "string" || !raw.transform) continue;
      const [a, b, , d, x, y] = raw.transform;
      items.push({ str: raw.str, x, y, size: Math.hypot(b, d) || raw.height || Math.abs(a) || 10, eol: raw.hasEOL });
    }
    pages.push(linesOf(items, i));
    page.cleanup();
  }
  const meta = await doc.getMetadata().catch(() => null);
  const info = meta?.info as { Title?: string } | undefined;
  await task.destroy(); // pdf.js 6 は読み込みの手続きの側で片付ける
  return { title: (info?.Title || file.name).slice(0, 200), blocks: blocksFromLines(pages), pages: doc.numPages, truncated: doc.numPages > MAX_PAGES };
}
