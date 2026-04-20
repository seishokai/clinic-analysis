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
|   4   | 未作成               | 全ユーザ移行完了後の anon 経路の完全閉鎖             | 別計画 (後日)            |

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

## Phase 4 (予定): anon 経路の完全閉鎖

- 全ユーザを Supabase Auth に移行完了後
- `accounts.password` 列を廃止
- anon 系 transitional ポリシーを全削除
- `login_by_password` / `recordings_anon_*` を DROP
- 旧 `attemptLogin()` / `initPartnerLogin()` を app から削除

別計画として、動作が安定してから実施する。

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
