-- =====================================================================
-- Phase 4: 代理店 Auth 一括移行ツール用 RPC
-- =====================================================================
-- 目的:
--   管理画面の「Auth移行」タブから、代理店アカウント (account_type =
--   'custom'/'tc'/'sales'/'promo'/'partner') を一人ずつ Supabase Auth に
--   移行できるようにする。
--
-- 方針:
--   - 既存データは一切削除しない
--   - 旧 password カラムはそのまま (並走期間維持)
--   - admin のみ操作可能 (SECURITY DEFINER + is_auth_admin() チェック)
--   - 監査ログ (auth_audit) に記録
--
-- 実行方法:
--   Supabase Dashboard → SQL Editor にコピペして Run
-- =====================================================================

BEGIN;

-- pgcrypto 拡張 (auth.users への bcrypt パスワード設定用)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- RPC: admin_migrate_account_to_auth
--   指定した accounts.id を Supabase Auth に紐付ける。
--   auth.users + auth.identities に新規レコードを作成し、
--   accounts.supabase_user_id / email / migrated_at を埋める。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_migrate_account_to_auth(
  target_account_id BIGINT,
  new_email TEXT,
  new_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_uid UUID;
  target_account accounts;
  existing_user_id UUID;
BEGIN
  -- admin チェック
  IF NOT public.is_auth_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin 権限が必要です');
  END IF;

  -- 対象アカウント取得
  SELECT * INTO target_account FROM accounts WHERE id = target_account_id;
  IF target_account IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'アカウントが見つかりません');
  END IF;

  -- 既に移行済みならエラー
  IF target_account.supabase_user_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', '既に Auth 化済みです',
      'existing_user_id', target_account.supabase_user_id
    );
  END IF;

  -- メアド重複チェック
  SELECT id INTO existing_user_id FROM auth.users WHERE email = new_email LIMIT 1;
  IF existing_user_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'そのメアドは既に使われています');
  END IF;

  -- auth.users に直接作成 (Supabase Auth の内部テーブル)
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
    is_super_admin, is_anonymous
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    new_email,
    crypt(new_password, gen_salt('bf')),
    NOW(),
    NOW(),
    NOW(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('account_id', target_account_id, 'name', target_account.name),
    false,
    false
  ) RETURNING id INTO new_uid;

  -- auth.identities にも entry を作成 (パスワードログイン可能にする)
  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(),
    new_uid,
    jsonb_build_object('sub', new_uid::text, 'email', new_email),
    'email',
    new_uid::text,
    NOW(),
    NOW(),
    NOW()
  );

  -- accounts に紐付け
  UPDATE accounts
  SET supabase_user_id = new_uid,
      email = new_email,
      migrated_at = NOW()
  WHERE id = target_account_id;

  -- 監査ログ
  INSERT INTO auth_audit (user_id, event, detail)
  VALUES (
    auth.uid(),
    'account_migrated_by_admin',
    jsonb_build_object('target_account_id', target_account_id, 'new_uid', new_uid, 'email', new_email)
  );

  RETURN jsonb_build_object('ok', true, 'user_id', new_uid, 'email', new_email);
END $$;

GRANT EXECUTE ON FUNCTION public.admin_migrate_account_to_auth(BIGINT, TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------
-- RPC: admin_list_accounts_for_migration
--   admin 用の一覧取得 (password 列は返さない)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_accounts_for_migration()
RETURNS TABLE (
  id BIGINT,
  name TEXT,
  account_type TEXT,
  agency TEXT,
  email TEXT,
  supabase_user_id UUID,
  migrated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_auth_admin() THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  RETURN QUERY
    SELECT a.id, a.name, a.account_type, a.agency, a.email, a.supabase_user_id, a.migrated_at
    FROM accounts a
    ORDER BY a.id;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_list_accounts_for_migration() TO authenticated;

-- ---------------------------------------------------------------------
-- RPC: admin_reset_account_password
--   移行済みアカウントのパスワードを再発行する (admin 用)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_reset_account_password(
  target_account_id BIGINT,
  new_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_uid UUID;
BEGIN
  IF NOT public.is_auth_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin only');
  END IF;
  SELECT supabase_user_id INTO target_uid FROM accounts WHERE id = target_account_id;
  IF target_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Auth未移行');
  END IF;
  UPDATE auth.users
  SET encrypted_password = crypt(new_password, gen_salt('bf')),
      updated_at = NOW()
  WHERE id = target_uid;
  INSERT INTO auth_audit (user_id, event, detail)
  VALUES (
    auth.uid(),
    'password_reset_by_admin',
    jsonb_build_object('target_account_id', target_account_id)
  );
  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION public.admin_reset_account_password(BIGINT, TEXT) TO authenticated;

COMMIT;

-- 動作確認:
--   SELECT public.admin_list_accounts_for_migration();
--   -- 個別に移行:
--   SELECT public.admin_migrate_account_to_auth(123, 'partner-123@seishokai.local', 'xxxxx');
