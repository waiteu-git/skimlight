# 出所の記録

## 作者の既存コードからの移植

- `ruleaudit/textnorm.py`（正規化と原文位置の復元）と `ruleaudit/vocab.py`（否定・例外・条件の語彙の一部）は、作者（waiteu）が以前に書いた非公開のコードから移した。作者は同じで、外部のOSSではない。Web版の `web/src/core/textnorm.ts` と `web/src/core/vocab.ts` は、これをTypeScriptに書き直したもの。
- それ以外は、このリポジトリのために新しく書いた。

## 依存

- コマンド版は、Pythonの標準ライブラリだけを使う（3.13以上）。読み込んでから文字が出るページは、端末に入っているGoogle Chromeをヘッドレスで使って取る。その時は使い捨てのプロファイルを使い、利用者のプロファイルには触れない。
- Web版は、Astro（MIT）・@astrojs/node（MIT）・pdf.js（pdfjs-dist、Apache License 2.0）を使う。ビルドにはesbuild（MIT）を使う。pdf.jsのライセンス文は、ビルドの時に配信するファイルへ写す（`web/scripts/copy-pdf-assets.mjs`）。

## データ

- 東京デジタル2030ビジョン（こどもDX）子育て支援制度レジストリ（東京都・GovTech東京）はCC BY 4.0。出典の表示は `ruleaudit/registry.py` のATTRIBUTIONにある。データ本体はリポジトリに入れない。
- 取得した原文の控え（`.cache/`）は、リポジトリに入れない。
- `tests/fixtures/` の制度データと、Web版の見本の要項（`web/src/core/sample.ts`）は架空のもの。
