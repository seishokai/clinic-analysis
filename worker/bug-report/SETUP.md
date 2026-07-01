# Aladdin バグレポート Worker セットアップ

## 1. Supabase 側の準備

### テーブル + Storage
```bash
# SQL Editor で実行
migrations/admin_bug_reports.sql
```

### Storage バケット作成
1. Supabase Dashboard → Storage → **New bucket**
2. 名前: `bug-reports`
3. **Public: ON** (screenshot_url を GitHub Issue から表示するため)
4. Bucket 作成後、**Policies** で anon INSERT + anon SELECT を許可
   - Policy 1 (INSERT): `bucket_id = 'bug-reports'` (TO anon, authenticated)
   - Policy 2 (SELECT): `bucket_id = 'bug-reports'` (TO anon, authenticated)

## 2. Cloudflare Worker デプロイ

```bash
cd worker/bug-report
npx wrangler login    # 初回のみ
npx wrangler deploy --config wrangler.toml --name aladdin-bug-reporter
```

## 3. Secret 設定

```bash
# GitHub PAT (repo scope。既存の trigger-monitor と同じ PAT で OK)
npx wrangler secret put GITHUB_PAT
# → 貼り付け

npx wrangler secret put GITHUB_REPO
# → seishokai/clinic-analysis

npx wrangler secret put SUPABASE_URL
# → https://ndlfqrvoejwgqfdtghmg.supabase.co

# service_role キー (Supabase Dashboard → Settings → API → service_role secret)
# ※ anon key と間違えないこと。書き込み時のRLS迂回に使う。
npx wrangler secret put SUPABASE_SERVICE_KEY

npx wrangler secret put ALLOWED_ORIGIN
# → https://seishokai.github.io
```

## 4. 動作確認

Worker のエンドポイント: `https://aladdin-bug-reporter.<your-subdomain>.workers.dev/`

Aladdin から `📊 管理 → 🐛 修正依頼` で送信 → GitHub Issue が作成されるはず。

## 5. 私 (Claude) の使い方

次のセッションで:
> 「GitHub Issues の aladdin-report ラベル見て順に修正して」

すると私が:
1. `gh issue list --label aladdin-report --state open` で一覧取得
2. 至急 → 通常 → 低 の順で処理
3. 各 Issue について:
   - コード修正 + commit + push
   - Issue に `Fixes #N` を含むコメント + `Closes #N` で完了
   - Supabase `admin_bug_reports` の status を「解決」に UPDATE
