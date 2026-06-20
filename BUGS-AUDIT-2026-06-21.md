# バグ監査レポート (2026-06-21 / v463 時点)

5並列エージェントによる横断監査結果。state-sync / auth / date-math / ui-filter / edge-case の 5 観点で検出。
**有効バグ 110件 (重複除去後)**。重大度 高=赤、中=橙、低=灰。

---

## ⚠️ 最優先 (セキュリティ・データ破損 / 22件)

### 認証・権限ホール
1. **[HIGH] migrations/admin_tools.sql:42** — admin_tools RLS が anon に FULL CRUD 許可。任意の訪問者が `javascript:` URL を全社員ダッシュに注入可能。`USING true / WITH CHECK true` を `is_auth_admin()` に置換。
2. **[HIGH] migrations/sales_tabs_open_write.sql:16** — sales_tabs も anon に INSERT/UPDATE/DELETE 許可。売上ポータルの改ざん/削除が可能。
3. **[HIGH] admin/index.html:392** — `EDITOR_PW='kanri1234'` がソース内平文。view-source で即露見。
4. **[HIGH] admin/index.html:397** — HR/Fin パスワード (`jinji1234`/`keiri1234`) が平文。`sessionStorage.setItem('admin_unlock_hr','1')` で即解除可能。
5. **[HIGH] admin/index.html:423** — `isUnlocked()` はクライアント判定のみ。HR/Fin 行は anon クエリで全部返ってくる (Network タブで全閲覧可能)。
6. **[HIGH] sales/index.html:393** — 管理者パスワード `Edoyadepon1` 平文 + `localStorage 'sales-admin-token'='true'` 直接設定で管理権限取得。
7. **[HIGH] sales/index.html:678** — `card.href = node.url` で `javascript:`/`data:` URL を検証なし。anon-write と組合せで Persistent XSS。
8. **[HIGH] app.js:1039** — `?view=tc` で 4桁数値パスコード `5858` のみで TC ロール取得 (`sessionStorage.tcPassed=true` で完全バイパス)。
9. **[HIGH] app.js:1086** — `sessionStorage.authenticated='true'` をブートで信用。`role='admin'` も直接設定可能 = devtools で完全になりすまし。
10. **[HIGH] app.js:1097** — `userRole = sessionStorage.role || 'admin'` がデフォルト admin。ネットワーク失敗時に admin に昇格。
11. **[HIGH] app.js:5332** — `switchView()` にロールチェックなし。`switchView('admin')` で管理画面の DOM が露出 (権限管理/インセ率)。
12. **[HIGH] app.js:7850** — `🗑 削除` ボタンが `canEditContent()` でガード (staff_promo も該当)。`canDeleteRecord()` に変更すべき。
13. **[HIGH] app.js:16203,16512** — `PARA_PASSCODE='para'` 4文字平文 + sessionStorage フラグでバイパス可能。

### XSS
14. **[HIGH] app.js:8338** — `saveRowEdit` で `d.name` をエスケープせず複数の `data-name` 属性に注入。属性 XSS。
15. **[HIGH] app.js:12222** — BF テーブル `${d.name}` `${d.applyDate}` `${extra.contractAmount}` ノー・エスケープ。
16. **[HIGH] app.js:12231** — `value="${extra.contractAmount||...}"` 未エスケープ、bk-extra 経由で別アカウントが注入可能。
17. **[HIGH] index.html:1735** — QA エディタの `${item.q}` `${item.a}` 直接 innerHTML 注入。誰でも保存できる。
18. **[MED] app.js:14833** — `${h.agency}` `${h.month}` 広告ヘッダー未エスケープ。

### データ破損リスク
19. **[HIGH] app.js:1091** — `setupEventListeners()` 二重呼び出し (1091/1105 競合)。全 addEventListener が二回登録され、1クリックで保存が二度走る。
20. **[HIGH] app.js:357** — `processQueue()` 並行起動で同じキューを両方読む → 同じ操作が二度実行 / または消失。
21. **[HIGH] app.js:8013** — `renderBookings` が `bk-extra` のスナップショットを閉包に持ち、`saveExtra` が古いスナップショットを localStorage に書き戻す → 別タブの変更が消える。
22. **[HIGH] app.js:12268** — `renderBFBookings` も同パターンで `bkExtraLocal` をクロージャ汚染。

---

## 🔴 計算ロジックバグ (15件)

23. **[HIGH] medical-deduction/index.html:425** — 給与所得控除が年収 162.5万〜187.5万で 65万円下限を割る (例: 180万 → 62万)。法令違反の控除過小。`Math.max(650000, …)` を追加。
24. **[HIGH] app.js:12625** — 成約金額集計が `bkExtra` のみ参照。`d.contractAmount` を見落としレガシーデータで合計 0 円。
25. **[HIGH] app.js:15940** — `avgAmount = totalAmount/contracted` だが totalAmount は全件 (非成約も) → 平均単価が過大。
26. **[HIGH] app.js:15997** — `renderRecordings` で同じ avgAmount バグ。
27. **[HIGH] app.js:13045** — `visitRate = (totalAll-cancelledAll)/totalAll` (未来含む) → 「来院率」と称しながら実は「非キャンセル率」。v460 で予約タブ修正済だが promo-dash で未修正。
28. **[HIGH] app.js:13116, 13137, 13148** — 同じ未修正 visitRate バグが promo-dash の医院/治療/プロモテーブルにも残存 (3箇所)。
29. **[MED] app.js:3489** — `delta(cur,prev)` が prev=0 のとき常に 100 を返す → 「0→1」も「0→100」も ▲100% 表示。「新規」ラベルに分岐。
30. **[MED] app.js:3463** — `unitPrice = amount/contracted.length` で amount に bkExtra 金額を含めず → 単価過小。
31. **[MED] medical-deduction/index.html:433** — 基礎控除の閾値判定に「合計所得」ではなく「年収」を使用 → 高所得帯で控除誤判定。
32. **[MED] medical-deduction/index.html:490** — 復興特別所得税 (×1.021) を含めず還付額を 2.1% 過小評価。
33. **[MED] app.js:5919** — `totalSelf` が `Number(d.selfPay)` で undefined→NaN 伝播 → `¥NaN` 表示。`Number(d.selfPay||0)`。
34. **[MED] app.js:14807-14809** — 広告予算合計で `total_budget`/`common_cost`/`fee` の Number(undefined) → NaN。
35. **[MED] app.js:12628** — 分析タブ来院率の母数に未来予約を含む → 低めに出る。
36. **[MED] app.js:7559** — 成約率も同じく未来予約含む `visited` を母数に。`pastVisited` を使うべき。
37. **[LOW] dental-loan/index.html:279** — `月平均利息 = totalFee/(y*12)` ラベルが misleading (元利均等は前倒し)。初月利息 ≠ 月平均。

---

## 🟠 日付・タイムゾーン (16件)

38. **[HIGH] app.js:11193, 16110, 18239** — `new Date().toISOString().slice(0,10)` が UTC 日付。JST 00:00〜09:00 に呼ぶと前日扱い → 当日データがフィルタから外れる (3箇所)。
39. **[HIGH] app.js:869, 9769, 10248, 11484** — `parseDateLoose` / `normDateKey` / `_parseAnyDate` / 会員 view が `M/D` 短縮形式に対し無条件で今年の年を当てる。1月初旬に `12/30` の前年予約が未来扱いに (4箇所)。
40. **[MED] app.js:7414, 7591, 9984, 11286, 14149, 8571** — `last.setMonth(last.getMonth()-1)` で月末日繰上問題。3/31 に setMonth(2) → 3/3 になり「先月」ラベルが今月になる (6箇所)。
41. **[MED] app.js:12317, 12336** — `lastMonthEnd = '${y}/${m}/31'` で短月でも 31 固定 → 不正日付通過。
42. **[MED] app.js:13621** — `daysSince = floor((todayMs-bdMs)/86400000)`、`bdMs` に時刻含むため 14日前 15時予約が 13日扱い → 「2週間以上」フィルタから漏れる。
43. **[MED] app.js:4119** — `new Date(d.updated_at).getTime()` が日付のみ文字列で UTC 解釈 → ソート/重複判定が日付境界でズレる。
44. **[LOW] app.js:14916** — バックアップ削除判定で UTC vs JST の 9時間ズレ。

---

## 🟡 State / 同期競合 (18件)

45. **[HIGH] app.js:1179** — `logout()` が sessionStorage のみクリア、`bk-extra` `bk-memos` `self-recordings-backup` `save-queue-v1` が残存 → 次ユーザーが前ユーザーのデータを閲覧。
46. **[HIGH] app.js:1171** — `logout()` がメモリ上の `bookingsData` `bfLifecycleCache` `recordingsCache` を消去せず → 次ユーザーに前ユーザーの行が瞬間表示。
47. **[HIGH] app.js:15232** — `self-recordings-backup` (患者名・契約・金額・メモ) が logout 時に削除されず → PII 漏洩。
48. **[HIGH] app.js:9275** — `loadBFLifecycleData` が cache を空に → 進行中の楽観的更新と競合。一時的に表示が巻き戻り。
49. **[HIGH] app.js:15121** — `loadPromoRates` の wipe-then-fill で `calcIncentive()` が 0 を返す瞬間が存在 → インセ計算誤り。
50. **[MED] app.js:2094** — 🔄 ボタンが `Promise.all([loadBookings, loadBFLifecycleData, loadPromoRates])` だが `loadBookings` 内でも後2つを呼ぶ → ネットワーク 2倍 + 状態競合。
51. **[MED] app.js:4101** — `_availabilityPollTimer` が view 切替・logout でクリアされず → 30秒毎にバックグラウンドでフェッチ継続。
52. **[MED] app.js:5247** — `_badgeUpdateTimer` も logout で消えず → ログアウト後にバッジが復活。
53. **[MED] app.js:3105** — `setTimeout(maybeAutoBackup, 5000)` が logout 時に消えず → ログアウト後にバックアップ走る。
54. **[MED] app.js:8370, 9624, 6680** — `sb.from(...).update().then(()=>{})` パターンが多数。エラー時もトーストが「成功」を表示し DB と UI が乖離 (3箇所)。
55. **[MED] app.js:16251** — `scheduleParaSave` の last-write-wins デバウンスで grams と date を素早く切替えると grams が消失。
56. **[MED] app.js:2342** — `ensureBFData` が `_bfAllData.length===0` でしか再構築せず → 新規追加が BF タブに反映されない。
57. **[MED] app.js:520** — realtime INSERT が `if(d)` で no-op → 別ユーザーの新規予約が見えない。
58. **[LOW] app.js:13408** — followup_meta が 250ms デバウンス + リモート失敗を `.catch(()=>false)` で隠蔽 → 別ユーザーに反映されないまま。
59. **[LOW] app.js:928** — `storage` イベントが `bk-memos` のみ監視。`bk-extra` 変更で他タブが古い金額表示のまま。
60. **[LOW] app.js:7158** — `saveSharedSetting()` のエラーが silently 無視 → ローカルと Supabase が乖離。
61. **[LOW] app.js:4956** — call-mode メモの `setInterval(check, 300)` が連打で多重起動。
62. **[LOW] app.js:11915** — 200ms `setTimeout` 内で古い `bfRows` 参照を維持 → 再レンダ後の操作で古い行を描画。

---

## 🟢 UI / フィルタ / イベント (22件)

63. **[HIGH] app.js:12598** — `renderAnalysis` が `sFac(facility)` を使うが `renderBookings(7367)` `renderApplyAnalysis(12303)` は `normFac()`。同じ予約が view 間で別バケットに。
64. **[HIGH] app.js:5912** — `renderSales` が `d.facility === salesFacility` の直接等値比較 (正規化なし) → 長い医院名 (`BF銀座歯科・矯正歯科`) の行が消える。
65. **[HIGH] app.js:7719** — `renderBookings` が tbody.innerHTML を全置換 → 編集中の input にリアルタイム更新が来ると入力中の値が消失。
66. **[MED] app.js:7325** — `bk-search` が NFKC 正規化なし → 全角/半角カナ・ひらがな/カタカナ不一致。
67. **[MED] app.js:8470** — `saveMemoModal` に二重送信ガードなし → 保存ボタン連打で 2 回 upsert。
68. **[MED] app.js:5883** — `saveSalesEntry` も連打可、負数も通過。
69. **[MED] app.js:8096** — 成約金額インライン編集が負数を受け付ける → 合計が突然減る。
70. **[MED] app.js:7641** — `_bkSortFn` がタイブレーカなし → 同一日付の BF 行が再レンダで順序入れ替わり。
71. **[MED] app.js:12615** — `an-tool` セレクトが HTML ハードコード (`DXHUB`/`セレクト` のみ) → 新しいツールがフィルタに出ない。
72. **[MED] app.js:2487** — `bk-reset` ボタンが `bk-show-excluded` チェックボックスをリセットしない。
73. **[MED] app.js:2435** — `an-reset` が `window._anAxis` (軸) をリセットしない。
74. **[MED] app.js:2447** — `_anAxis` がセッション跨ぎで永続 → 「プロモ別」が active 表示なのに実は「医院別」グループ化。
75. **[MED] app.js:18336** — 問診票 clinic フィルタが trim/正規化なしで完全一致 → 末尾空白の不一致で消失。
76. **[MED] app.js:5332** — `switchView` が URL hash と同期しない → ブラウザ戻る/進むがアプリ外へ離脱。
77. **[MED] app.js:8118** — `bk-memo-cell` のクリックハンドラを行毎に再アタッチ → 1000行で 1000 クロージャ生成。スマホで体感ジャンク。
78. **[MED] app.js:2511** — `confirm()` 同期呼び出しでメインスレッドブロック。既存モーダル使用が望ましい。
79. **[MED] index.html:1058** — `rec-facility` セレクトが 11医院ハードコード、**岩田が漏れ**。row-edit-modal (1495) は岩田あり。
80. **[MED] index.html:1063** — `rec-amount` `rec-duration` が `min="0"` なし → 負数登録可能。
81. **[MED] app.js:349** — toast の z-index:999、bottom-nav (z-index:9999) より下 → スマホで toast が見えない。
82. **[MED] index.html:1502** — `qa-cat-modal` 等が `style='display:none'` で隠蔽 → グローバル ESC ハンドラが効かない。
83. **[LOW] app.js:2213** — ESC ハンドラが 2 箇所登録、毎回二度走る。
84. **[LOW] index.html:446** — `refresh-btn` `logout-btn` 等に aria-label なし。

---

## 🔵 Edge case / null・undefined (17件)

85. **[HIGH] app.js:9138, 9143** — `Math.round(v.t/total*100)` で total=0 なら NaN%。
86. **[MED] app.js:3469** — `ymToDate` が `ym.split('/')` のみ。`YYYY-MM` 形式 (input type=month) で破綻。
87. **[MED] app.js:7354, 12589, 12754** — `JSON.parse(sessionStorage.customPromos)` 等が try/catch なし → 破損で renderBookings/Analysis 全クラッシュ (3箇所)。
88. **[MED] app.js:324, 340** — `JSON.parse(localStorage.getItem('save-queue-v1'))` も裸 → キュー詰まり時にすべての save が throw。
89. **[HIGH] app.js:11805** — `parseCsFac` が JSON.parse 成功時に `Array.isArray` 検証なし → 非配列が後続の `.includes` で silently mismatch。
90. **[MED] app.js:12431, 12496, 16156** — `Math.max(...emptyArr)` で `-Infinity` → 後続の heat() が壊れる (3箇所)。
91. **[MED] app.js:3443** — `bookDate.localeCompare` で文字列ソート、`M/D HH:MM` と `YYYY/MM/DD HH:MM` 混在で順序狂う。
92. **[MED] app.js:18039, 18074** — `new Date(r.submitted_at).getTime()` で null → epoch 0 / undefined → NaN。日数フィルタが silently 誤判定。
93. **[MED] app.js:14494** — `tm.split('-')` が長さ未検証で `parseInt(undefined)` → 「NaN月分」表示。
94. **[MED] app.js:2282, 6095** — `document.getElementById('fac-new-save').addEventListener` 等が `?.` なし → DOM 未準備でクラッシュ。
95. **[MED] app.js:7344** — `d.name.toLowerCase()` で d.name が Number だと throw。
96. **[LOW] app.js:800, 819** — `normFac` / `normSvc` で非文字列入力で `.includes` throw。
97. **[LOW] app.js:1419** — SMS テンプレで `ctx[key]||''` が値 0 を空文字列化 → 「お支払い 0円」が「お支払い 円」になる。
98. **[LOW] app.js:7854** — `tbody.innerHTML += …` (さらに200件) で focused input 失効。
99. **[LOW] app.js:8818** — 重複検査が `d.bookDate.includes(…)` で非文字列 throw リスク。
100. **[LOW] app.js:5984** — 数値表示が 100万未満で fmt・以上で「万」単位に切替、閾値直前直後で表示一貫性なし。

---

## 補足: 軽微・改善余地 (10件 — 100超過分)

101. app.js:6107 - `Number(input.value)||0` で 'abc' を 0 に silent coerce。
102. app.js:8485 - メモ改行が `\n→' '` で折り畳まれて表示。
103. app.js:11171 - logout が localStorage 'pwa-install-dismissed' を残す (意図的かも)。
104. app.js:15282 - saveRecording が未来日付を許可。
105. app.js:7344 - 予約 search が名前のみ、問診票は phone/email も検索 (一貫性なし)。
106. app.js:12600 - anPromo dropdown が source=null の行を選択肢に含めない。
107. app.js:8455 - `toLocaleDateString` がブラウザ依存。
108. app.js:1192 - logout で localStorage 'customPromos' を消さない。
109. migrations/medical_questionnaires.sql:110 - anon INSERT がレート制限なし → スパム可能。
110. app.js:8801 - `new Date(y, m-1, d)` で 2/29 非閏年が 3/1 にロールオーバー (検出ロジックあり、一応OK)。

---

## 修正優先度

| 順位 | カテゴリ | バグ番号 | 内容 |
|---|---|---|---|
| ★1 | RLS 緊急 | 1, 2 | admin_tools / sales_tabs の anon FULL CRUD を `is_auth_admin()` に。**即時** |
| ★2 | XSS | 14-18 | esc() を多数の innerHTML に適用 |
| ★3 | 認証バイパス | 8-13 | switchView ロールチェック / role 既定値 / hardcoded PW 撤去 |
| ★4 | データ破損 | 19-22 | setupEventListeners 二重・bk-extra clobber |
| ★5 | 計算ロジック | 23-37 | 給与所得控除下限・成約金額集計・visitRate (4箇所) |
| ★6 | 日付 | 38-44 | toISOString → ローカル日付 / setMonth → 1日固定 |
| ★7 | 同期 | 45-62 | logout 全クリア・タイマー解除 |
| ★8 | UI | 63-84 | 正規化統一・フォーカス保護・min属性 |
| ★9 | Edge | 85-100 | JSON.parse 防御 / Math.max 空配列 / nullable Date |
