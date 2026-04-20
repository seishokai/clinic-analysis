-- =====================================================================
-- Phase 5: 最終引き締め (全代理店 Auth 移行完了後に実行)
-- =====================================================================
-- ⚠️ 注意: このファイルは「全員移行完了後」にユーザーが手動で実行する
--         テンプレートです。Phase 4 完了直後に流さないでください。
--
-- 実行前チェック:
--   SELECT COUNT(*) FROM accounts WHERE supabase_user_id IS NULL;
--   → 0 でなければ実行しない。まだ旧パスワードログインの代理店がいる。
--
-- 実行内容:
--   1. accounts の anon 一時ポリシー削除
--   2. 各テーブルの anon 許容ポリシーを authenticated only に引き締め
--   3. login_by_password RPC を削除
--   4. 旧 password 列を削除
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1) accounts の anon 一時ポリシー削除
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "accounts_insert_anon_transitional" ON accounts;
DROP POLICY IF EXISTS "accounts_update_anon_transitional" ON accounts;
DROP POLICY IF EXISTS "accounts_delete_anon_transitional" ON accounts;
DROP POLICY IF EXISTS "accounts_mod_anon_transitional"    ON accounts;

-- ---------------------------------------------------------------------
-- 2) booking_status RLS 引き締め
-- ---------------------------------------------------------------------
ALTER TABLE booking_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "booking_status_all"               ON booking_status;
DROP POLICY IF EXISTS "Allow all for anon"               ON booking_status;
DROP POLICY IF EXISTS "booking_status_anon_transitional" ON booking_status;
CREATE POLICY "booking_status_authenticated_all"
  ON booking_status FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- 3) manual_bookings RLS 引き締め
-- ---------------------------------------------------------------------
ALTER TABLE manual_bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for anon"  ON manual_bookings;
DROP POLICY IF EXISTS "manual_bookings_all" ON manual_bookings;
CREATE POLICY "manual_bookings_authenticated_all"
  ON manual_bookings FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- 4) self_recordings RLS 引き締め
-- ---------------------------------------------------------------------
ALTER TABLE self_recordings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for anon" ON self_recordings;
CREATE POLICY "self_recordings_authenticated_all"
  ON self_recordings FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- 5) para_records RLS 引き締め
-- ---------------------------------------------------------------------
ALTER TABLE para_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for anon" ON para_records;
DROP POLICY IF EXISTS "para_all"           ON para_records;
CREATE POLICY "para_records_authenticated_all"
  ON para_records FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- 6) その他 anon 一時ポリシー削除
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "promo_rates_anon_transitional"        ON promo_rates;
DROP POLICY IF EXISTS "bf_history_anon_transitional"         ON bf_history;
DROP POLICY IF EXISTS "change_log_anon_transitional"         ON change_log;
DROP POLICY IF EXISTS "recordings_anon_transitional"         ON storage.objects;
DROP POLICY IF EXISTS "recordings_anon_insert_transitional"  ON storage.objects;
DROP POLICY IF EXISTS "recordings_anon_delete_transitional"  ON storage.objects;

-- ---------------------------------------------------------------------
-- 7) 旧 password 経路を完全封鎖
--   ⚠️ 超重要: login_by_password RPC も同時に削除する
--   これで accounts.password 列がなくても関数エラーにならず、
--   app 側は Supabase Auth 経由のみで動作する。
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.login_by_password(TEXT);

-- 旧 password 列の削除 (最後)
ALTER TABLE accounts DROP COLUMN IF EXISTS password;

COMMIT;

-- 確認クエリ:
--   SELECT COUNT(*) FROM accounts WHERE supabase_user_id IS NULL;   -- 0 のはず
--   SELECT policyname, roles::text FROM pg_policies WHERE tablename='accounts';
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='accounts' AND column_name='password';       -- 0行
--   SELECT proname FROM pg_proc WHERE proname='login_by_password';  -- 0行
