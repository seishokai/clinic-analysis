-- =====================================================================
-- Phase 6: 10名規模の権限システム (admin / staff_promo / agency)
-- =====================================================================
-- 目的:
--   accounts に role / allowed_promos を追加し、
--   booking_status / manual_bookings に role + promo ベースの RLS を敷く。
--   admin が UI から新規アカウント発行 / ロール変更 / 削除できる RPC を用意。
--
-- 実行タイミング:
--   app.js v230 デプロイ前に、Supabase Dashboard → SQL Editor で実行。
--   既存の tkm.koike@gmail.com (admin, id=9) はそのまま動作継続。
--
-- 既存データへの影響:
--   - accounts テーブル: カラム追加のみ (既存行は role='admin' で更新)
--   - RLS ポリシー: Phase 5 の authenticated_all を置き換え
--   - 既存の admin 1 名には一切影響なし (is_auth_admin() で全通過)
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1) accounts 拡張
-- ---------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'agency';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS allowed_promos TEXT[] DEFAULT ARRAY[]::TEXT[];

-- 既存 admin 行を role='admin' に (account_type='admin' を踏襲)
UPDATE accounts SET role = 'admin'       WHERE account_type = 'admin'       AND (role IS NULL OR role = 'agency');
UPDATE accounts SET role = 'staff_promo' WHERE account_type IN ('sales','tc','promo') AND (role IS NULL OR role = 'agency');

-- ---------------------------------------------------------------------
-- 2) ロール取得ヘルパー (RLS recursion対策 / SECURITY DEFINER)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT role FROM accounts WHERE supabase_user_id = auth.uid() LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated;

CREATE OR REPLACE FUNCTION public.current_user_allowed_promos()
RETURNS TEXT[]
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT COALESCE(allowed_promos, ARRAY[]::TEXT[])
  FROM accounts WHERE supabase_user_id = auth.uid() LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.current_user_allowed_promos() TO authenticated;

-- プロモ適合チェック (LIKE マッチ / '%' は全許可)
CREATE OR REPLACE FUNCTION public.promo_matches_user(source TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $BODY$
BEGIN
  IF public.is_auth_admin() THEN RETURN TRUE; END IF;
  IF source IS NULL THEN RETURN FALSE; END IF;
  RETURN EXISTS (
    SELECT 1 FROM unnest(public.current_user_allowed_promos()) AS p
    WHERE source LIKE p OR p = '%'
  );
END;
$BODY$;
GRANT EXECUTE ON FUNCTION public.promo_matches_user(TEXT) TO authenticated;

-- ---------------------------------------------------------------------
-- 3) booking_status の RLS を role + promo ベースに差し替え
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "booking_status_authenticated_all" ON booking_status;
DROP POLICY IF EXISTS "booking_status_select_by_role"   ON booking_status;
DROP POLICY IF EXISTS "booking_status_modify_admin"     ON booking_status;
DROP POLICY IF EXISTS "booking_status_modify_staff_promo" ON booking_status;
DROP POLICY IF EXISTS "booking_status_insert_staff_promo" ON booking_status;

CREATE POLICY "booking_status_select_by_role"
  ON booking_status FOR SELECT TO authenticated
  USING (
    public.is_auth_admin()
    OR (public.current_user_role() = 'staff_promo' AND (source IS NULL OR public.promo_matches_user(source)))
    OR (public.current_user_role() = 'agency'      AND public.promo_matches_user(source))
  );

-- admin は全権
CREATE POLICY "booking_status_modify_admin"
  ON booking_status FOR ALL TO authenticated
  USING (public.is_auth_admin())
  WITH CHECK (public.is_auth_admin());

-- staff_promo は担当プロモ範囲で UPDATE 可
CREATE POLICY "booking_status_modify_staff_promo"
  ON booking_status FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'staff_promo'
         AND (source IS NULL OR public.promo_matches_user(source)))
  WITH CHECK (public.current_user_role() = 'staff_promo'
              AND (source IS NULL OR public.promo_matches_user(source)));

-- staff_promo は INSERT 可 (自プロモのレコードのみ)
CREATE POLICY "booking_status_insert_staff_promo"
  ON booking_status FOR INSERT TO authenticated
  WITH CHECK (public.current_user_role() IN ('admin','staff_promo'));

-- 注: agency は incentive_paid のみ編集可能。これはクライアント側ガードで実現。
-- （RLS で列レベル制御は複雑化するため、当面はアプリ層に任せる）

-- ---------------------------------------------------------------------
-- 4) manual_bookings の RLS
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "manual_bookings_authenticated_all" ON manual_bookings;
DROP POLICY IF EXISTS "manual_bookings_select_by_role"    ON manual_bookings;
DROP POLICY IF EXISTS "manual_bookings_modify"            ON manual_bookings;

CREATE POLICY "manual_bookings_select_by_role"
  ON manual_bookings FOR SELECT TO authenticated
  USING (
    public.is_auth_admin()
    OR (public.current_user_role() IN ('staff_promo','agency')
        AND (source IS NULL OR public.promo_matches_user(source)))
  );

CREATE POLICY "manual_bookings_modify"
  ON manual_bookings FOR ALL TO authenticated
  USING (public.is_auth_admin() OR public.current_user_role() = 'staff_promo')
  WITH CHECK (public.is_auth_admin() OR public.current_user_role() = 'staff_promo');

-- ---------------------------------------------------------------------
-- 5) self_recordings / para_records は admin only
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "self_recordings_authenticated_all" ON self_recordings;
DROP POLICY IF EXISTS "self_recordings_admin"             ON self_recordings;
CREATE POLICY "self_recordings_admin"
  ON self_recordings FOR ALL TO authenticated
  USING (public.is_auth_admin()) WITH CHECK (public.is_auth_admin());

DROP POLICY IF EXISTS "para_records_authenticated_all" ON para_records;
DROP POLICY IF EXISTS "para_records_admin"             ON para_records;
CREATE POLICY "para_records_admin"
  ON para_records FOR ALL TO authenticated
  USING (public.is_auth_admin()) WITH CHECK (public.is_auth_admin());

-- bf_history, promo_rates, change_log は既存ポリシーのまま (読み取り authenticated 全員)

-- ---------------------------------------------------------------------
-- 6) admin 用アカウント一覧 RPC (role / allowed_promos も返す)
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_list_accounts_for_migration();
CREATE OR REPLACE FUNCTION public.admin_list_accounts_for_migration()
RETURNS TABLE (
  id BIGINT,
  name TEXT,
  account_type TEXT,
  agency TEXT,
  email TEXT,
  supabase_user_id UUID,
  migrated_at TIMESTAMPTZ,
  role TEXT,
  allowed_promos TEXT[]
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $BODY$
BEGIN
  IF NOT public.is_auth_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  RETURN QUERY
    SELECT a.id, a.name, a.account_type, a.agency, a.email,
           a.supabase_user_id, a.migrated_at, a.role, a.allowed_promos
    FROM public.accounts a ORDER BY a.id;
END;
$BODY$;
GRANT EXECUTE ON FUNCTION public.admin_list_accounts_for_migration() TO authenticated;

-- ---------------------------------------------------------------------
-- 7) 新規アカウント作成 RPC (link 型)
--   先に Supabase Dashboard → Authentication → Add user で auth user を作り、
--   その UUID を渡して accounts に紐付ける。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_account_with_role(
  p_user_uuid UUID,
  p_email TEXT,
  p_name TEXT,
  p_role TEXT,
  p_agency TEXT,
  p_allowed_promos TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $BODY$
BEGIN
  IF NOT public.is_auth_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin only');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_uuid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Authユーザーが見つかりません。Supabase Dashboardで作成してからUUIDを貼ってください');
  END IF;

  IF EXISTS (SELECT 1 FROM public.accounts WHERE supabase_user_id = p_user_uuid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'そのAuthユーザーは既にaccountsに紐付け済みです');
  END IF;

  IF p_role NOT IN ('admin','staff_promo','agency') THEN
    RETURN jsonb_build_object('ok', false, 'error', '不正なロール');
  END IF;

  INSERT INTO public.accounts
    (name, account_type, agency, email, supabase_user_id, migrated_at, role, allowed_promos)
  VALUES
    (p_name, p_role, COALESCE(p_agency, ''), p_email, p_user_uuid, NOW(), p_role,
     COALESCE(p_allowed_promos, ARRAY[]::TEXT[]));

  INSERT INTO public.auth_audit (user_id, event, detail)
  VALUES (auth.uid(), 'account_created_by_admin',
    jsonb_build_object('email', p_email, 'role', p_role, 'name', p_name));

  RETURN jsonb_build_object('ok', true);
END;
$BODY$;
GRANT EXECUTE ON FUNCTION public.admin_create_account_with_role(UUID, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO authenticated;

-- ---------------------------------------------------------------------
-- 8) アカウント更新 RPC (ロール / 担当プロモ / 代理店名)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_update_account(
  p_account_id BIGINT,
  p_role TEXT,
  p_allowed_promos TEXT[],
  p_agency TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $BODY$
BEGIN
  IF NOT public.is_auth_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin only');
  END IF;

  IF p_role NOT IN ('admin','staff_promo','agency') THEN
    RETURN jsonb_build_object('ok', false, 'error', '不正なロール');
  END IF;

  UPDATE public.accounts
  SET role = p_role,
      account_type = p_role,
      allowed_promos = COALESCE(p_allowed_promos, ARRAY[]::TEXT[]),
      agency = COALESCE(p_agency, agency)
  WHERE id = p_account_id;

  INSERT INTO public.auth_audit (user_id, event, detail)
  VALUES (auth.uid(), 'account_updated_by_admin',
    jsonb_build_object('account_id', p_account_id, 'role', p_role));

  RETURN jsonb_build_object('ok', true);
END;
$BODY$;
GRANT EXECUTE ON FUNCTION public.admin_update_account(BIGINT, TEXT, TEXT[], TEXT) TO authenticated;

-- ---------------------------------------------------------------------
-- 9) アカウント削除 RPC (admin 以外のみ)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_delete_account(p_account_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $BODY$
DECLARE
  target_role TEXT;
  target_uid UUID;
BEGIN
  IF NOT public.is_auth_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin only');
  END IF;

  SELECT role, supabase_user_id INTO target_role, target_uid
  FROM public.accounts WHERE id = p_account_id;

  IF target_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'アカウントが見つかりません');
  END IF;

  IF target_role = 'admin' THEN
    RETURN jsonb_build_object('ok', false,
      'error', 'admin は UI から削除できません。Supabase Dashboard で auth user を削除してください');
  END IF;

  DELETE FROM public.accounts WHERE id = p_account_id;

  INSERT INTO public.auth_audit (user_id, event, detail)
  VALUES (auth.uid(), 'account_deleted_by_admin',
    jsonb_build_object('target_account_id', p_account_id, 'uid', target_uid));

  RETURN jsonb_build_object('ok', true,
    'note', 'accounts は削除済。auth.users は Supabase Dashboard で別途削除してください');
END;
$BODY$;
GRANT EXECUTE ON FUNCTION public.admin_delete_account(BIGINT) TO authenticated;

COMMIT;

-- =====================================================================
-- 確認クエリ (実行後に個別に叩いて確認)
-- =====================================================================
--   SELECT id, name, account_type, role, allowed_promos FROM accounts ORDER BY id;
--   SELECT policyname FROM pg_policies WHERE tablename='booking_status';
--   SELECT policyname FROM pg_policies WHERE tablename='manual_bookings';
--   SELECT proname FROM pg_proc WHERE proname LIKE 'admin_%' OR proname LIKE 'current_user%';
