-- Phase 9 hotfix: is_auth_admin を role='admin' でも true を返すよう拡張 + debug_auth_state 追加
-- ============================================================
-- 目的:
--  1. Worker の verifyAdmin が「admin only」で落ちる問題を根本解消する
--     (supabase_user_id がリンク済みで account_type / role のどちらかが 'admin' なら true)
--  2. debug_auth_state() で現在の JWT から見える auth state を返せるようにし、
--     以降の不具合調査を楽にする
-- 既存テーブル構造は変更しない (関数 2 本のみ追加/置換)。
-- ============================================================

BEGIN;

-- 既存 is_auth_admin を拡張: account_type='admin' OR role='admin' のどちらでもOK
CREATE OR REPLACE FUNCTION public.is_auth_admin() RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM accounts
    WHERE supabase_user_id = auth.uid()
      AND (account_type = 'admin' OR role = 'admin')
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_auth_admin() TO authenticated, anon;

-- デバッグ用 RPC: JWT から見える自分の auth state を返す
-- 失敗時の原因切り分けに使う (Worker が admin only を返した時に UI から呼び出す)
CREATE OR REPLACE FUNCTION public.debug_auth_state()
RETURNS JSONB
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'auth_uid',         auth.uid(),
    'is_admin',         public.is_auth_admin(),
    'accounts_matched', (SELECT COUNT(*) FROM accounts WHERE supabase_user_id = auth.uid()),
    'my_account',       (
      SELECT jsonb_build_object(
        'id',           id,
        'name',         name,
        'account_type', account_type,
        'role',         role,
        'supabase_user_id', supabase_user_id
      )
      FROM accounts
      WHERE supabase_user_id = auth.uid()
      LIMIT 1
    )
  );
$$;
GRANT EXECUTE ON FUNCTION public.debug_auth_state() TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
