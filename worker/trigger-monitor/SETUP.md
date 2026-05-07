# seishokai-trigger-monitor Cloudflare Worker デプロイ手順

予約枠確認タブから**ワンクリックで shareconnect 再チェック**を起動するための
Cloudflare Worker。GitHub Actions の `monitor.yml` を `workflow_dispatch` で
起動する役割。GitHub PAT は Worker secret に格納してフロントには出さない。

---

## なぜ Worker が必要か

- GitHub の `workflow_dispatch` API には PAT (Personal Access Token) が必要。
- PAT をフロントエンドに置くと公開リポジトリで誰でも見える → リポジトリ乗っ取りリスク。
- Worker secret に格納すれば暗号化保管され、フロントはWorker URLにPOSTするだけ。
- CORS で `seishokai.github.io` からのアクセスのみ許可。

---

## デプロイ手順 (ブラウザ完結)

### 1. GitHub PAT を作成

#### A. Personal Access Token (fine-grained) を作る
1. https://github.com/settings/personal-access-tokens を開く
2. **Generate new token** → **Generate new token (fine-grained)**
3. **Token name**: `seishokai-trigger-monitor`
4. **Expiration**: 90日 or 1年（期限切れ時に再発行が必要）
5. **Repository access** → **Only select repositories** → `seishokai/clinic-analysis` を選択
6. **Permissions** → **Repository permissions**:
   - **Actions**: `Read and write` ← これだけ
7. **Generate token** → 表示された `github_pat_xxxxx...` を**安全な場所にコピー**（再表示不可）

### 2. Cloudflare Dashboard で Worker 作成

1. https://dash.cloudflare.com/ にログイン
2. 左メニュー **Workers & Pages** → **Create application** → **Create Worker**
3. 名前: `seishokai-trigger-monitor`
4. **Deploy** (テンプレのまま一旦デプロイ)

### 3. worker.js の中身を貼り付け

1. 作成した Worker の画面で **Edit code** (右上)
2. 左ペインの `worker.js` を全選択 → 削除
3. 同じフォルダの **`worker.js` の中身を全部コピペ**
4. 右上 **Save and deploy**

### 4. 環境変数 (Secrets) を設定

Worker 画面 → **Settings** → **Variables and Secrets** → **Add**

以下 2つを追加。**必ず `Encrypt` にチェック**。

| 変数名 | 値 | 備考 |
|:-------|:---|:-----|
| `GITHUB_PAT` | 手順1でコピーした `github_pat_xxx...` | ⚠️ 絶対に秘匿。漏れたら即GitHubでrevoke |
| `ALLOWED_ORIGIN` | `https://seishokai.github.io` | CORS 制限。GitHub Pages 以外からは弾く |

### 5. 疎通テスト

ターミナルで:

```
curl -X POST https://seishokai-trigger-monitor.tkm-koike.workers.dev/trigger \
  -H "Origin: https://seishokai.github.io"
```

期待レスポンス:
```json
{"ok":true,"message":"Workflow triggered (約4分後完了)"}
```

成功なら GitHub Actions の Run 一覧 (`/actions`) に新しい実行が追加される。

### 6. フロントエンドから動作確認

- `https://seishokai.github.io/clinic-analysis/` を開く
- 予約 → 📅 予約枠確認 → 「🔁 今すぐ再チェック」をクリック
- 「再チェック起動！」のトースト表示 → 4分後に自動で更新

---

## トラブルシューティング

### `{"ok":false,"error":"GITHUB_PAT secret not configured"}` が返る
→ Secret が未設定。手順4を確認。

### `{"ok":false,"error":"GitHub API failed: 404"}` が返る
→ PAT の権限不足、もしくはRepository access設定漏れ。
`seishokai/clinic-analysis` への Actions: Read and write を確認。

### CORS エラー (ブラウザコンソール)
→ `ALLOWED_ORIGIN` の値を確認。末尾スラッシュ無し、httpsで。

### PAT 期限切れ
→ 同手順で新PAT発行 → Cloudflare Worker secret を更新。
GitHub Actions実行は止まらない（Workerだけが影響）。

### PAT が漏れた場合
1. https://github.com/settings/personal-access-tokens で該当Tokenを **Revoke**
2. 新Token発行 → Cloudflare Worker secret を更新

---

## エンドポイント仕様

### `POST /trigger`
GitHub Actions workflow_dispatch を起動。
- リクエスト: body不要
- レスポンス: `{ok: true, message: "..."}` (起動成功) / `{ok:false, error:"..."}` (失敗)

### `GET /status`
直近1件のWorkflow実行状況を返す（フロントのポーリング用）。
- レスポンス例:
  ```json
  {
    "ok": true,
    "status": "in_progress",
    "conclusion": null,
    "updated_at": "2026-05-07T05:23:11Z",
    "html_url": "https://github.com/.../runs/12345",
    "event": "workflow_dispatch"
  }
  ```
- `status` = `queued` / `in_progress` / `completed`
- `conclusion` = `success` / `failure` / `cancelled` / null
