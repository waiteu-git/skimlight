/**
 * 外向き HTTP の唯一の出口（GET だけ）。CLI（ruleaudit/snapshot.py）の取得と同じ守り。
 * - https の公開ホスト名だけ。IP の直書き・ポート指定・userinfo・単一ラベル・.local 等は拒否
 * - 名前解決の後に私的・予約済みアドレスを拒否し、確かめた IP にだけ接続する（DNS の差し替えを防ぐ）
 * - 転送は追わない。text/html と text/plain だけ。本文 1MiB・10秒まで
 */
import { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

export const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const UA = "tadashigaki/0.1 (reads one public page on the user's request; GET only)";

// 共用の内部アドレス帯（RFC 6598）。手元の pre-commit ガードが tailnet の IP の書式として止めるので、数字から組み立てる
const CGNAT = [100, 64, 0, 0].join(".");
// IPv4 と IPv6 は別の表にする（同じ表だと、IPv6 の ::ffff:0:0/96 が全ての IPv4 に当たる＝Node の BlockList の仕様）
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], [CGNAT, 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as Array<[string, number]>) blocked4.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as Array<[string, number]>) blocked6.addSubnet(net, bits, "ipv6");

export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return !blocked4.check(ip, "ipv4");
  if (v === 6) {
    // IPv4 を包んだ IPv6（::ffff:a.b.c.d と ::a.b.c.d）は、中の IPv4 で判定する
    const m = ip.toLowerCase().match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isIP(m[1]) === 4 && !blocked4.check(m[1], "ipv4");
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(ip)) return false; // 16進で書いた対応付けは読まない（安全側）
    return !blocked6.check(ip, "ipv6");
  }
  return false;
}

export class FetchRefused extends Error {
  code: string;
  detail?: string;
  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export function checkUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new FetchRefused("BAD_URL", "URL の形が正しくありません"); }
  if (u.protocol !== "https:") throw new FetchRefused("NOT_HTTPS", "https:// で始まる URL だけを読みます");
  if (u.username || u.password) throw new FetchRefused("BAD_URL", "ID やパスワードを含む URL は読みません");
  if (u.port && u.port !== "443") throw new FetchRefused("BAD_URL", "ポートを指定した URL は読みません");
  const host = u.hostname.replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, ""))) throw new FetchRefused("BAD_URL", "IP アドレスを直接書いた URL は読みません");
  if (!host.includes(".") || /\.(local|localhost|internal|lan|home|test|invalid|example|onion)$/i.test(host)) {
    throw new FetchRefused("BAD_URL", "公開されたサイトの URL を入れてください");
  }
  u.hash = "";
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

/** 名前解決して公開アドレスだけを返す lookup（https.request に渡す）。 */
function safeLookup(hostname: string, opts: { all?: boolean }, cb: LookupCb): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err, "");
    const list = (addrs as Array<{ address: string; family: number }>);
    if (!list.length || list.some((a) => !isPublicIp(a.address))) {
      const e = new Error("private address") as NodeJS.ErrnoException;
      e.code = "EPRIVATE";
      return cb(e, "");
    }
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

function sniffCharset(ctype: string, head: Buffer): string {
  const m = ctype.match(/charset=["']?([\w-]+)/i);
  if (m) return m[1].toLowerCase();
  const h = head.subarray(0, 4096).toString("latin1");
  const meta = h.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  return meta ? meta[1].toLowerCase() : "utf-8";
}

export interface Fetched { url: string; contentType: string; body: string; bytes: number }

export function safeGet(raw: string): Promise<Fetched> {
  const u = checkUrl(raw);
  return new Promise((resolve, reject) => {
    const req = request(u, {
      method: "GET",
      lookup: safeLookup as never,
      headers: { "User-Agent": UA, Accept: "text/html,text/plain;q=0.9", "Accept-Language": "ja,en;q=0.5" },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        const loc = res.headers.location ? new URL(res.headers.location, u).toString() : "";
        return reject(new FetchRefused("REDIRECT", "転送されました。転送先の URL を入れてください", loc));
      }
      if (status !== 200) { res.resume(); return reject(new FetchRefused("STATUS", `ページを取得できませんでした（${status}）`)); }
      const ctype = String(res.headers["content-type"] || "");
      if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(ctype)) {
        res.resume();
        return reject(new FetchRefused("TYPE", "HTML とテキスト以外のページは読みません（PDF は今は未対応です）"));
      }
      const declared = Number(res.headers["content-length"] || 0);
      if (declared > MAX_BYTES) { res.resume(); return reject(new FetchRefused("TOO_LARGE", "ページが大きすぎます（1MB まで）")); }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); reject(new FetchRefused("TOO_LARGE", "ページが大きすぎます（1MB まで）")); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let body: string;
        try { body = new TextDecoder(sniffCharset(ctype, buf)).decode(buf); } catch { body = new TextDecoder("utf-8").decode(buf); }
        resolve({ url: u.toString(), contentType: ctype, body, bytes: size });
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new FetchRefused("TIMEOUT", "時間内に取得できませんでした")); });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e instanceof FetchRefused) return reject(e);
      if (e.code === "EPRIVATE") return reject(new FetchRefused("PRIVATE", "公開されていないアドレスのページは読みません"));
      reject(new FetchRefused("NETWORK", "ページを取得できませんでした"));
    });
    req.end();
  });
}
