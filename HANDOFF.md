# 🔄 セッション引継ぎ (2026-04-24)

次のClaudeセッションで作業を継続するための引継ぎ情報。

---

## 📁 プロジェクト

- **場所**: `C:\Users\USER\Downloads\10_フォルダ\clinic-analysis\`
- **用途**: 清翔会（歯科医院グループ）の予約・来院・売上管理 SPA
- **公開**: https://seishokai.github.io/clinic-analysis/
- **デプロイ**: git push master で GitHub Pages に自動反映 (約1-2分)
- **バックエンド**: Supabase (プロジェクト: `ndlfqrvoejwgqfdtghmg`)

---

## 🎯 今のメインタスク

**TODO.md に20個の改善案がリスト化済み**。少しずつ消化していく方針。

### 現在の進捗: 10/20 完了

完了済み（v259-v263）:
- ✅ 項目 1: 📞 電話前確認タブ (v263)
- ✅ 項目 2: 🏠 ダッシュボード (v262)
- ✅ 項目 3: プルリフレッシュ (v261)
- ✅ 項目 4: 通知バッジ (v261)
- ✅ 項目 7: メモテンプレート (v261)
- ✅ 項目 13: スケルトン CSS (v261)
- 追加: モバイル UI 総点検 + キャッシュ自動ログイン防止 (v259-v260)
- 追加: PBM インセンティブタブ (v256 以前)
- 追加: インプラントステータス統合 (v254)
- 追加: 個人情報マスク (v247)

### 残りタスク（優先順）

**🔴 次にやる候補**:
- 項目 5: キーボードショートカット (Ctrl+K 検索 / Ctrl+1〜5 タブ切替)
- 項目 6: 一括ステータス更新 (複数選択)
- 項目 8: お気に入り/ピン留め
- 項目 14: スワイプアクション
- 項目 15: 音声入力メモ

**🟢 後回し可**:
- 項目 9: カレンダービュー (工数大)
- 項目 17: PWA オフライン (工数大)
- 項目 20: 2FA (工数中〜大)

---

## 📝 重要な仕様メモ

### 認証構造
- **Supabase Auth** で admin / staff_promo / agency の 3ロール
- `?login` URL → 強制ログアウト + ログイン画面 (キャッシュ防止)
- admin は `?login` URL からログイン不可（通常URLのみ）
- `can_view_pii=true` のアカウント (例: 丸田) は PII 平文表示可

### URL 体系
- `/` → ポータル + 通常ログイン
- `/?login` → プロモ/代理店向け直リンク（adminブロック）
- `/?view=para` → パラ管理（外注用）
- `/pbm.html` → PBM インセンティブ案内
- `/pbm-apply.html` → PBM 申請 Excel 式一括入力（パスワード: `Seishokai1`）

### データ
- 全予約データは Google スプレッドシートから取得 → `bookingsData` (メモリ)
- ステータス編集は `booking_status` テーブルに upsert
- メモは `bk-memos` (localStorage) に保存

### 権限フィルタ
- `_hasPromoRestriction()`: プロモ制限ありか
- `_matchesAllowedPromo(source)`: 許可プロモとマッチか
- `getFilteredBookingsData()`: 権限適用済みデータ取得

### マスク関数
- `_isPII_MaskNeeded()`: マスク必要か (admin または can_view_pii=true なら false)
- `maskName(name)` / `maskPhone(phone)` / `maskEmail(email)`

---

## 🗂️ 主要ファイル

| ファイル | 内容 | 規模 |
|---|---|---|
| `app.js` | SPA ロジック本体 | ~9800行 |
| `index.html` | SPA シェル | ~1200行 |
| `styles.css` | 全スタイル | ~1000行 |
| `pbm.html` / `pbm-apply.html` | PBM 専用ページ | |
| `migrations/*.sql` | DB マイグレーション | |
| `worker/auth-admin/worker.js` | Cloudflare Worker (アカウント管理) | |
| `TODO.md` | 改善案リスト | |

### 最近のバージョン
- index.html の `<script src="app.js?v=263"></script>` で管理
- 新コード push のたびに番号を上げる（キャッシュバスター）

---

## ⚠️ 注意事項（重要）

1. **段階的に進める**
   - ユーザー希望: 一度に大量変更しない、1〜数件ずつ消化
   - 完了したら TODO.md を更新して commit
   - 大きな変更の前に「これだけやっていい？」と確認

2. **モバイル最優先**
   - ユーザーは現場でスマホ利用。モバイル UX が重要
   - ボトムナビ: 予約/来院/TC/売上/広告/管理 の6項目
   - フィルター/サブナビは sticky 化済み (v260)

3. **個人情報の取扱**
   - staff_promo/agency には名前・電話・メールをマスク
   - admin または can_view_pii=true のアカウントのみ平文
   - CSV 出力もこれに準拠

4. **Supabase 直接触らない**
   - SQL マイグレーションは `migrations/` に書いて、ユーザーに実行してもらう
   - Supabase Auth のユーザー作成/削除は Cloudflare Worker 経由 (`auth-admin`)

5. **保存はすべて `safeSave` 経由**
   - オフライン時は localStorage にキューイング、後で再送

---

## 🔐 認証情報メモ

- **admin**: `tkm.koike@gmail.com`
- **staff_promo 例**: 丸田 (can_view_pii=true で PII 平文可)、村瀬様 (マスク通常)
- **agency 例**: 小池 (id=19, 全プロモ許可 `%`)
- **PBM パスワード**: `Seishokai1`（固定、社内共通）

---

## 🚀 次セッションの開始プロンプト例

```
清翔会アプリ (C:\Users\USER\Downloads\10_フォルダ\clinic-analysis) の改善作業を継続します。
HANDOFF.md を読んで現状を把握して。
次は TODO.md の項目5 (キーボードショートカット) から始めたいです。
```

---

## 📞 問題が起きたら

1. エラーの Network Response body (F12) 送ってもらう
2. console エラー文を送ってもらう
3. `SELECT` で DB 状態を Supabase SQL Editor で確認

---

## 💾 memory 参照

- `feedback_incremental_work.md`: 少しずつ段階的に進める方針
- `feedback_protected_files.md`: 保健所・定款ファイルは触らない
- `user_domain.md`: 歯科・医療法人関連の業務
