# sheet-sync Worker

**初診管理シート → Aladdin (Supabase) の自動同期 Worker**

- Cron: 10 分ごと (`wrangler.jsonc` の `triggers.crons`)
- HTTP: `GET /status` (最終同期情報)、`GET /sync?token=xxx` (手動同期)
- 対象: 初診管理シート `167IY...` の 12 個の `①○○初診` タブ
- cutoff: `2026-08-01` 以降の来院日
- 上書きポリシー: **INSERT ONLY** (既存 patient_visits は誰の編集でも触らない)

## デプロイ手順 (初回)

### 1. Supabase SQL 実行

`sql/v700_sheet_sync.sql` を Supabase Dashboard → SQL Editor で全文貼付け → **Run**。

これで作成されるもの:
- `patient_visits.source_channel` / `sync_source` カラム追加
- `sync_log` テーブル
- `uidx_visits_dedup` unique index (facility+normalized_name+book_date)
- `v_latest_sync` view

### 2. Worker のデプロイ

```bash
cd C:\Users\USER\clinic-analysis\worker\sheet-sync
npm install
```

**Supabase service_role キーを secret として登録** (対話式):

```bash
npx wrangler secret put SUPABASE_SERVICE_KEY
# → プロンプトが出るので sb_secret_... を貼り付けて Enter
```

**デプロイ**:

```bash
npx wrangler deploy
```

出力例:
```
Uploaded sheet-sync (X.XX sec)
Deployed sheet-sync triggers (X.XX sec)
  https://sheet-sync.tkm-koike.workers.dev
  schedule: */10 * * * *
```

### 3. 動作確認

```bash
# 状態確認 (まだ実行してなければ latest: null)
curl https://sheet-sync.tkm-koike.workers.dev/status

# 手動で 1 回動かす
curl "https://sheet-sync.tkm-koike.workers.dev/sync?token=aladdin-sync-2026"
```

正常なら以下のような JSON が返る:
```json
{
  "tabsRead": 12,
  "rowsRead": 178,
  "rowsInserted": 178,
  "rowsSkipped": 0,
  "rowsError": 0,
  "durationMs": 8421,
  "details": [
    { "name": "①銀座初診", "read": 16, "inserted": 16, "skipped": 0, "error": 0 },
    ...
  ]
}
```

### 4. Aladdin UI 側の確認

`https://seishokai.github.io/clinic-analysis/v600/` を開くと、ヘッダーに
`📥 シート同期: X分前` のバッジが出るので、クリックで手動同期発火できる。

## 運用

### タブが増えた/減った時
`config/sheet-tabs.json` の `tabs` 配列を編集 → `npx wrangler deploy` で反映。

### 列構成が変わった時
- ヘッダ名が変わっただけなら `header_aliases` に別名を追加
- 位置がズレたら `tabs[].columns` に手動 override 追加

### cutoff を変えたい時
`wrangler.jsonc` の `vars.CUTOFF_DATE` を変更 → `deploy`

### ログの見方
```bash
npx wrangler tail sheet-sync
```

または `sync_log` テーブルを SQL で:
```sql
SELECT * FROM sync_log ORDER BY run_at DESC LIMIT 20;
```

## トラブル

- **`Column visit_date/name 列を検出できず`** → タブの header 行が空 or 列名が別名。
  `header_aliases.visit_date` に追加 or `tabs[].columns` で手動指定
- **rowsError > 0** → sync_log の `details` 列 (JSON) にエラー内容が入る
- **Worker が動いてない** → `npx wrangler tail` でリアルタイム log 確認、
  Cloudflare Dashboard → Workers → sheet-sync → Logs
