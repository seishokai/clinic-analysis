// 初診管理シート → Aladdin sync 用のタブ設定。
// wrangler 3.x が import attributes (with { type: 'json' }) 未対応のため
// JSON ではなく JS モジュールで export する。
// 列は 0-based インデックス。columns 未指定なら header 行の名前で自動検出。

export default {
  sheet_id: "167IYM21HW0DGPlL1CrnCn4yTaTyC0KJU4f7gWyKtHf4",
  cutoff_date: "2026-08-01",
  header_aliases: {
    visit_date: ["来院日"],
    name: ["名前", "氏名"],
    source: ["初診由来", "初診由来媒体"],
    reason: ["来院理由", "目的", "主訴"],
    staff: [
      "ｶｳｾｲﾘﾝｸﾞｽﾀｯﾌ", "ｶｳｾﾘﾝｸﾞｽﾀｯﾌ", "ｶｳﾝｾﾘﾝｸﾞｽﾀｯﾌ",
      "カウセイリングスタッフ", "カウセリングスタッフ", "カウンセリングスタッフ",
      "担当DH",
    ],
    doctor: [
      "ｶｳｾﾘﾝｸﾞ時Dr", "ｶｳﾝｾﾘﾝｸﾞ時Dr",
      "カウセリング時Dr", "カウンセリング時Dr",
      "担当Dr",
    ],
    phone: ["※事務用 携帯電話", "電話番号", "携帯電話"],
  },
  tabs: [
    { name: "①銀座初診",   facility: "BF銀座" },
    { name: "①中日初診",   facility: "BF中日" },
    { name: "①京都初診",   facility: "京都" },
    { name: "①ルミナス初診", facility: "ルミナス" },
    { name: "①エスカ初診", facility: "エスカ" },
    // アール: row 1 に真のヘッダなし (Column 1/2/... の枠のみ)。data 位置から手動指定
    {
      name: "①アール初診", facility: "アール",
      columns: { visit_date: 1, name: 3, reason: 4, source: 5, staff: 6, doctor: 7 },
    },
    { name: "①茶屋初診",   facility: "茶屋" },
    // 八事: col D (-170 等) の追加列あり、name が E(4) に shift。date 形式 '26/07/09'
    {
      name: "①八事初診", facility: "八事",
      columns: { visit_date: 1, name: 4, reason: 5, source: 6, staff: 7, doctor: 8 },
    },
    { name: "①知立初診",   facility: "知立" },
    { name: "①小牧初診",   facility: "小牧" },
    { name: "①ウィズ初診", facility: "ウィズ" },
    { name: "①大森初診",   facility: "大森" },
  ],
};
