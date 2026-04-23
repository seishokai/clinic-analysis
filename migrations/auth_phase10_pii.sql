-- Phase 10: 個人情報(名前・電話・メール)閲覧可フラグを追加
-- admin 以外のロール(staff_promo/agency)でも特定アカウントのみ
-- 顧客の個人情報を平文で閲覧できるようにする。電話追跡チーム用。

-- 1. accounts テーブルに can_view_pii フラグを追加
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS can_view_pii BOOLEAN DEFAULT FALSE;

-- 2. get_my_account RPC を更新して can_view_pii も返す
CREATE OR REPLACE FUNCTION get_my_account()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row accounts%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_row FROM accounts WHERE supabase_user_id = v_uid LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'id', v_row.id,
    'name', v_row.name,
    'role', v_row.role,
    'account_type', v_row.account_type,
    'agency', v_row.agency,
    'email', v_row.email,
    'allowed_promos', COALESCE(v_row.allowed_promos, '[]'::jsonb),
    'visible_tabs', v_row.visible_tabs,
    'permissions', COALESCE(v_row.permissions, '[]'::jsonb),
    'promos', COALESCE(v_row.promos, '[]'::jsonb),
    'services', COALESCE(v_row.services, '[]'::jsonb),
    'facilities', COALESCE(v_row.facilities, '[]'::jsonb),
    'can_view_pii', COALESCE(v_row.can_view_pii, FALSE)
  );
END;
$$;

-- 3. admin_list_accounts_for_mig RPC も更新 (管理画面用)
CREATE OR REPLACE FUNCTION admin_list_accounts_for_mig()
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_auth_admin() THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  RETURN QUERY
  SELECT jsonb_build_object(
    'id', a.id,
    'name', a.name,
    'role', a.role,
    'account_type', a.account_type,
    'agency', a.agency,
    'email', a.email,
    'supabase_user_id', a.supabase_user_id,
    'allowed_promos', COALESCE(a.allowed_promos, '[]'::jsonb),
    'visible_tabs', a.visible_tabs,
    'can_view_pii', COALESCE(a.can_view_pii, FALSE),
    'migrated_at', a.migrated_at
  )
  FROM accounts a
  ORDER BY
    CASE a.role WHEN 'admin' THEN 1 WHEN 'staff_promo' THEN 2 WHEN 'agency' THEN 3 ELSE 4 END,
    a.id;
END;
$$;

-- 4. admin_update_account_role に can_view_pii パラメータ追加
CREATE OR REPLACE FUNCTION admin_update_account_role(
  p_account_id INTEGER,
  p_role TEXT,
  p_agency TEXT DEFAULT NULL,
  p_allowed_promos JSONB DEFAULT NULL,
  p_visible_tabs JSONB DEFAULT NULL,
  p_can_view_pii BOOLEAN DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_auth_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin only');
  END IF;
  UPDATE accounts SET
    role = COALESCE(p_role, role),
    agency = COALESCE(p_agency, agency),
    allowed_promos = COALESCE(p_allowed_promos, allowed_promos),
    visible_tabs = COALESCE(p_visible_tabs, visible_tabs),
    can_view_pii = COALESCE(p_can_view_pii, can_view_pii)
  WHERE id = p_account_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 5. admin_create_account_with_role に can_view_pii 追加 (新規発行用)
CREATE OR REPLACE FUNCTION admin_create_account_with_role(
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
AS $$
DECLARE
  v_account_id INTEGER;
  v_acct_type TEXT;
BEGIN
  IF NOT is_auth_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin only');
  END IF;
  v_acct_type := CASE p_role WHEN 'admin' THEN 'admin' WHEN 'staff_promo' THEN 'promo' WHEN 'agency' THEN 'agency' ELSE 'custom' END;
  INSERT INTO accounts (
    name, role, account_type, agency, email, supabase_user_id,
    allowed_promos, visible_tabs, can_view_pii, migrated_at
  ) VALUES (
    p_name, p_role, v_acct_type, p_agency, p_email, p_user_uuid,
    p_allowed_promos, p_visible_tabs, p_can_view_pii, NOW()
  ) RETURNING id INTO v_account_id;
  RETURN jsonb_build_object('ok', true, 'account_id', v_account_id);
END;
$$;

-- 6. 丸田 アカウントに can_view_pii = TRUE を設定
UPDATE accounts SET can_view_pii = TRUE WHERE name LIKE '%丸田%';

-- 7. スキーマキャッシュをリロード
NOTIFY pgrst, 'reload schema';
