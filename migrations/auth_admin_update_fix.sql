-- ============================================================
-- admin_update_account: 型変換バグ修正
--
-- 問題: COALESCE types jsonb and text[] cannot be matched
--   - 関数の p_allowed_promos が JSONB
--   - テーブルの accounts.allowed_promos が TEXT[]
--   - 直接 COALESCE すると型不一致でエラー
--
-- 修正: jsonb 配列を text[] に明示変換してから割当
-- ============================================================

DROP FUNCTION IF EXISTS admin_update_account(INTEGER, TEXT, TEXT, JSONB, JSONB, BOOLEAN);

CREATE FUNCTION admin_update_account(
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
    role         = COALESCE(p_role, role),
    agency       = COALESCE(p_agency, agency),
    -- jsonb 配列 → text[] 変換を明示
    allowed_promos = CASE
      WHEN p_allowed_promos IS NULL THEN allowed_promos
      WHEN jsonb_typeof(p_allowed_promos) = 'array' THEN
        ARRAY(SELECT jsonb_array_elements_text(p_allowed_promos))
      ELSE allowed_promos
    END,
    visible_tabs = COALESCE(p_visible_tabs, visible_tabs),
    can_view_pii = COALESCE(p_can_view_pii, can_view_pii)
  WHERE id = p_account_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_account(INTEGER, TEXT, TEXT, JSONB, JSONB, BOOLEAN)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

SELECT 'admin_update_account 修正完了' AS status;
