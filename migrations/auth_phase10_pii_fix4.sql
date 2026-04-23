-- Phase 10 追加修正 その4: text[] と jsonb の両対応
-- カラムによって型が違う (一部 jsonb、一部 text[]) ため、
-- COALESCE(to_jsonb(col), '[]'::jsonb) で両方に対応する

DROP FUNCTION IF EXISTS get_my_account();

CREATE OR REPLACE FUNCTION get_my_account()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN NULL
    ELSE (
      SELECT jsonb_build_object(
        'id', a.id,
        'name', a.name,
        'role', a.role,
        'account_type', a.account_type,
        'agency', a.agency,
        'email', a.email,
        'allowed_promos', COALESCE(to_jsonb(a.allowed_promos), '[]'::jsonb),
        'visible_tabs', a.visible_tabs,
        'permissions', COALESCE(to_jsonb(a.permissions), '[]'::jsonb),
        'promos', COALESCE(to_jsonb(a.promos), '[]'::jsonb),
        'services', COALESCE(to_jsonb(a.services), '[]'::jsonb),
        'facilities', COALESCE(to_jsonb(a.facilities), '[]'::jsonb),
        'can_view_pii', COALESCE(a.can_view_pii, FALSE)
      )
      FROM accounts a
      WHERE a.supabase_user_id = auth.uid()
      LIMIT 1
    )
  END;
$$;

-- admin_list_accounts_for_mig も同様に修正
DROP FUNCTION IF EXISTS admin_list_accounts_for_mig();

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
    'allowed_promos', COALESCE(to_jsonb(a.allowed_promos), '[]'::jsonb),
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

-- EXECUTE 権限を再付与
GRANT EXECUTE ON FUNCTION get_my_account() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin_list_accounts_for_mig() TO anon, authenticated, service_role;

-- スキーマキャッシュリロード
NOTIFY pgrst, 'reload schema';
