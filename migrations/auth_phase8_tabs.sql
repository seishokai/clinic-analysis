-- =========================================================
-- Phase 8: タブ別閲覧権限 (visible_tabs)
-- =========================================================
-- accounts に visible_tabs JSONB カラムを追加し、
-- admin_create_account_with_role / admin_update_account /
-- admin_list_accounts_for_migration をそれに対応させる。
--
-- 既存データ:
--   - visible_tabs のデフォルトを埋めるだけで、ロールや allowed_promos
--     などは一切変更しない。
--   - admin は全タブ true、staff_promo は bookings+kaiin、
--     agency は bookings のみを初期値とする。
--
-- 実行順序:
--   1. Supabase Dashboard → SQL Editor で本 SQL を実行
--   2. その後 app.js v239 をデプロイ
--   3. Worker (worker/auth-admin/worker.js) を Cloudflare で再デプロイ
--      (新パラメータ p_visible_tabs 対応のため)
-- =========================================================

BEGIN;

-- 1. accounts.visible_tabs カラム追加 (NULL 許容、デフォルト agency 相当)
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS visible_tabs JSONB
  DEFAULT '{"bookings":true,"kaiin":true,"tc":false,"sales":false,"adbudget":false,"admin":false}'::jsonb;

-- 2. 既存レコードのロールに合わせてデフォルト値を埋め直す
UPDATE public.accounts
   SET visible_tabs = '{"bookings":true,"kaiin":true,"tc":true,"sales":true,"adbudget":true,"admin":true}'::jsonb
 WHERE (role = 'admin' OR account_type = 'admin')
   AND visible_tabs IS NULL;

UPDATE public.accounts
   SET visible_tabs = '{"bookings":true,"kaiin":true,"tc":false,"sales":false,"adbudget":false,"admin":false}'::jsonb
 WHERE role = 'staff_promo'
   AND visible_tabs IS NULL;

UPDATE public.accounts
   SET visible_tabs = '{"bookings":true,"kaiin":false,"tc":false,"sales":false,"adbudget":false,"admin":false}'::jsonb
 WHERE role = 'agency'
   AND visible_tabs IS NULL;

-- NULL のまま残った行 (旧 custom など) はデフォルトどおり agency 相当
UPDATE public.accounts
   SET visible_tabs = '{"bookings":true,"kaiin":false,"tc":false,"sales":false,"adbudget":false,"admin":false}'::jsonb
 WHERE visible_tabs IS NULL;

-- 3. admin_create_account_with_role を visible_tabs 対応に置換
DROP FUNCTION IF EXISTS public.admin_create_account_with_role(UUID, TEXT, TEXT, TEXT, TEXT, TEXT[]);
DROP FUNCTION IF EXISTS public.admin_create_account_with_role(UUID, TEXT, TEXT, TEXT, TEXT, TEXT[], JSONB);

CREATE OR REPLACE FUNCTION public.admin_create_account_with_role(
  p_user_uuid       UUID,
  p_email           TEXT,
  p_name            TEXT,
  p_role            TEXT,
  p_agency          TEXT,
  p_allowed_promos  TEXT[],
  p_visible_tabs    JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $BODY$
DECLARE
  default_tabs JSONB;
BEGIN
  IF NOT public.is_auth_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin only');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_uuid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Authユーザーが見つかりません');
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounts WHERE supabase_user_id = p_user_uuid) THEN
    RETURN jsonb_build_object('ok', false, 'error', '既に紐付け済み');
  END IF;
  IF p_role NOT IN ('admin','staff_promo','agency') THEN
    RETURN jsonb_build_object('ok', false, 'error', '不正なロール');
  END IF;

  -- デフォルト visible_tabs (未指定時のみロールから推定)
  IF p_visible_tabs IS NULL THEN
    IF p_role = 'admin' THEN
      default_tabs := '{"bookings":true,"kaiin":true,"tc":true,"sales":true,"adbudget":true,"admin":true}'::jsonb;
    ELSIF p_role = 'staff_promo' THEN
      default_tabs := '{"bookings":true,"kaiin":true,"tc":false,"sales":false,"adbudget":false,"admin":false}'::jsonb;
    ELSE
      default_tabs := '{"bookings":true,"kaiin":false,"tc":false,"sales":false,"adbudget":false,"admin":false}'::jsonb;
    END IF;
  ELSE
    default_tabs := p_visible_tabs;
  END IF;

  INSERT INTO public.accounts (
    name, account_type, agency, email, supabase_user_id,
    migrated_at, role, allowed_promos, visible_tabs
  )
  VALUES (
    p_name, p_role, COALESCE(p_agency, ''), p_email, p_user_uuid,
    NOW(), p_role, COALESCE(p_allowed_promos, ARRAY[]::TEXT[]), default_tabs
  );

  INSERT INTO public.auth_audit (user_id, event, detail)
  VALUES (auth.uid(), 'account_created_by_admin',
    jsonb_build_object('email', p_email, 'role', p_role, 'visible_tabs', default_tabs));

  RETURN jsonb_build_object('ok', true);
END;
$BODY$;

GRANT EXECUTE ON FUNCTION public.admin_create_account_with_role(UUID, TEXT, TEXT, TEXT, TEXT, TEXT[], JSONB) TO authenticated;

-- 4. admin_update_account を visible_tabs 対応に置換
DROP FUNCTION IF EXISTS public.admin_update_account(BIGINT, TEXT, TEXT[], TEXT);
DROP FUNCTION IF EXISTS public.admin_update_account(BIGINT, TEXT, TEXT[], TEXT, JSONB);

CREATE OR REPLACE FUNCTION public.admin_update_account(
  p_account_id      BIGINT,
  p_role            TEXT,
  p_allowed_promos  TEXT[],
  p_agency          TEXT,
  p_visible_tabs    JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $BODY$
BEGIN
  IF NOT public.is_auth_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin only');
  END IF;
  IF p_role NOT IN ('admin','staff_promo','agency') THEN
    RETURN jsonb_build_object('ok', false, 'error', '不正なロール');
  END IF;

  UPDATE public.accounts
     SET role           = p_role,
         allowed_promos = COALESCE(p_allowed_promos, ARRAY[]::TEXT[]),
         agency         = COALESCE(p_agency, agency),
         visible_tabs   = COALESCE(p_visible_tabs, visible_tabs)
   WHERE id = p_account_id;

  RETURN jsonb_build_object('ok', true);
END;
$BODY$;

GRANT EXECUTE ON FUNCTION public.admin_update_account(BIGINT, TEXT, TEXT[], TEXT, JSONB) TO authenticated;

-- 5. admin_list_accounts_for_migration に visible_tabs 列を追加
DROP FUNCTION IF EXISTS public.admin_list_accounts_for_migration();

CREATE OR REPLACE FUNCTION public.admin_list_accounts_for_migration()
RETURNS TABLE (
  id                 BIGINT,
  name               TEXT,
  account_type       TEXT,
  agency             TEXT,
  email              TEXT,
  supabase_user_id   UUID,
  migrated_at        TIMESTAMPTZ,
  role               TEXT,
  allowed_promos     TEXT[],
  visible_tabs       JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $BODY$
BEGIN
  IF NOT public.is_auth_admin() THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  RETURN QUERY
    SELECT a.id, a.name, a.account_type, a.agency, a.email,
           a.supabase_user_id, a.migrated_at,
           a.role, a.allowed_promos, a.visible_tabs
      FROM public.accounts a
     ORDER BY a.id;
END;
$BODY$;

GRANT EXECUTE ON FUNCTION public.admin_list_accounts_for_migration() TO authenticated;

-- 6. get_my_account は RETURNS accounts (行全体) なので、
--    ALTER TABLE で列追加するだけで自動的に visible_tabs を返す。
--    再定義は不要。

COMMIT;
