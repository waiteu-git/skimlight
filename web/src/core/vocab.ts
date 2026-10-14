/** 引用の意味を変えうる語（否定・例外・条件）。CLI（ruleaudit/vocab.py）と同じ正規表現。 */
export const JP_NEGATION = /ない|ません|不要|不可(?!欠|避|分|逆|侵)|ではなく|でなく|無い|無し|なし(?!得)|おらず|おりません/g;
export const JP_EXCEPTION = new RegExp(
  "除く|除き|除いて|除外|以外|ただし|但し|なお|のみ|限り|限る|限って|限定" +
    "|もっとも|ただ[、,]|例外|特例|免除|適用除外|不問|廃止|撤廃|撤回|取りやめ|取り止め|取止め|取消|この限りで",
  "g",
);
export const JP_LOOSE_EXCEPTION = /対象外|適用外|不適用|無効|失効/g;
export const JP_CONDITION = new RegExp(
  "場合|とき(?=は|に|、|も)|(?<![実国交間])際(?=は|に|し|の|、)|なら(?![ないずざべれびで])|ならば|であれば|すれば|したら|もし(?!くは)|仮に|たとえ|にあたり|に当たり|に応じ|に該当" +
    "|の(?:方|者|人|チーム|参加者|応募者|ユーザー)(?:は|が|へ|に)",
  "g",
);

/** text に現れる否定・例外・条件の語（重複なし）。negation=false は否定語を数えない。 */
export function qualifiers(text: string, negation = true): string[] {
  const found: string[] = [];
  const pats = negation
    ? [JP_NEGATION, JP_EXCEPTION, JP_LOOSE_EXCEPTION, JP_CONDITION]
    : [JP_EXCEPTION, JP_LOOSE_EXCEPTION, JP_CONDITION];
  for (const pat of pats) {
    for (const m of text.matchAll(pat)) if (!found.includes(m[0])) found.push(m[0]);
  }
  return found;
}
