/**
 * 初めて開いた時に、通信なしで走らせる見本（架空の要項）。実在の主催者・制度とは無関係。
 * 5色（必須・締切・数量・禁止・食い違い）とただし書きが全部出るように書いてある（tests/sample.test.ts が固定）。
 */
import type { Block } from "./detect.ts";

export const SAMPLE_TITLE = "見本：第3回 みどり市 学生アプリコンテスト 募集要項（架空）";
export const SAMPLE_BLOCKS: Block[] = [
  { type: "h2", text: "第3回 みどり市 学生アプリコンテスト 募集要項（架空）" },
  { type: "h3", text: "応募資格" },
  { type: "li", text: "応募時点で大学・高専・専門学校に在学している方。", group: 1 },
  { type: "li", text: "1人または3名までのチームで応募できます。チームの場合は代表者が応募してください。", group: 1 },
  { type: "li", text: "未成年の方は保護者の同意が必要です。", group: 1 },
  { type: "h3", text: "応募期間" },
  { type: "p", text: "応募締切は2026年12月8日（火）23:59です。" },
  { type: "h3", text: "提出物" },
  { type: "li", text: "作品の URL と、100字以内の作品紹介を提出してください。", group: 2 },
  { type: "li", text: "紹介動画（3分以内）は任意です。", group: 2 },
  { type: "h3", text: "注意事項" },
  { type: "li", text: "同じ作品を他のコンテストへ応募することは禁止します。ただし、学内の授業で発表した作品は除きます。", group: 3 },
  { type: "li", text: "応募作品は、応募者が自ら制作したものに限ります。", group: 3 },
  { type: "li", text: "生成AIを使った作品も応募できます。", group: 3 },
  { type: "h3", text: "よくある質問" },
  { type: "p", text: "締切を過ぎても受け付けてもらえますか？" },
  { type: "p", text: "受け付けません。なお、応募期間は2026年12月10日まで延長されることがあります。" },
];
