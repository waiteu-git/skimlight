# タダシガキ（Web版）

長い要項を、締切・必須・数量・禁止・食い違いに色分けして読む。判定はしない。

## 手元で試す

```bash
cd web
npm ci --ignore-scripts
npm run build
HOST=127.0.0.1 PORT=4391 npm start
```

ブラウザで <http://127.0.0.1:4391> を開く。

- 要項ページのURLを貼って「読む」を押すと、サーバーがそのページをGETで1回だけ取得する。「実在の要項で試す」も、デプロイナウの応募要項を同じように1回取得する。
- 「PDF を選ぶ」と「文章を貼り付けて読む」は、端末の中だけで読み、外へは何も送らない。
- 「自分の立場で絞る」で立場を選ぶと、ほかの立場に向けた条項が薄く表示される。選んだ内容は、この端末のlocalStorageにだけ置く。
- ブックマークレットは、ページ下の「タダシガキ」をブックマークバーへドラッグして登録する。手元でビルドした版は送り先がlocalhostになるため、公開サイトのページの上ではChromeが止める（Private Network Access）。公開する時は、公開先のURLを指定してビルドし直す（`SITE_ORIGIN=https://… npm run build`）。

## テスト・計測

```bash
npm test                                         # 検出・論点・取得の守りなど（ネットワークを使わない）
python3 -m tools.export_vectors --check          # （リポジトリの根で）コマンド版と共有するテストの値が古くないか
node scripts/eval-detect.ts                      # 取得した原文の控え（../.cache）で、検出の拾い方を見る
node scripts/measure.mjs --width 390 --paste <file>   # 重さを測る
node scripts/e2e-bookmarklet.mjs <要項ページの URL>    # ブックマークレットを通しで確かめる
```

計測と通しの確認では、端末のGoogle Chromeを使い捨てのプロファイルでヘッドレス起動する。利用者のプロファイルは使わない。
