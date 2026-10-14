"""引用の意味を変えうる語（否定・例外・条件）。

出所: 作者（waiteu）が以前に書いた非公開リポジトリの語彙表から、日本語の否定・例外・条件の正規表現だけを移植した。
用途: 照合済みの引用を含む文に、これらの語があるかを見る。あれば「切り取り」や「条件つき」の疑いとして「要確認」に倒す。
語彙を広げると「要確認」が増える（取りこぼしより増えすぎの方が安全側）。
"""
import re

JP_NEGATION = re.compile(r"ない|ません|不要|不可(?!欠|避|分|逆|侵)|ではなく|でなく|無い|無し|なし(?!得)|おらず|おりません")
JP_EXCEPTION = re.compile(
    r"除く|除き|除いて|除外|以外|ただし|但し|なお|のみ|限り|限る|限って|限定"
    r"|もっとも|ただ[、,]|例外|特例|免除|適用除外|不問|廃止|撤廃|撤回|取りやめ|取り止め|取止め|取消|この限りで"
)
JP_LOOSE_EXCEPTION = re.compile(r"対象外|適用外|不適用|無効|失効")
# 条件。引用が文の途中から始まると、前に付いた条件が落ちる（「海外在住の場合は、…が必須です」）。
JP_CONDITION = re.compile(
    r"場合|とき(?=は|に|、|も)|(?<![実国交間])際(?=は|に|し|の|、)|なら(?![ないずざべれびで])|ならば|であれば|すれば|したら|もし(?!くは)|仮に|たとえ|にあたり|に当たり|に応じ|に該当"
    r"|の(?:方|者|人|チーム|参加者|応募者|ユーザー)(?:は|が|へ|に)"  # 対象を絞る主語（「海外在住の方は、…が必須です」）
)


def qualifiers(text: str, *, negation: bool = True) -> list[str]:
    """text に現れる否定・例外・条件の語（重複なし）。negation=False は否定語を数えない
    （禁止の要件は否定語そのものが要件の中身なので、check で表した後は条件・例外だけを見る）。"""
    found: list[str] = []
    pats = (JP_NEGATION, JP_EXCEPTION, JP_LOOSE_EXCEPTION, JP_CONDITION) if negation else (
        JP_EXCEPTION, JP_LOOSE_EXCEPTION, JP_CONDITION)
    for pat in pats:
        for m in pat.finditer(text):
            if m.group(0) not in found:
                found.append(m.group(0))
    return found
