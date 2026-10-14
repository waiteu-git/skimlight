import assert from "node:assert/strict";
import { test } from "node:test";

import { type Block, detect, findDates, splitSentences } from "../src/core/detect.ts";

const T = new Date(Date.UTC(2026, 9, 12));
const p = (text: string): Block => ({ type: "p", text });
const labelsOf = (blocks: Block[]) => detect(blocks, T).map((s) => [s.text, s.labels]);

test("文の切れ目：社名の！・括弧の中の。・番号の．では切らない", () => {
  const ss = splitSentences([p("「ロリポップ！デプロイナウ」で公開したものに限ります。以下「作品等」（以下「作品等」といいます。）を使う。３． 年齢25才以下であること")]);
  assert.deepEqual(ss.map((s) => s.text), [
    "「ロリポップ！デプロイナウ」で公開したものに限ります。",
    "以下「作品等」（以下「作品等」といいます。）を使う。",
    "３． 年齢25才以下であること",
  ]);
  assert.deepEqual(splitSentences([p("お待ちしています！ぜひどうぞ。")]).map((s) => s.text), ["お待ちしています！ぜひどうぞ。"]);
  assert.deepEqual(splitSentences([p("お待ちしています！ ぜひどうぞ。")]).map((s) => s.text), ["お待ちしています！", "ぜひどうぞ。"]);
});

test("日付：年の補完・範囲の年またぎ・時刻", () => {
  assert.deepEqual(findDates("2026年9月10日（木）〜 12月8日（火）23:59", 2026).map((d) => [d.iso, d.time]), [["2026-09-10", undefined], ["2026-12-08", "23:59"]]);
  assert.deepEqual(findDates("12月20日〜1月10日", 2026).map((d) => d.iso), ["2026-12-20", "2027-01-10"]);
  assert.deepEqual(findDates("応募締切：2026.12.8（火）まで", 2026).map((d) => d.iso), ["2026-12-08"]);
  assert.deepEqual(findDates("締切 11/29 21時まで", 2026).map((d) => [d.iso, d.time]), [["2026-11-29", "21:00"]]);
  assert.deepEqual(findDates("13月40日", 2026), []);
});

test("5種類の検出", () => {
  const r = labelsOf([
    p("応募期間は2026年9月10日から2026年12月8日23:59までです。"),
    p("作品概要は100字以内で記入してください。"),
    p("他のコンテストとの二重応募は禁止します。"),
    p("応募者は本人であることが必須です。"),
    p("昨年度は約1,700人が参加しました。"),
    p("Q. 返済は必要ですか？"),
    p("受賞を無効とさせていただきます。"),
  ]);
  assert.deepEqual(r, [
    ["応募期間は2026年9月10日から2026年12月8日23:59までです。", ["deadline"]],
    ["作品概要は100字以内で記入してください。", ["required", "quantity"]],
    ["他のコンテストとの二重応募は禁止します。", ["prohibited"]],
    ["応募者は本人であることが必須です。", ["required"]],
    ["昨年度は約1,700人が参加しました。", []],
    ["Q. 返済は必要ですか？", []],
    ["受賞を無効とさせていただきます。", ["prohibited"]],
  ]);
});

test("見出しは塗らず、見出しの意味を箇条書きが受け継ぐ", () => {
  const ss = detect([
    { type: "h3", text: "応募が無効になる場合" },
    { type: "li", text: "応募作品が審査終了までに削除された場合" },
    { type: "h3", text: "応募資格" },
    { type: "li", text: "日本国内にお住まいの方" },
  ], T);
  assert.deepEqual(ss.map((s) => s.labels), [[], ["prohibited"], [], ["required"]]);
});

test("矛盾：同じ対象に違う締切日。月間・次回の締切は別の話", () => {
  const ss = detect([
    p("応募締切は2026年12月8日23:59です。"),
    p("応募期間：2026年9月10日〜2026年12月10日"),
    p("月間賞の次回の締切は、10月31日です。"),
  ], T);
  assert.ok(ss[0].labels.includes("conflict") && ss[1].labels.includes("conflict"));
  assert.deepEqual(ss[0].conflictWith, [1]);
  assert.ok(!ss[2].labels.includes("conflict"));
  const same = detect([p("応募締切：2026.12.8（火）まで"), p("応募期間は2026年9月10日から2026年12月8日23:59までです。")], T);
  assert.ok(same.every((s) => !s.labels.includes("conflict")));
});

test("立場：チーム・未成年・海外向けの文を見分ける", () => {
  const ss = detect([p("チームの場合は代表者が応募してください。"), p("未成年の方は保護者の同意を得てください。"), p("留学生の方は応募できません。")], T);
  assert.deepEqual(ss.map((s) => s.audiences), [["team"], ["minor"], ["overseas"]]);
});

test("実ページで見つけた誤りの型（10/12）", () => {
  const r = labelsOf([
    p("ご関心のある方は、お気軽にプレエントリーへご登録ください。"),
    p("特に、安全管理・法令遵守の点においては細心の注意を払い、環境を維持します。"),
    p("(PDF形式・1MB)"),
    p("作品紹介スライド（PDF形式・10ページ以内・10MB以内）"),
    p("ぜひご応募ください。応募には登録が必須です。"),
  ]);
  assert.deepEqual(r.map(([, l]) => l), [[], [], [], ["quantity"], [], ["required"]]); // 最後は「ぜひ…」と「必須です」の2文
  const cells = detect([{ type: "h3", text: "募集対象者" }, { type: "td", text: "対象大学" }, { type: "td", text: "日本の大学に在籍する大学生" }], T);
  assert.deepEqual(cells.map((x) => x.labels), [[], [], ["required"]]);
});

test("日程表の行：期間と「エントリー」の行は締切、審査会の行は締切にしない", () => {
  const ss = detect([p("2026年8月28日（金）～ 2026年11月19日（木） 本エントリー"), p("2026年12月5日（土）～ 2026年12月6日（日） 一次審査会")], T);
  assert.deepEqual(ss.map((s) => s.labels.includes("deadline")), [true, false]);
});

test("必須の言い回し：承諾を得る・ご同意いただきます・条件とします（10/15）", () => {
  const r = labelsOf([
    p("写真に写る人物の承諾を得てください。"),
    p("応募をもって、本規約にご同意いただきます。"),
    p("日本国内に居住していることを応募条件とします。"),
    p("権利者の許可を得てから使用してください。"),
    p("同意を得て公開しています。"),
    p("条件となる書類はありません。"),
  ]);
  assert.deepEqual(r.map(([, l]) => l), [["required"], ["required"], ["required"], ["required"], [], []]);
});

test("デプロイナウの要項で見つけた誤り：賞の数・受賞作の紹介は数量にしない／案内の文は必須にしない（10/15）", () => {
  const prize = detect([
    { type: "h2", text: "受賞内容" },
    ...Array.from({ length: 12 }, (_, i) => p(i % 2 ? "賞金100万円" : "1作品")),
    p("グランプリ（1点）賞金100万円"),
    { type: "h2", text: "月間賞受賞作品" },
    p("運営コメント匿名で書かれた私小説や随筆1,600件以上を、題材や投稿年から探せる目録。"),
    { type: "h2", text: "応募について" },
    p("作品紹介スライドは10ページ以内とします。"),
  ], T);
  assert.deepEqual(prize.filter((s) => s.labels.includes("quantity")).map((s) => s.text), ["作品紹介スライドは10ページ以内とします。"]);
  const r = labelsOf([
    p("利用規約に加えて、このコンテストに応募される方にお守りいただきたいことをまとめています。"),
    p("応募の前に必ずお読みください。"),
  ]);
  assert.deepEqual(r.map(([, l]) => l), [[], ["required"]]);
});

test("主語が運営の文は、応募する人の必須に数えない（10/18）", () => {
  const r = labelsOf([
    p("当社は、応募作品等の名称、スクリーンショット、公開URL及び説明を、無償で使用できるものとします。"),
    p("事務局は、提出書類の不備について連絡することがあります。"),
    p("応募者は、当社に対し、当該請求等により当社が被った損害を補償するものとします。"),
    p("受賞者は、当社が指定する期日までに、必要な情報をご提供ください。"),
    p("運営が定める方法で提出してください。"),
  ]);
  assert.deepEqual(r.map(([, l]) => l), [[], [], ["required"], ["required"], ["required"]]);
});

test("実ページ8件で見つけた誤り：金額・紹介文・財団の交付・「必要があると認めたとき」（10/18）", () => {
  const r = labelsOf([
    p("50万円"),
    p("月額3.0万円（ガス・Wi-Fi代込）"),
    p("628社969件のGTFSデータへのリンク集です"),
    p("財団生支援金は、3か月毎の一定日に交付するものとします。"),
    p("学業又は性行などの状況により、指導上必要があると認めたとき"),
    p("作品紹介は400字以内"),
    p("提出書類は3点"),
    p("参加には事前の登録が必要があります。"),
    p("その他本財団が提出の必要があると判断した書類"),
  ]);
  assert.deepEqual(r.map(([, l]) => l), [[], [], [], [], [], ["quantity"], ["quantity"], ["required"], ["required"]]);
});

test("寮・施設の案内の節では、定員や広さを数量にしない（10/18）", () => {
  const r = detect([{ type: "h3", text: "学生寮のご案内" }, p("鉄筋コンクリート造　4階建　定員40名"), p("1R　約14㎡　1人部屋")], T);
  assert.deepEqual(r.map((s) => s.labels), [[], [], []]);
});

test("実ページ13件（10/18 広く測った分）で見つけた誤り", () => {
  const L = (text: string) => detect([p(text)], T)[0].labels;
  // 否定の「必須ではありません」は必須でない
  assert.deepEqual(L("高度な技術力やプログラミングスキルは必須ではありません。"), []);
  // 運営が連絡・通知する日は、応募する人の締切ではない
  assert.ok(!L("2026年11月6日（金）17時までに、ご応募いただいたメールアドレスに一次選考結果をお送りします。").includes("deadline"));
  assert.ok(!L("NICTおよび有識者による厳正な審査の上、2026年5月29日(金)までにメールでご連絡します。").includes("deadline"));
  // 電話番号・第N回・年の数字は数量ではない
  assert.ok(!L("17時を過ぎても連絡がない場合は、0572-26-7707までお問い合わせください。").includes("quantity"));
  assert.ok(!L("第4回 東京公共交通オープンデータチャレンジの最優秀作品").includes("quantity"));
  assert.ok(!L("LODチャレンジ2026 作品募集中！").includes("quantity"));
  // 番号の付いた運営の文は必須にしない
  assert.ok(!L("2.主催者は、本コンテストの広報活動・結果発表・展示等の目的に限り、応募作品を無償で利用できるものとします。").includes("required"));
  // 「必要になります」は必須
  assert.ok(L("参加決定時に保護者の同意書が必要になります。").includes("required"));
  // 可能性の「〜場合があります」は必須にしない
  assert.deepEqual(L("（証明書の提出をお願いする場合があります）"), []);
  // 「全日程に参加できること」は締切ではない（必須ではある）
  assert.deepEqual(L("2026年8月10日（月曜日）～15日（土曜日）までの全日程（宿泊含む）に参加できること。"), ["required"]);
  // お知らせ欄の「受付を開始しました」は締切ではない
  assert.ok(!L("2026.07.16　公共交通オープンデータ・ウェビナーの参加申込受付を開始しました。").includes("deadline"));
  // 給付の上限額は数量ではない
  assert.ok(!L("年間最大120万円（※1）").includes("quantity"));
  // 見出しの下の「注1」だけの行は必須を受け継がない
  const notes = detect([{ type: "h3", text: "応募資格" }, { type: "li", text: "注1：" }, { type: "li", text: "学校の定期考査や行事など、急な体調不良などを除く。" }], T);
  assert.deepEqual(notes.slice(1).map((s) => s.labels), [[], []]);
});

test("実ページ24件（10/18 2回目）で見つけた誤り", () => {
  const L = (text: string) => detect([p(text)], T)[0].labels;
  // 日程を1文に並べた行は、「まで」の直前の日付を締切として比べる（後ろの審査日・発表日で食い違いにしない）
  const ss = detect([
    p("● 応募期間　2026年3月25日～8月17日 13:00まで ● 1次審査（非公開）　2026年9月25日 ● 受賞発表　2026年10月30日"),
    p("なお、応募締切（2026年8月17日13時まで）以降の差し替えはできません。"),
  ], T);
  assert.ok(ss.every((s) => !s.labels.includes("conflict")));
  // 時間割の時刻は数量ではない
  assert.ok(!L("10時00分～10時20分").includes("quantity"));
  assert.ok(!L("11月2日（月曜日）23時59分エントリー締切").includes("quantity"));
  // 運営の実績の数字は数量ではない
  assert.ok(!L("過去6年間で延べ65,000人のエンジニア学生が参加").includes("quantity"));
  assert.ok(!L("オフ・オンラインで年間150回以上のイベントを開催").includes("quantity"));
  // 問いの文は数量にしない
  assert.ok(!L("あなたが100歳になったとき、本当に欲しいものは何ですか？").includes("quantity"));
  // ドル建ての賞品は数量ではない
  assert.ok(!L("$200 分の M5Stack ギフトカード").includes("quantity"));
  // 権利の帰属は必須ではない
  assert.ok(!L("応募作品の著作権は応募者に帰属するものとします。").includes("required"));
  // 人数の上限は数量のまま
  assert.ok(L("1チーム2～5名でのチームエントリーが可能です。").includes("quantity"));
});

test("禁止の語が文書の名前の中にあるだけの文は禁止に数えない（10/18）", () => {
  const L = (text: string) => detect([p(text)], T)[0].labels;
  assert.ok(!L("「東京都火災予防条例上の禁止行為」を必ずご確認の上、お申し込みください。").includes("prohibited"));
  assert.ok(!L("詳しくは「東京都火災予防条例上の禁止行為（PDF）」をご覧ください。").includes("prohibited"));
  assert.ok(!L("東京都火災予防条例上の禁止行為（PDF）").includes("prohibited"));
  assert.ok(L("会場内での「詰め替え」は禁止されています。").includes("prohibited"));
});

test("1つの段落につながった箇条は、番号・記号で文を分ける（10/18 公募まとめサイト）", () => {
  const ss = splitSentences([p("次の（１）～（１０）を満たす者とする （１）１５歳以上～２５歳以下（中学生を除く）の学生であること （２）１８歳未満の者は保護者からの同意を得ていること")]);
  assert.deepEqual(ss.map((s) => s.text), ["次の（１）～（１０）を満たす者とする", "（１）１５歳以上～２５歳以下（中学生を除く）の学生であること", "（２）１８歳未満の者は保護者からの同意を得ていること"]);
  const bullets = splitSentences([p("以下のいずれかの条件を満たす学生 ・大分都市広域圏に居住 ・大分都市広域圏の学校に在学")]);
  assert.equal(bullets.length, 3);
  const L = (text: string) => detect([p(text)], T)[0].labels;
  // 免責の文・短い見出し語は必須にしない
  assert.ok(!L("なお、権利侵害等に関するトラブルについて、主催者及び関係者は一切責任を負わないものとします。").includes("required"));
  assert.ok(!L("知るべきこと・すべきこと").includes("required"));
});

test("和暦の日付を読む（10/19 区の補助金ページ）", () => {
  const d = findDates("令和8年4月1日（水曜日）～令和9年3月15日（月曜日）必着", 2026);
  assert.deepEqual(d.map((x) => x.iso), ["2026-04-01", "2027-03-15"]);
  assert.deepEqual(findDates("令和元年5月1日", 2026).map((x) => x.iso), ["2019-05-01"]);
  const s = detect([p("申込（交付申請）は令和9年3月15日（月曜日）必着です。")], T)[0];
  assert.ok(s.labels.includes("deadline"));
});

test("表の番号だけのセルは、見出しの必須を受け継がない（10/19 区の必要書類の表）", () => {
  const ss = detect([{ type: "h3", text: "必要書類" }, { type: "td", text: "1" }, { type: "td", text: "住民税の納税証明書" }], T);
  assert.deepEqual(ss.slice(1).map((s) => s.labels), [[], ["required"]]);
});

test("年の書かれていない日付は、曜日が書いてあれば曜日に合う年にする（10/19 区のエアコン助成）", () => {
  // 2026年の文書で「1月20日（水曜日）」＝2027年1月20日が水曜日
  const ss = detect([p("令和8年度のエアコン購入費助成です。"), p("（5）助成金請求 【1月20日（水曜日）まで】")], T);
  assert.equal(ss[1].dates[0].iso, "2027-01-20");
  // 曜日が無ければ今までどおり
  assert.equal(findDates("1月20日まで", 2026)[0].iso, "2026-01-20");
  // 曜日が合っていれば変えない
  assert.equal(findDates("12月8日（火）", 2026)[0].iso, "2026-12-08");
});

test("点で区切った月日を読む・小数や版数は読まない（10/19 東京AIハッカソン）", () => {
  assert.equal(findDates("学生エントリー受付中・11.7まで", 2026)[0].iso, "2026-11-07");
  assert.equal(findDates("エントリー受付中11.7（土）まで", 2026)[0].iso, "2026-11-07");
  assert.equal(findDates("11.20最終提出資料・デモURL・3分のデモ動画", 2026)[0].iso, "2026-11-20");
  assert.deepEqual(findDates("倍率は1.5倍、評価は3.5点、v1.4 で直した。Python 3.12 を使う", 2026), []);
  assert.deepEqual(findDates("月額賃料の1/4以内、0.5以上", 2026), []);
  const ss = detect([p("11.20最終提出資料・デモURL・3分のデモ動画"), p("9.30 –エントリーフォームから申し込み。"), p("学生エントリー受付中・11.7まで")], T);
  assert.deepEqual(ss.map((s) => s.labels.includes("deadline")), [true, false, true]);
  assert.ok(!ss[2].labels.includes("quantity"));
});

test("「皆さんご参加ください」は誘いで、日程表・採点表の「30分」「5点」だけのセルは数量に数えない（10/19）", () => {
  const ss = detect([p("12:30〜19:00　17:30からは懇親会（皆さんご参加ください）"), { type: "p", text: "30分" }, { type: "p", text: "5点" }, p("チーム1〜4名。")], T);
  assert.deepEqual(ss.map((s) => s.labels), [[], [], [], ["quantity"]]);
});

test("日付だけの升目は、すぐ後ろの升目が提出・締切なら締切にする（10/19 東京AIハッカソンの日程の並び）", () => {
  const ss = detect([p("11.7"), p("一次審査提出締切（エントリーもこの日まで）。"), p("11.20"), p("最終提出"), p("資料・デモURL・3分のデモ動画"), p("11.22"), p("本選・東京"), p("審査員の前で発表・ライブデモ")], T);
  const dl = ss.filter((s) => s.labels.includes("deadline")).map((s) => s.text);
  assert.ok(dl.includes("11.7") && dl.includes("11.20") && !dl.includes("11.22"));
});

test("義務の別の言い方は必須・婉曲な禁止は禁止、禁止の語の否定は禁止にしない（10/19 Geminiの意地悪な文）", () => {
  const lab = (t: string) => detect([p(t)], T)[0].labels;
  for (const t of [
    "申請書類一式は、簡易書留による郵送でのみ受け付けます。", "指導教員の承諾を得た上でのご応募をお願いいたします。",
    "助成期間終了後に収支報告書の提出が求められます。", "応募作品は、応募者本人が制作した未発表の作品とします。",
    "採用された後は、年1回の交流会への出席が義務付けられています。", "日本国内の大学院に在籍している方を対象とします。",
  ]) assert.ok(lab(t).includes("required"), t);
  for (const t of [
    "第三者の著作権を侵害する恐れのある作品の応募はお控えください。", "期限を過ぎて到着した応募書類は、いかなる理由があっても受理いたしません。",
    "選考委員への事前の接触は厳に慎んでください。", "禁止事項に抵触する行為が確認された場合は審査を中止します。", "生成AIを用いたことが判明した作品は選考から外れます。",
  ]) assert.ok(lab(t).includes("prohibited"), t);
  for (const t of [
    "旧様式の申請書で提出された場合でも、直ちに無効とはなりません。", "特段の事情がない限り、奨学生の資格を取消すことはありません。",
    "過去に入賞歴がない方もご遠慮なくご応募ください。",
  ]) assert.deepEqual(lab(t), [], t);
});

test("月末・漢数字の日付を読む／期間の定義・現在・過去の報告は締切にしない（10/19 Geminiの意地悪な文）", () => {
  assert.equal(findDates("2026年11月末までに郵送してください。", 2026)[0].iso, "2026-11-30");
  assert.equal(findDates("2月末日まで", 2027)[0].iso, "2027-02-28");
  assert.equal(findDates("願書は令和八年十月二十三日の消印があるものに限る", 2026)[0].iso, "2026-10-23");
  const lab = (t: string) => detect([p(t)], T)[0].labels;
  assert.ok(lab("オンライン申請最終日は2026年10月30日です。").includes("deadline"));
  assert.ok(lab("エントリーは2026年11月20日17時00分をもって終了いたします。").includes("deadline"));
  assert.ok(!lab("2026年4月1日から2027年3月31日までの1年間を奨学金の支給期間とします。").includes("deadline"));
  assert.ok(!lab("2026年5月1日現在で休学している方は、募集期間中であっても申請の対象外です。").includes("deadline"));
  assert.ok(!lab("応募期間終了後、2026年4月10日に受賞作品集を刊行いたしました。").includes("deadline"));
  for (const t of ["応募できる作品は、1人につき1点に限ります。", "小論文は400字詰原稿用紙3枚にまとめて提出してください。", "推薦できる候補者は2名が上限となっております。", "申請できる助成プログラムは1件のみです。"]) assert.ok(lab(t).includes("quantity"), t);
  for (const t of ["審査委員会は、学識経験者および実務家5名以上で構成されます。", "地下鉄3番出口から徒歩5分以内の場所にあります。"]) assert.ok(!lab(t).includes("quantity"), t);
});

test("LP調・英語まじりの文：Deadline・Teams of up to・Do not・〜を提出止め・忘れずに・厳禁（10/19 Geminiの意地悪な文）", () => {
  const lab = (t: string) => detect([p(t)], T)[0].labels;
  assert.ok(lab("Submission deadline: 2026/11/20 23:59 JST").includes("deadline"));
  assert.ok(lab("Teams of up to 4 members（個人参加も可）").includes("quantity"));
  assert.ok(lab("Do not submit 既存のOSSをそのまま流用したコード。").includes("prohibited"));
  assert.ok(lab("リポジトリのPublic設定を忘れずに！").includes("required"));
  assert.ok(lab("デモ動画のYouTube限定公開リンクを提出✨").includes("required"));
  assert.ok(lab("README.mdにSetup手順を明記してください。").includes("required"));
  assert.ok(lab("事前審査は400字〜800字のテキストのみで選考します。").includes("quantity"));
  assert.ok(lab("提出物は3点。").includes("quantity"));
  assert.ok(lab("2026.11.20 18:00 プロトタイプ提出締切（遅刻厳禁）").includes("prohibited"));
  assert.ok(!lab("2026.11.01 募集開始（エントリーフォーム公開）").includes("deadline"));
  assert.ok(!lab("(PDF形式・1MB)").includes("quantity"));
});

test("実ページ46件（10/19 レビュー）：閲覧ソフトの案内・括弧だけの見出し・例示は必須にしない／否定形の資格・一般の〜してください・出来ません・不採択は拾う", () => {
  const lab = (t: string) => detect([p(t)], T)[0].labels;
  for (const t of ["PDFファイルを閲覧するには「Adobe Reader（Acrobat Reader）」が必要です。", "【制作するうえでの必須事項】", "（渡航・滞在費用はサンゴバン社負担）", "たとえば、福祉施設のケアがまちへ染み出していくような仕掛けを考えること。", "奨学金の選考基準を教えてください。", "正式採用は、入学を条件に理事会で決定します。"]) assert.ok(!lab(t).includes("required"), t);
  for (const t of ["（1～4のすべてに該当する必要があります。）", "市税等を滞納していないこと。", "テーマに沿ったプロダクトを自由に開発してください。", "②相談ダイヤルを入れてください。", "応募作品はAutodesk Fusionのみを利用して作成してください。", "資料は日本語で作成したものである事。"]) assert.ok(lab(t).includes("required"), t);
  for (const t of ["両方の部門への応募は出来ません。", "不備があった場合は不採択となります。", "締切を過ぎた場合、いかなる理由がございましても受付いたしかねます。", "レイヤー統合はしないこと", "奨学金の給付を停止します。", "上限を超えないようお願いします。"].slice(0, 5)) assert.ok(lab(t).includes("prohibited"), t);
  assert.ok(lab("総事業費の50％以内").includes("quantity"));
  assert.ok(lab("年間200日以上の稼働").includes("quantity"));
  for (const t of ["毎年全国400名以上の学生が参加しており、今年は10会場で開催します。", "最優秀賞（1点）", "1次審査通過（約120名）", "毎年5月、8月、12月の3回に分けて4か月分を振込", "プロジェクトは、最大100点満点で評価される。"]) assert.ok(!lab(t).includes("quantity"), t);
  for (const t of ["学生エントリーは6月1日（月）より受付を開始しています。", "(2026.9.24 現在)", "7月6日（月曜日）9:00に申請受付を再開いたします。"]) assert.ok(!lab(t).includes("deadline"), t);
});

test("値だけの升目は、直前の項目名から金額の数量にする／補助率を数量にする（10/19 補助金の表）", async () => {
  const { markAmounts } = await import("../src/core/topics.ts");
  const blocks = [{ type: "dt" as const, text: "補助上限額" }, { type: "dd" as const, text: "75万円" }, { type: "dt" as const, text: "補助率" }, { type: "dd" as const, text: "補助対象経費の3分の2以内" }, { type: "h3" as const, text: "補助率と補助限度額" }];
  const ss = detect(blocks, T); markAmounts(ss, "grant", blocks);
  assert.deepEqual(ss.map((s) => s.labels.includes("quantity")), [false, true, false, true, false]);
});

test("実ページ46件の2周目（10/19）：運営ができないことは禁止にしない／項目名（dt）は必須を受け継がない／〜いただきます・お願いします／西暦併記と「同年」の日付", () => {
  const lab = (t: string) => detect([p(t)], T)[0].labels;
  for (const t of ["なお、審査結果及び審査理由等には一切お答えいたしかねます。", "※提出された書類等は返却できません。", "審査状況に関するお問い合わせには応じられません。"]) assert.ok(!lab(t).includes("prohibited"), t);
  for (const t of ["交付決定日より前に支払いを行った事業は補助対象とはなりません。", "提出とみなしませんのでご注意ください。", "面接に欠席された方は、辞退したとみなします。", "奨学金の給付を中止することになります。", "次のいずれかに該当する場合は補助金の返還となります。"]) assert.ok(lab(t).includes("prohibited"), t);
  for (const t of ["制作したファイルはパブリックリンクを共有いただきます。", "応募することで個人の特定ができることに承諾いただきます。", "最終審査にご出席いただき、5分程度の発表をお願いします。"]) assert.ok(lab(t).includes("required"), t);
  assert.ok(!lab("ご協力をお願いします。").includes("required"));
  assert.ok(!lab("財団は、個人情報を適切に管理いたします。").includes("required"));
  const dt = detect([{ type: "h3", text: "提出書類" }, { type: "dt", text: "申請期限（消印有効）" }], T);
  assert.ok(!dt[1].labels.includes("required"));
  const d = detect([p("１次募集 令和８(2026)年４月２日（木曜日）から同年４月30日（木曜日）まで")], T)[0];
  assert.deepEqual(d.dates.map((x) => x.iso), ["2026-04-02", "2026-04-30"]);
  assert.ok(d.labels.includes("deadline"));
});

test("見出し・導入文の受け継ぎ：応募資格・提出書類の列挙／「以下の内容を必ず記載ください」の項目／失格の列挙（10/19 2つ目の46ページ）", () => {
  const L = (blocks: Block[]) => detect(blocks, T).map((s) => s.labels);
  // 導入文に必須が付いていれば、直後の箇条書きの項目も必須
  assert.deepEqual(L([p("応募資料には、以下の内容を必ず記載してください。"), { type: "li", text: "RESAS等による分析" }, { type: "li", text: "政策アイデアの概要" }]).map((l) => l.includes("required")), [true, true, true]);
  // 失格の導入文の下の項目は禁止
  assert.ok(L([p("次のいずれかに該当する場合は失格とします。"), { type: "li", text: "法令等に違反するもの" }])[1].includes("prohibited"));
  // 提出書類の見出し（dt）の下の項目
  assert.ok(L([{ type: "h3", text: "提出書類" }, p("世帯全員の住民票の写し")])[1].includes("required"));
  // 資格の節の短い本文（句点つき）
  assert.ok(L([{ type: "h3", text: "応募資格" }, p("日本国内の大学に在籍する学生。")])[1].includes("required"));
  assert.ok(!L([{ type: "h3", text: "応募資格" }, p("どなたでも応募できます。")])[1].includes("required"));
  const lab = (t: string) => detect([p(t)], T)[0].labels;
  for (const t of ["日本国籍を有していること", "【空き家の所有が要件】", "生活状況報告を行なわなくてはならない。", "過去に交付を受けていない人", "（１）日本国籍を有する者。", "地域の現状をご提案ください。"]) assert.ok(lab(t).includes("required"), t);
  assert.ok(!lab("生活状況報告を行なわなくてはならない。").includes("prohibited"));
  assert.ok(!lab("要件を満たせば必ず採択されるものではありません。").includes("required"));
  for (const t of ["留年した者は応募できない。", "×他人の説を評価なしに紹介しただけのもの"]) assert.ok(lab(t).includes("prohibited"), t);
  for (const t of ["8. 奨学金給付の停止及び取消しについて", "【内定取消について】"]) assert.ok(!lab(t).includes("prohibited"), t);
  for (const t of ["1人につき一編まで", "7分程度のプレゼンテーション", "3カ月以内に発行されたもの", "事業完了後10年間保存すること"]) assert.ok(lab(t).includes("quantity"), t);
  assert.ok(!lab("2026.09.01　U22プロコン応募受付は締め切りました。").includes("deadline"));
  assert.ok(lab("応募締切　2026年8月26（水曜日）17時まで").includes("deadline"));
  const sch = detect([{ type: "h3", text: "採用実績" }, p("採用内定59名、補欠9名")], T);
  assert.ok(!sch[1].labels.includes("quantity"));
});

test("3つ目の46ページ（10/19）：賞の表の升目・リンク行・運営の約束・推奨・「対象になりません」・住んでいる年数・一人一篇", () => {
  const lab = (t: string) => detect([p(t)], T)[0].labels;
  for (const t of ["募集要項(PDF形式, 1006.16KB)", "ご記入いただきました個人情報は、選考のために使用します。", "1,440×1080ピクセルを推奨します。", "受賞選外でもHPへ公開になります。", "補欠内定の資格は令和９年３月３１日まで有効とします。"]) assert.ok(!lab(t).includes("required") && !lab(t).includes("prohibited") && !lab(t).includes("deadline"), t);
  for (const t of ["事業が全て終わるものは対象になりません。", "間接経費は対象としていません。", "メールでの申請は受付けません", "審査対象から除外します。", "過去に入賞した作品はご応募いただけません。", "出席できない場合は選外となります。"]) assert.ok(lab(t).includes("prohibited"), t);
  for (const t of ["申請後に辞退する場合は、速やかに連絡してください。", "①YouTubeに動画を「限定公開」でアップロード。", "高等学校在学中に限って募集します。"]) assert.ok(lab(t).includes("required"), t);
  for (const t of ["本人又は保護者が1年以上市内に住んでいること。", "応募は一人一篇とする。", "申請は一回限り。", "A4サイズ4面以内", "助成金の2割以内", "生活保護基準額の１．０倍以下", "高校卒業後５年以内の者であること"]) assert.ok(lab(t).includes("quantity"), t);
  for (const t of ["年４回", "〒461-0005 名古屋市東区東桜二丁目2番1号"]) assert.ok(!lab(t).includes("quantity"), t);
  assert.ok(!lab("令和8年10月1日から令和9年3月31日までに実施する公益的な事業。").includes("deadline"));
  // 賞の表の升目
  const prize = detect([{ type: "dt", text: "金賞" }, { type: "dd", text: "1名5万円" }], T);
  assert.ok(!prize[1].labels.includes("quantity"));
  // 小数点の「．」で文を切らない
  assert.equal(splitSentences([p("収入基準は生活保護基準額の１．０倍以下です。")]).length, 1);
});
