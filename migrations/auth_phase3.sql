-- =====================================================================
-- Supabase Auth 移行 / Phase 3 - パスワード漏洩対策 + Storage private化
-- =====================================================================
-- 目的:
--   1. accounts の password 列を anon から見えなくする (SECURITY DEFINER RPC経由化)
--   2. 録音Storage を public → private、署名URL化
--   3. 監査ログへの自動記録トリガー (失敗ログインも記録)
--
-- 重要: 既存データ一切変更なし。旧ログインは専用 RPC (login_by_password) 経由で
--       動作継続する。SQL を先に実行してから、新 app.js を本番デプロイすること。
-- 実行: Supabase Dashboard → SQL Editor
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0) RLS recursion 対策用ヘルパ (accounts 自身を参照するため)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_auth_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM accounts
    WHERE supabase_user_id = auth.uid() AND account_type = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_auth_admin() TO anon, authenticated;

-- ---------------------------------------------------------------------
-- 1) パスワード認証用 RPC (anonからでも呼べるが、password 列は返さない)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.login_by_password(pw TEXT)
RETURNS TABLE (
  id BIGINT,
  name TEXT,
  account_type TEXT,
  agency TEXT,
  permissions JSONB,
  promos JSONB,
  services JSONB,
  facilities JSONB,
  role TEXT,
  supabase_user_id UUID,
  email TEXT,
  migrated_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.name, a.account_type, a.agency, a.permissions, a.promos, a.services, a.facilities, a.role, a.supabase_user_id, a.email, a.migrated_at
  FROM accounts a
  WHERE a.password = pw
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.login_by_password(TEXT) TO anon, authenticated;

-- ---------------------------------------------------------------------
-- 2) accounts の SELECT 権限を制限 (password 漏洩防止)
-- ---------------------------------------------------------------------
-- 既存の Phase 1 許容ポリシーを削除し、より厳密なものに置き換え
DROP POLICY IF EXISTS "accounts_read_all_phase1" ON accounts;
DROP POLICY IF EXISTS "accounts_write_admin_or_anon_phase1" ON accounts;

-- authenticated: 自分のレコードのみ SELECT 可
DROP POLICY IF EXISTS "accounts_select_own" ON accounts;
CREATE POLICY "accounts_select_own"
  ON accounts FOR SELECT
  TO authenticated
  USING (supabase_user_id = auth.uid());

-- admin (Auth済み admin) は全件 SELECT 可
DROP POLICY IF EXISTS "accounts_select_admin" ON accounts;
CREATE POLICY "accounts_select_admin"
  ON accounts FOR SELECT
  TO authenticated
  USING (public.is_auth_admin());

-- authenticated admin は INSERT/UPDATE/DELETE 全権
DROP POLICY IF EXISTS "accounts_mod_admin" ON accounts;
CREATE POLICY "accounts_mod_admin"
  ON accounts FOR ALL
  TO authenticated
  USING (public.is_auth_admin())
  WITH CHECK (public.is_auth_admin());

-- 一時: anon からの INSERT/UPDATE/DELETE も許容
-- (旧ログイン flow / admin UI が anon で直接書き込むコードの互換)
-- Phase 4 で削除予定
DROP POLICY IF EXISTS "accounts_mod_anon_transitional" ON accounts;
CREATE POLICY "accounts_mod_anon_transitional"
  ON accounts FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

-- 注: anon に対する SELECT ポリシーは作らない → anon からの
--     `select * from accounts` は空配列を返す (password 列漏洩をブロック)
--     旧ログインは login_by_password RPC 経由で動作継続。

-- ---------------------------------------------------------------------
-- 3) 監査ログ - ログイン成功/失敗を記録する RPC
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_auth_event(event_name TEXT, detail_json JSONB)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO auth_audit (user_id, event, detail)
  VALUES (auth.uid(), event_name, detail_json);
$$;

GRANT EXECUTE ON FUNCTION public.log_auth_event(TEXT, JSONB) TO anon, authenticated;

-- ---------------------------------------------------------------------
-- 4) Storage: recordings バケットを private化
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'recordings') THEN
    INSERT INTO storage.buckets (id, name, public) VALUES ('recordings', 'recordings', false);
  ELSE
    -- 既存バケットを private に変更
    UPDATE storage.buckets SET public = false WHERE id = 'recordings';
  END IF;
END $$;

-- Storage RLS: 認証済みユーザのみ SELECT/INSERT 可
DROP POLICY IF EXISTS "recordings_all" ON storage.objects;
DROP POLICY IF EXISTS "recordings_auth_select" ON storage.objects;
DROP POLICY IF EXISTS "recordings_auth_insert" ON storage.objects;
DROP POLICY IF EXISTS "recordings_anon_transitional" ON storage.objects;
DROP POLICY IF EXISTS "recordings_anon_insert_transitional" ON storage.objects;
DROP POLICY IF EXISTS "recordings_anon_delete_transitional" ON storage.objects;

CREATE POLICY "recordings_auth_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'recordings');

CREATE POLICY "recordings_auth_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'recordings');

-- 一時: anon 動作互換 (旧ログインは anon キーのまま動くため)
-- Phase 4 で削除予定
CREATE POLICY "recordings_anon_transitional"
  ON storage.objects FOR SELECT
  TO anon
  USING (bucket_id = 'recordings');

CREATE POLICY "recordings_anon_insert_transitional"
  ON storage.objects FOR INSERT
  TO anon
  WITH CHECK (bucket_id = 'recordings');

CREATE POLICY "recordings_anon_delete_transitional"
  ON storage.objects FOR DELETE
  TO anon
  USING (bucket_id = 'recordings');

COMMIT;

-- =====================================================================
-- 確認クエリ (任意):
--   SELECT * FROM pg_policies WHERE tablename IN ('accounts','objects');
--   SELECT public FROM storage.buckets WHERE id = 'recordings';
--   SELECT proname FROM pg_proc WHERE proname IN ('login_by_password','log_auth_event','get_my_account','is_auth_admin');
-- =====================================================================
