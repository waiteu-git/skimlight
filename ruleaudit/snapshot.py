"""規則のページを取得し、可視テキストの控えを手元に残す。

- 外向きの通信は GET だけ。送るのは URL だけで、本人の状況（situation）はこのモジュールに渡らない
  （tests/test_boundaries.py が、このモジュールが situation を import しないことを固定している）。
- https だけ。私的・予約済みアドレスへの接続は名前解決の後に拒否する。
- 控えは .cache/snapshots/ に置き、git に入れない（原文の再配布を避ける）。
- 取得の方法は3つ: "get"（そのまま取る）／"chrome"（JS で描画するページを、隔離した使い捨てのプロファイルの
  ヘッドレス Chrome で描画して取る。本人の Chrome のプロファイルは使わない）／"file"（本人が保存したファイルを取り込む）。
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

MAX_BYTES = 3 * 1024 * 1024
TIMEOUT_S = 30
CHROME_TIMEOUT_S = 60
MIN_INTERVAL_S = 3.0  # 同じホストへの連続取得の間隔（IP 単位の制限を踏まない）
USER_AGENT = "rule-audit/0.1 (personal rule reader; GET only)"
CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

_last_fetch: dict[str, float] = {}


class FetchError(Exception):
    pass


# --- HTML → 可視テキスト ------------------------------------------------------------------------
_SKIP = {"script", "style", "noscript", "template", "svg", "head", "iframe"}
_BLOCK = {
    "p", "div", "br", "li", "ul", "ol", "tr", "td", "th", "table", "section", "article", "header", "footer",
    "h1", "h2", "h3", "h4", "h5", "h6", "dt", "dd", "dl", "main", "nav", "aside", "blockquote", "pre", "hr",
    "form", "label", "option", "figure", "figcaption",
}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0
        self._stack: list[tuple[str, bool]] = []

    @staticmethod
    def _hidden(attrs: list[tuple[str, str | None]]) -> bool:
        a = {k: (v or "") for k, v in attrs}
        style = a.get("style", "").replace(" ", "").lower()
        return (
            "hidden" in a
            or a.get("aria-hidden", "").lower() == "true"
            or "display:none" in style
            or "visibility:hidden" in style
        )

    def handle_starttag(self, tag, attrs):
        if tag in ("br", "hr", "img", "input", "meta", "link"):
            if tag in ("br", "hr"):
                self.parts.append("\n")
            return
        hide = tag in _SKIP or self._hidden(attrs)
        self._stack.append((tag, hide))
        if hide:
            self._skip_depth += 1
        if tag in _BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        # 対応の崩れた HTML に耐える: 同じ名前の開きタグまで巻き戻す
        for i in range(len(self._stack) - 1, -1, -1):
            if self._stack[i][0] == tag:
                for _, hide in self._stack[i:]:
                    if hide:
                        self._skip_depth -= 1
                del self._stack[i:]
                break
        if tag in _BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._skip_depth == 0:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    p = _TextExtractor()
    p.feed(html)
    p.close()
    lines = [" ".join(line.split()) for line in "".join(p.parts).splitlines()]
    return "\n".join(line for line in lines if line)


# --- 取得 --------------------------------------------------------------------------------------
def _check_url(url: str) -> urllib.parse.SplitResult:
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" or not u.hostname or u.username or u.password or u.port not in (None, 443):
        raise FetchError("https の公開 URL だけを取得します")
    host = u.hostname
    try:
        ipaddress.ip_address(host)
        raise FetchError("IP アドレスの直書きは取得しません")
    except ValueError:
        pass
    if "." not in host or host.endswith((".local", ".internal", ".localhost", ".test")):
        raise FetchError("公開ホスト名ではありません")
    for info in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP):
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise FetchError("私的・予約済みのアドレスに解決されました")
    return u


def _pace(host: str) -> None:
    last = _last_fetch.get(host)
    if last is not None:
        wait = MIN_INTERVAL_S - (time.monotonic() - last)
        if wait > 0:
            time.sleep(wait)
    _last_fetch[host] = time.monotonic()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise FetchError(f"転送されました（{code}）。転送先の URL を登録してください: {newurl}")


def fetch_get(url: str) -> tuple[str, str]:
    """(本文, content-type)。転送は追わない。"""
    u = _check_url(url)
    _pace(u.hostname)
    opener = urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": USER_AGENT})
    with opener.open(req, timeout=TIMEOUT_S) as res:
        ctype = res.headers.get("Content-Type", "")
        if not any(t in ctype for t in ("text/html", "text/plain", "application/json")):
            raise FetchError(f"HTML・テキスト・JSON 以外の形式です: {ctype}")
        body = res.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise FetchError("大きすぎます")
        charset = res.headers.get_content_charset() or "utf-8"
    return body.decode(charset, errors="replace"), ctype


def fetch_chrome(url: str) -> str:
    """隔離した使い捨てのプロファイルのヘッドレス Chrome で描画し、描画後の DOM を返す。"""
    u = _check_url(url)
    if not os.path.exists(CHROME_BIN):
        raise FetchError("Google Chrome が見つかりません")
    _pace(u.hostname)
    profile = tempfile.mkdtemp(prefix="rule-audit-chrome-")
    out_path = Path(profile) / "dom.html"
    try:
        with open(out_path, "wb") as out:
            proc = subprocess.Popen(
                [
                    CHROME_BIN, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                    "--disable-background-networking", "--disable-component-update", "--disable-sync",
                    "--disable-extensions", f"--user-data-dir={profile}/p", "--virtual-time-budget=8000",
                    "--dump-dom", url,
                ],
                stdout=out, stderr=subprocess.DEVNULL, start_new_session=True,
            )
            # Chrome は DOM を書き終えても終わらないことがある＝書き終えたら止める
            deadline = time.monotonic() + CHROME_TIMEOUT_S
            last_size, stable = -1, 0
            while time.monotonic() < deadline and proc.poll() is None:
                time.sleep(0.5)
                size = out_path.stat().st_size
                if size > 0 and size == last_size:
                    stable += 1
                    if stable >= 4 and out_path.read_bytes().rstrip().endswith(b"</html>"):
                        break
                else:
                    stable = 0
                last_size = size
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
        body = out_path.read_bytes()
        if not body or len(body) > MAX_BYTES:
            raise FetchError("描画結果が空か、大きすぎます")
        return body.decode("utf-8", errors="replace")
    finally:
        shutil.rmtree(profile, ignore_errors=True)


# --- 控え ----------------------------------------------------------------------------------------
@dataclass
class SnapshotMeta:
    subject: str
    source: str
    url: str
    method: str
    fetched_at: str  # UTC ISO8601
    sha256: str  # 可視テキストの sha256
    chars: int
    text_path: str


def to_text(body: str, ctype: str) -> str:
    if "json" in ctype:
        return json.dumps(json.loads(body), ensure_ascii=False, indent=1)
    if "html" in ctype or body.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        return html_to_text(body)
    return body


def store(root: Path, subject: str, source: str, url: str, method: str, text: str) -> SnapshotMeta:
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    d = root / subject / source
    d.mkdir(parents=True, exist_ok=True)
    latest = latest_meta(root, subject, source)
    if latest and latest.sha256 == sha:
        return latest  # 変化なし＝控えを増やさない
    tp = d / f"{now}-{sha[:12]}.txt"
    tp.write_text(text, encoding="utf-8")
    meta = SnapshotMeta(subject, source, url, method, now, sha, len(text), str(tp))
    tp.with_suffix(".json").write_text(json.dumps(asdict(meta), ensure_ascii=False, indent=1), encoding="utf-8")
    return meta


def history(root: Path, subject: str, source: str) -> list[SnapshotMeta]:
    d = root / subject / source
    if not d.is_dir():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        meta = SnapshotMeta(**json.loads(p.read_text(encoding="utf-8")))
        # 本文の場所は記録の隣（記録に書いた絶対パスは、リポを動かすと古くなるので使わない）
        meta.text_path = str(p.with_suffix(".txt"))
        out.append(meta)
    return out


def latest_meta(root: Path, subject: str, source: str) -> SnapshotMeta | None:
    h = history(root, subject, source)
    return h[-1] if h else None


def trim(text: str, start: str = "", end: str = "") -> tuple[str, list[str]]:
    """目印の行で範囲を切る。目印が見つからない時は切らずに残し、警告を返す（取りこぼすより多く残す）。"""
    warnings = []
    lines = text.splitlines()
    i0, i1 = 0, len(lines)
    if start:
        hit = next((i for i, line in enumerate(lines) if start in line), None)
        if hit is None:
            warnings.append(f"開始の目印「{start}」が見つかりません（全文を残しました）")
        else:
            i0 = hit
    if end:
        hit = next((i for i in range(i0 + 1, len(lines)) if end in lines[i]), None)
        if hit is None:
            warnings.append(f"終了の目印「{end}」が見つかりません（末尾まで残しました）")
        else:
            i1 = hit
    return "\n".join(lines[i0:i1]), warnings


def capture(root: Path, subject: str, source: str, url: str, method: str, file: str | None = None,
            scope: tuple[str, str] = ("", "")) -> SnapshotMeta:
    if method == "get":
        body, ctype = fetch_get(url)
        text = to_text(body, ctype)
    elif method == "chrome":
        text = html_to_text(fetch_chrome(url))
    elif method == "file":
        if not file:
            raise FetchError("取り込むファイルを指定してください")
        raw = Path(file).read_text(encoding="utf-8")
        ctype = "json" if file.endswith(".json") else ("html" if file.endswith((".html", ".htm")) else "text")
        text = to_text(raw, ctype)
    else:
        raise FetchError(f"未知の取得方法: {method}")
    text, warnings = trim(text, *scope)
    for w in warnings:
        print(f"{subject}/{source}: {w}")
    if not text.strip():
        raise FetchError("本文が空です")
    return store(root, subject, source, url, method, text)
