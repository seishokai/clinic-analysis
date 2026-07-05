-- =========================================================
-- auth_phase10_pii_fix6_cast_promos.sql
-- =========================================================
-- 背景:
--   phase10_pii.sql の admin_create_account_with_role は
--   p_allowed_promos を JSONB で受け取り、そのまま
--   accounts.allowed_promos (TEXT[]) に INSERT していた。
--   そのため型不一致で 42804 エラー:
--     "column \"allowed_promos\" is of type text[]
--      but expression is of type jsonb"
--
-- 症状:
--   Aladdin 管理画面からアカウント発行 → "link failed" (500)
--   ↑ Worker からは fallback メッセージだが、実体は Postgres 42804
--
-- 修正:
--   関数内で JSONB → TEXT[] にキャストしてから INSERT する。
--   ARRAY(SELECT jsonb_array_elements_text(...)) を使う。
--
-- 実行順序:
--   1. Supabase Dashboard → SQL Editor で本 SQL を実行
--   2. 管理画面から発行して成功することを確認
-- =========================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_create_account_with_role(
  p_user_uuid UUID,
  p_email TEXT,
  p_name TEXT,
  p_role TEXT,
  p_agency TEXT DEFAULT '',
  p_allowed_promos JSONB DEFAULT '[]'::jsonb,
  p_visible_tabs JSONB DEFAULT NULL,
  p_can_view_pii BOOLEAN DEFAULT FALSE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $BODY$
DECLARE
  v_account_id INTEGER;
  v_acct_type TEXT;
  v_promos TEXT[];
BEGIN
  IF NOT is_auth_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin only');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_uuid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Authユーザーが見つかりません');
  END IF;

  IF EXISTS (SELECT 1 FROM accounts WHERE supabase_user_id = p_user_uuid) THEN
    RETURN jsonb_build_object('ok', false, 'error', '既に紐付け済み');
  END IF;

  IF p_role NOT IN ('admin','staff_promo','agency') THEN
    RETURN jsonb_build_object('ok', false, 'error', '不正なロール');
  END IF;

  v_acct_type := CASE p_role
    WHEN 'admin' THEN 'admin'
    WHEN 'staff_promo' THEN 'promo'
    WHEN 'agency' THEN 'agency'
    ELSE 'custom'
  END;

  -- JSONB配列 → TEXT[] 変換 (accounts.allowed_promos が TEXT[] のため)
  v_promos := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_allowed_promos, '[]'::jsonb)));

  INSERT INTO accounts (
    name, role, account_type, agency, email, supabase_user_id,
    allowed_promos, visible_tabs, can_view_pii, migrated_at
  ) VALUES (
    p_name, p_role, v_acct_type, COALESCE(p_agency, ''), p_email, p_user_uuid,
    v_promos, p_visible_tabs, COALESCE(p_can_view_pii, FALSE), NOW()
  ) RETURNING id INTO v_account_id;

  RETURN jsonb_build_object('ok', true, 'account_id', v_account_id);
END;
$BODY$;

GRANT EXECUTE ON FUNCTION public.admin_create_account_with_role(
  UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BOOLEAN
) TO anon, authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
