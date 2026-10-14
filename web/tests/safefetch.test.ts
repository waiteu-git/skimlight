import assert from "node:assert/strict";
import { test } from "node:test";

import { checkUrl, FetchRefused, isPublicIp } from "../src/server/safefetch.ts";

test("公開アドレスの判定", () => {
  for (const ip of ["133.130.34.142", "8.8.8.8", "2606:4700::1111", "::ffff:133.130.34.142"]) assert.equal(isPublicIp(ip), true, ip);
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", [100, 64, 0, 1].join("."), "198.18.0.1", "0.0.0.0",
    "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "2001:db8::1", "ff02::1", "not-an-ip"]) {
    assert.equal(isPublicIp(ip), false, ip);
  }
});

test("URL の入口の検査", () => {
  assert.equal(checkUrl("https://lolipop.jp/deploy-now/contest/#top").toString(), "https://lolipop.jp/deploy-now/contest/");
  for (const bad of ["http://example.com/", "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "https://user:pw@example.com/",
    "https://example.com:8443/", "https://intranet/", "https://printer.local/", "ftp://example.com/", "javascript:alert(1)", "not a url"]) {
    assert.throws(() => checkUrl(bad), FetchRefused, bad);
  }
});
