-- Phase 10 追加修正 その2: get_my_account を ROWTYPE なしのシンプルな実装に書き換え
-- ROWTYPE 宣言が PostgREST スキーマキャッシュと不整合を起こす可能性があるため

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
        'allowed_promos', COALESCE(a.allowed_promos, '[]'::jsonb),
        'visible_tabs', a.visible_tabs,
        'permissions', COALESCE(a.permissions, '[]'::jsonb),
        'promos', COALESCE(a.promos, '[]'::jsonb),
        'services', COALESCE(a.services, '[]'::jsonb),
        'facilities', COALESCE(a.facilities, '[]'::jsonb),
        'can_view_pii', COALESCE(a.can_view_pii, FALSE)
      )
      FROM accounts a
      WHERE a.supabase_user_id = auth.uid()
      LIMIT 1
    )
  END;
$$;

-- EXECUTE 権限を再付与
GRANT EXECUTE ON FUNCTION get_my_account() TO anon, authenticated, service_role;

-- スキーマキャッシュ強制リロード
NOTIFY pgrst, 'reload schema';
