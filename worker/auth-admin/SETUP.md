# seishokai-auth-admin Cloudflare Worker デプロイ手順

このフォルダには、**代理店／社員アカウントを1クリックで発行する**ための
Cloudflare Worker (`seishokai-auth-admin`) のソースと設定が入っています。

既存の `seishokai-ai-proxy` Worker とは **完全に別の新規 Worker** として動作し、
相互に影響しません。

---

## なぜ Worker が必要か

- Supabase の `service_role` キーは **全権限** を持つため、フロントエンドには絶対出せません。
- Worker の環境変数 (Encrypted Secret) にだけ保存し、
  フロントからは `admin` ログイン済みの JWT を付けて Worker を呼びます。
- Worker 内で `is_auth_admin()` RPC を呼び、本当に admin か検証してから
  `service_role` でSupabase Auth Admin API を叩きます。

---

## デプロイ手順 (ブラウザ / Dashboard で完結)

### 1. Cloudflare Dashboard にログイン
https://dash.cloudflare.com/

### 2. 新規 Worker 作成
- 左メニューから **Workers & Pages**
- **Create application** → **Create Worker**
- 名前を入力: `seishokai-auth-admin`
- **Deploy** (この時点ではテンプレのまま)

### 3. worker.js の内容を貼り付け
- 作成した Worker の画面で **Edit code** (右上) をクリック
- 左ペインの `worker.js` を全選択 → 削除
- 同じフォルダにある **`worker.js` の中身を全部コピペ**
- 右上 **Save and deploy**

### 4. 環境変数 (Secrets) を設定
Worker 画面 → **Settings** → **Variables and Secrets** → **Add**

以下 4つを追加します。**必ず `Encrypt` にチェック** を入れてください。

| 変数名 | 値 | 備考 |
|:-------|:---|:-----|
| `SUPABASE_URL` | `https://ndlfqrvoejwgqfdtghmg.supabase.co` | プロジェクト URL |
| `SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API の **`anon` public** | フロントにも露出してよいキー |
| `SUPABASE_SERVICE_ROLE_KEY` | 同上の **`service_role` secret** | ⚠️ 絶対に秘匿。漏れたら即ローテート |
| `ALLOWED_ORIGIN` | `https://seishokai.github.io` | CORS 制限。GitHub Pages 以外から呼ばせない |

入力後、各行の右の **Save** を押せば即反映 (再デプロイ不要)。

### 5. 疎通テスト
ターミナル / コマンドプロンプトで次を実行:

```
curl -X POST https://seishokai-auth-admin.tkm-koike.workers.dev/auth-admin/create -H "Content-Type: application/json"
```

期待レスポンス:
```json
{"ok":false,"error":"auth header missing"}
```

これが返れば **疎通 OK**。Worker は稼働しており、認証も要求しています。

### 6. アプリ側で確認
- GitHub Pages の最新 `index.html?v=238` を開く
- admin でログイン
- **管理 → 権限管理** → 「新規アカウント発行」フォーム
- 名前・ロールなどを入力し「発行する」をクリック
- アラートに `メール / パスワード` が表示されれば成功

---

## トラブルシューティング

### 「Worker未デプロイのようです」と出る
- 上記手順がまだ完了していない状態です
- フロントは自動的に **旧UI (手動UUID入力式)** にフォールバックするので
  業務は止まりません

### 「admin only」エラー
- 現在のセッションが admin 権限ではありません
- もしくは `is_auth_admin()` RPC が未定義 → `auth_phase3.sql` 実行済みか確認

### 「Auth user creation failed」
- メアドが既に登録済み (Supabase Dashboard → Authentication → Users で確認)
- またはパスワードが Supabase の要件 (6文字以上など) を満たしていない

### service_role キーが漏れた場合
1. Supabase Dashboard → Project Settings → API → **Reset service_role key**
2. Worker の `SUPABASE_SERVICE_ROLE_KEY` を新キーに更新 → Save

---

## エンドポイント仕様

### `POST /auth-admin/create`
リクエスト:
```json
{
  "email": "partner@example.com",
  "password": "自動生成されたパスワード",
  "name": "山田太郎",
  "role": "agency",
  "agency": "ヒカル",
  "allowed_promos": ["hikaru_%"]
}
```
レスポンス (成功):
```json
{ "ok": true, "user_id": "uuid...", "email": "...", "password": "..." }
```

### `POST /auth-admin/reset-password`
```json
{ "user_id": "uuid...", "new_password": "新PW" }
```

### `POST /auth-admin/delete`
```json
{ "user_id": "uuid...", "account_id": 12 }
```
※ `account_id` は任意。指定すると `admin_delete_account` RPC も呼び出します。
