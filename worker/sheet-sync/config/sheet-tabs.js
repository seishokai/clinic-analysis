// 初診管理シート + 予約管理シート → Aladdin sync 用の設定
// v900: 予約管理シート (BOOKING_SHEET) を追加、直予約 vs 予約ツール経由 の判別を可能に

export default {
  // ============ 初診管理シート (実際に来院した人) ============
  sheet_id: "167IYM21HW0DGPlL1CrnCn4yTaTyC0KJU4f7gWyKtHf4",
  cutoff_date: "2026-04-01",   // v923 B5: env.CUTOFF_DATE (wrangler.jsonc) が優先、これは fallback。誤解防止のため統一。
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
    {
      name: "①アール初診", facility: "アール",
      columns: { visit_date: 1, name: 3, reason: 4, source: 5, staff: 6, doctor: 7 },
    },
    { name: "①茶屋初診",   facility: "茶屋" },
    {
      name: "①八事初診", facility: "八事",
      columns: { visit_date: 1, name: 4, reason: 5, source: 6, staff: 7, doctor: 8 },
    },
    { name: "①知立初診",   facility: "知立" },
    { name: "①小牧初診",   facility: "小牧" },
    { name: "①ウィズ初診", facility: "ウィズ" },
    { name: "①大森初診",   facility: "大森" },
  ],

  // ============ 予約管理シート (予約ツール経由の予約) ============
  //   v900: DXHUB + セレクトタイプ (計 5 タブ) を定期 import
  //   これで「予約ツール経由の人が来たかどうか」の判定が可能になる
  booking_sheet_id: "10misKpAtMitwIagGDUoMvQS7U9pfEQ0ODxG8A7DLzaQ",
  booking_tabs: [
    // 元データ (DXHUB) — 全医院分。medium col 4 に医院名 (BF銀座歯科・矯正歯科 等)
    {
      name: "元データ",
      tool: "DXHUB",
      has_header: true,
      cols: {
        register_at: 0,    // 登録日時
        book_at: 1,        // 予約日時 (2026/8/16 9:30)
        name: 2,
        service: 3,        // 相談内容 (【ブラックフィルム】... 等)
        facility: 4,       // 医院名 (col から動的に取得)
        email: 5,
        phone: 6,
        promo_code: 7,     // プロモコード
      },
    },
    // セレクトタイプ (医院ごと、facility は固定)
    {
      name: "銀座セレクトタイプ",
      tool: "セレクト",
      facility: "BF銀座",  // タブ由来固定
      has_header: true,
      cols: {
        register_at: 0,    // 登録日
        book_at: 1,        // 予約日 (2026年9月8日(火) 18時30分)
        name: 2,
        phone: 3,
        email: 4,
      },
    },
    {
      name: "ウィズセレクトタイプ",
      tool: "セレクト",
      facility: "ウィズ",
      has_header: true,
      cols: { register_at: 0, book_at: 1, name: 2, phone: 3, email: 4 },
    },
    {
      name: "京都セレクトタイプ",
      tool: "セレクト",
      facility: "京都",
      has_header: false,   // データが 1 行目から始まる
      cols: { register_at: 0, book_at: 1, name: 2, phone: 3, email: 4 },
    },
    {
      name: "ルミナスセレクトタイプ",
      tool: "セレクト",
      facility: "ルミナス",
      has_header: false,
      cols: { register_at: 0, book_at: 1, name: 2, phone: 3, email: 4 },
    },
  ],
};
