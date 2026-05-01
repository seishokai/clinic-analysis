-- =========================================================
-- ポータル専用ユーザー管理テーブル
-- =========================================================
-- 主アプリ (売上・来店等) の `accounts` とは独立して、
-- トップページ (/sales/, /users/) の管理権限を別管理する。
--
-- 役割:
--   portal_admin  : /users/ で他のportalユーザーを管理できる + /sales/ 編集可
--   portal_editor : /sales/ タブの編集のみ (将来拡張用)
--
-- 主アプリ側の admin と portal_admin は別概念:
--   - 主アプリ admin は accounts テーブルで管理 (既存のまま)
--   - portal_admin は portal_users テーブル (このテーブル)
--   - 両方やる人 (例: 小池さん) は両テーブルにレコードを持つ
--
-- 実行手順:
--   1. Supabase Dashboard → SQL Editor で本SQLを実行
--   2. /users/ にアクセスして動作確認
-- =========================================================

BEGIN;

-- 1. テーブル
CREATE TABLE IF NOT EXISTS public.portal_users (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_user_id   UUID         UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email              TEXT,
  name               TEXT         NOT NULL,
  role               TEXT         NOT NULL DEFAULT 'portal_admin'
                     CHECK (role IN ('portal_admin', 'portal_editor')),
  is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by         UUID         REFERENCES auth.users(id),
  updated_by         UUID         REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_portal_users_uid    ON public.portal_users(supabase_user_id);
CREATE INDEX IF NOT EXISTS idx_portal_users_role   ON public.portal_users(role) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_portal_users_active ON public.portal_users(is_active);

-- 2. updated_at トリガー
CREATE OR REPLACE FUNCTION public.touch_portal_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_portal_users_updated_at ON public.portal_users;
CREATE TRIGGER trg_portal_users_updated_at
  BEFORE UPDATE ON public.portal_users
  FOR EACH ROW EXECUTE FUNCTION public.touch_portal_users_updated_at();

-- 3. ヘルパー関数
CREATE OR REPLACE FUNCTION public.is_portal_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM portal_users
    WHERE supabase_user_id = auth.uid()
      AND role = 'portal_admin'
      AND is_active = TRUE
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_portal_editor_or_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM portal_users
    WHERE supabase_user_id = auth.uid()
      AND role IN ('portal_admin', 'portal_editor')
      AND is_active = TRUE
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_portal_user()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT to_jsonb(pu) INTO result
  FROM portal_users pu
  WHERE pu.supabase_user_id = auth.uid()
    AND pu.is_active = TRUE
  LIMIT 1;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_portal_admin()           TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_portal_editor_or_admin() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_portal_user()        TO anon, authenticated;

-- 4. portal_admin が他の portal_users を作成・更新するための RPC
CREATE OR REPLACE FUNCTION public.portal_admin_list_users()
RETURNS SETOF portal_users
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_portal_admin() THEN
    RAISE EXCEPTION 'Forbidden: portal_admin role required';
  END IF;
  RETURN QUERY SELECT * FROM portal_users ORDER BY created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.portal_admin_create_user(
  p_user_uuid UUID,
  p_email     TEXT,
  p_name      TEXT,
  p_role      TEXT DEFAULT 'portal_admin'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  new_id UUID;
BEGIN
  IF NOT is_portal_admin() THEN
    RAISE EXCEPTION 'Forbidden: portal_admin role required';
  END IF;
  IF p_role NOT IN ('portal_admin', 'portal_editor') THEN
    RAISE EXCEPTION 'Invalid role: %', p_role;
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'Name is required';
  END IF;

  INSERT INTO portal_users (supabase_user_id, email, name, role, created_by, updated_by)
  VALUES (p_user_uuid, p_email, p_name, p_role, auth.uid(), auth.uid())
  RETURNING id INTO new_id;

  RETURN jsonb_build_object('ok', true, 'id', new_id);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'このユーザーは既に portal_users に登録されています');
  WHEN foreign_key_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', '指定されたUUIDは auth.users に存在しません');
END;
$$;

CREATE OR REPLACE FUNCTION public.portal_admin_update_user(
  p_id        UUID,
  p_name      TEXT,
  p_role      TEXT,
  p_is_active BOOLEAN
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_portal_admin() THEN
    RAISE EXCEPTION 'Forbidden: portal_admin role required';
  END IF;
  IF p_role IS NOT NULL AND p_role NOT IN ('portal_admin', 'portal_editor') THEN
    RAISE EXCEPTION 'Invalid role: %', p_role;
  END IF;

  UPDATE portal_users
     SET name       = COALESCE(p_name, name),
         role       = COALESCE(p_role, role),
         is_active  = COALESCE(p_is_active, is_active),
         updated_by = auth.uid()
   WHERE id = p_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not found');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.portal_admin_delete_user(p_id UUID)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_portal_admin() THEN
    RAISE EXCEPTION 'Forbidden: portal_admin role required';
  END IF;

  -- 自分自身は削除不可 (誤操作防止)
  IF EXISTS (SELECT 1 FROM portal_users WHERE id = p_id AND supabase_user_id = auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', '自分自身は削除できません');
  END IF;
  -- portal_admin が最後の1人なら削除不可
  IF EXISTS (SELECT 1 FROM portal_users WHERE id = p_id AND role = 'portal_admin' AND is_active) THEN
    IF (SELECT COUNT(*) FROM portal_users WHERE role = 'portal_admin' AND is_active) <= 1 THEN
      RETURN jsonb_build_object('ok', false, 'error', '最後の portal_admin は削除できません');
    END IF;
  END IF;

  DELETE FROM portal_users WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not found');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.portal_admin_list_users()        TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_admin_create_user(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_admin_update_user(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_admin_delete_user(UUID)   TO authenticated;

-- 5. RLS (RPC経由で書き込むので RLS は SELECT のみ細かく制御)
ALTER TABLE public.portal_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_users_read_self ON public.portal_users;
CREATE POLICY portal_users_read_self
  ON public.portal_users FOR SELECT
  TO authenticated
  USING (supabase_user_id = auth.uid());

DROP POLICY IF EXISTS portal_users_read_admin ON public.portal_users;
CREATE POLICY portal_users_read_admin
  ON public.portal_users FOR SELECT
  TO authenticated
  USING (is_portal_admin());

-- 書き込みは RPC 経由のみ (SECURITY DEFINER で RLS をバイパス)
-- なので INSERT/UPDATE/DELETE のポリシーは作らない (実質的にロックされる)

-- 6. /sales/ タブ管理の RLS を portal_admin/editor に変更
-- (旧: accounts の admin が編集可能 → 新: portal_admin/editor が編集可能)
DROP POLICY IF EXISTS sales_tabs_insert ON public.sales_tabs;
CREATE POLICY sales_tabs_insert
  ON public.sales_tabs FOR INSERT
  TO authenticated
  WITH CHECK (is_portal_editor_or_admin());

DROP POLICY IF EXISTS sales_tabs_update ON public.sales_tabs;
CREATE POLICY sales_tabs_update
  ON public.sales_tabs FOR UPDATE
  TO authenticated
  USING (is_portal_editor_or_admin());

DROP POLICY IF EXISTS sales_tabs_delete ON public.sales_tabs;
CREATE POLICY sales_tabs_delete
  ON public.sales_tabs FOR DELETE
  TO authenticated
  USING (is_portal_editor_or_admin());

-- 7. 初期データ: tkm.koike@gmail.com を portal_admin として登録
-- (主アプリ admin と兼任、両方の管理ができる状態にする)
INSERT INTO public.portal_users (supabase_user_id, email, name, role)
SELECT u.id, u.email, COALESCE(u.raw_user_meta_data->>'name', '管理者'), 'portal_admin'
FROM auth.users u
WHERE u.email = 'tkm.koike@gmail.com'
ON CONFLICT (supabase_user_id) DO NOTHING;

COMMIT;

-- =========================================================
-- 確認用クエリ:
--   SELECT * FROM portal_users;
--   SELECT is_portal_admin();
--   SELECT get_my_portal_user();
-- =========================================================
