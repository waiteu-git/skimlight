/** ブックマークレットの本体を public/bm.js に束ねる。宛先の origin は SITE_ORIGIN（既定はローカル）。 */
import { build } from "esbuild";

const origin = process.env.SITE_ORIGIN || "http://localhost:4391";
const r = await build({
  entryPoints: ["src/bookmarklet/overlay.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  outfile: "public/bm.js",
  define: { __ORIGIN__: JSON.stringify(origin) },
  legalComments: "none",
  metafile: true,
});
const bytes = Object.values(r.metafile.outputs)[0].bytes;
console.log(`bm.js ${bytes} bytes（宛先 ${origin}）`);
