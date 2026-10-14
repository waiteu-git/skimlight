// @ts-check
import node from "@astrojs/node";
import { defineConfig } from "astro/config";

export default defineConfig({
  // 公開 URL は本人がデプロイナウで決めた後に、ビルドの環境変数 SITE_ORIGIN で渡す（ブックマークレットの宛先にもなる）。
  site: process.env.SITE_ORIGIN || "http://localhost:4391",
  adapter: node({ mode: "standalone" }),
  // デプロイナウの案内：公開 URL・PR プレビュー（*.preview.lolipop-now.app）を列挙する
  security: {
    allowedDomains: process.env.SITE_ORIGIN
      ? [{ hostname: new URL(process.env.SITE_ORIGIN).hostname, protocol: "https" }, { hostname: "*.preview.lolipop-now.app", protocol: "https" }]
      : [],
  },
  build: { inlineStylesheets: "always" },
  devToolbar: { enabled: false },
});
