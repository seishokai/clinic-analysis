# Supabase Auth 移行 / マイグレーション手順書

このフォルダには、既存 `accounts` テーブル (平文 password 認証) から
**Supabase Auth** への段階的な移行用 SQL が入っている。

基本方針:

- **既存データは一切削除・変更しない**
- **旧ログイン (accounts.password) は並走期間中そのまま動く**
- **ダウンタイムゼロ** で新 Auth を追加
- 実行はユーザが Supabase Dashboard → SQL Editor で手動で行う

---

## Phase 一覧

| Phase | ファイル            | 目的                                               | いつ実行                 |
|:-----:|:--------------------|:---------------------------------------------------|:-------------------------|
|   1   | `auth_phase1.sql`   | accounts 拡張 + RLS(許容) + RPC + 監査ログ          | **今すぐ** (データ安全)   |
|   2   | `auth_phase2.sql`   | 初期 admin ユーザ作成と既存レコードのリンク         | Phase 1 と同時 / 直後可  |
|   3   | `auth_phase3.sql`   | password 漏洩対策 + Storage private化 + 監査ログ    | **SQLを先に実行** → app v227 |
|   4   | `auth_phase4.sql`   | 代理店 Auth 一括移行ツール用 RPC                     | app v228 と同時           |
|   5   | `auth_phase5_finalize.sql` | 旧 password 列削除 + anon 経路完全閉鎖        | **全員移行後**にユーザ手動実行 |

---

## Phase 1: 基盤構築 (`auth_phase1.sql`)

### 実行内容
1. `accounts` に `supabase_user_id`, `email`, `migrated_at` カラム追加 (NULL 許容)
2. `accounts` の RLS を有効化 (ただし Phase 1 は全許可ポリシーで既存動作を維持)
3. `public.get_my_account()` RPC を作成 (認証済みユーザが自分の accounts 行を取得)
4. `auth_audit` テーブル (新規) を作成

### 実行方法
1. Supabase Dashboard → **SQL Editor**
2. `auth_phase1.sql` の中身をコピペ
3. **Run** を押す
4. エラーがなければ完了。既存データは無変更。

### 影響
- 既存の `attemptLogin()` (accounts.password チェック) は **そのまま動く**
- Supabase Auth は未設定なので「メールでログイン」は失敗する (Phase 2 で設定)

---

## Phase 2: 初期 admin ユーザのリンク (`auth_phase2.sql`)

### 手順
1. Supabase Dashboard → **Authentication** → **Users** → **Add user**
   - Email: 管理者のメール (例 `admin@example.com`)
   - Password: 強固な新パスワード
   - **Auto Confirm User: ON**
2. 作成されたユーザの UUID をコピー
3. `auth_phase2.sql` を開き、セクション A の UPDATE 文のコメントを外し、
   `<USER_UUID>` と `<EMAIL>` を実際の値に書き換える
4. **SQL Editor** で実行
5. ブラウザで `index.html` を開き、ログインセクションの
   「メールでログイン (Supabase Auth)」 リンクから新認証を試す
6. 成功すれば admin の移行完了

### 並走期間
- 同じ admin ユーザは、**旧パスワードでも / メール Auth でも** ログイン可能
- 他ユーザ (sales, tc, promo, custom) は旧パスワードのまま
- 監視期間を経て、順次 Phase 3 で全員移行

---

## Phase 3: パスワード漏洩対策 + Storage private化 (`auth_phase3.sql`)

### 実行内容
1. `public.login_by_password(pw)` RPC 作成 (SECURITY DEFINER、password 列を返さない)
2. `public.is_auth_admin()` ヘルパ関数 (RLS recursion 対策)
3. `public.log_auth_event(event, detail)` RPC (監査ログ追記)
4. `accounts` の RLS を引き締め:
   - anon は SELECT 不可 (→ 直接クエリで password を抜けない)
   - authenticated は自分のレコードのみ SELECT
   - Auth 済み admin は全件 SELECT/書き込み可
   - INSERT/UPDATE/DELETE は anon も一時許容 (Phase 4 で閉じる)
5. Storage `recordings` バケットを `public = false` に変更、RLS を設定
   (authenticated/anon とも SELECT/INSERT 可能 → signed URL 経由で再生)

### 実行順序 (重要)
1. **必ず SQL を先に実行する** (Supabase Dashboard → SQL Editor)
2. その後で app.js v227 を本番デプロイ
   - app.js v227 は `sb.rpc('login_by_password')` に変更済みのため、
     SQL を実行していない環境では **旧ログインが全滅する**
3. 実行後、ブラウザで:
   - 旧パスワードログインが通ること
   - 新 Supabase Auth ログインも通ること
   - 直接 `sb.from('accounts').select('*')` で password が返らないこと

### 既知の注意
- 代理店 UI (パートナーログイン) も同じ `login_by_password` RPC 経由に変更済み
- 録音再生は `getSignedRecordingUrl()` で署名URL (1時間有効) に変換
  - 失敗時は旧 public URL fallback (互換維持)
- `accounts_mod_anon_transitional` ポリシーは **Phase 4 で必ず削除する**

---

## Phase 4: 代理店 Auth 一括移行ツール (`auth_phase4.sql`)

### 実行内容
1. `pgcrypto` 拡張を有効化 (パスワード bcrypt ハッシュ生成用)
2. `public.admin_migrate_account_to_auth(id, email, password)` RPC 作成
   - admin のみ実行可能 (SECURITY DEFINER + `is_auth_admin()` チェック)
   - `auth.users` + `auth.identities` に新規レコードを作成
   - `accounts.supabase_user_id` / `email` / `migrated_at` を埋める
3. `public.admin_list_accounts_for_migration()` RPC 作成
   - admin 用一覧取得 (password 列は返さない)
4. `public.admin_reset_account_password(id, password)` RPC 作成
   - 移行済みアカウントのパスワード再発行

### 実行方法
1. Supabase Dashboard → **SQL Editor** で `auth_phase4.sql` を実行
2. ブラウザで app v228 の `管理タブ → Auth移行` に移動
3. 一覧から代理店を一人ずつ「Auth化」ボタンで移行
   - メアド (デフォルト `partner-{id}@seishokai.local`) とパスワード (自動生成)
   - アラートに表示される認証情報をコピーし、代理店に通知
4. 並走期間中は旧パスワードログインも動作継続

### 影響
- 既存の `attemptLogin()` / `initPartnerLogin()` はそのまま動く
- 移行済みの代理店は新メアド+パスワードでログイン可能
- 未移行の代理店は引き続き旧パスワードでログイン

---

## Phase 5: 最終引き締め (`auth_phase5_finalize.sql`)

⚠️ **全員移行完了後** にユーザが手動で実行するテンプレート。

### 実行前チェック (必須)
```sql
SELECT COUNT(*) FROM accounts WHERE supabase_user_id IS NULL;
-- 0 でなければ実行しない
```

### 実行内容
1. `accounts` の anon 一時ポリシー削除
2. `booking_status` / `manual_bookings` / `self_recordings` / `para_records` を authenticated only に
3. 他 transitional ポリシー (`promo_rates` / `bf_history` / `change_log` / storage.objects) を削除
4. `login_by_password` RPC を DROP
5. `accounts.password` 列を DROP

### 実行後の確認
```sql
SELECT COUNT(*) FROM accounts WHERE supabase_user_id IS NULL;                 -- 0
SELECT column_name FROM information_schema.columns
  WHERE table_name='accounts' AND column_name='password';                     -- 0行
SELECT proname FROM pg_proc WHERE proname='login_by_password';                -- 0行
```

### 失敗時
ロールバック可能 (BEGIN/COMMIT 内)。途中で COMMIT 前にエラーが出れば自動 ROLLBACK。

---

## ロールバック

Phase 1 の SQL は加算のみ (ALTER ADD, CREATE)。どうしても巻き戻したい場合:

```sql
-- 追加カラムを削除 (既存データは無関係)
ALTER TABLE accounts DROP COLUMN IF EXISTS supabase_user_id;
ALTER TABLE accounts DROP COLUMN IF EXISTS email;
ALTER TABLE accounts DROP COLUMN IF EXISTS migrated_at;

-- RPC 削除
DROP FUNCTION IF EXISTS public.get_my_account();

-- 監査テーブル削除
DROP TABLE IF EXISTS auth_audit;

-- RLS 無効化 (元の anon 全許可状態に戻す)
ALTER TABLE accounts DISABLE ROW LEVEL SECURITY;
```
