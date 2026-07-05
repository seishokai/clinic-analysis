-- =========================================================
-- auth_phase10_pii_fix5_drop_old.sql
-- =========================================================
-- 背景:
--   auth_phase8_tabs.sql で作成された旧シグネチャの
--   admin_create_account_with_role(UUID,TEXT,TEXT,TEXT,TEXT,TEXT[],JSONB)
--   が phase10 の PII 対応版と共存してしまい、PostgREST が
--   関数オーバーロードを解決できず PGRST203 エラーを返していた:
--     "Could not choose the best candidate function between:
--      public.admin_create_account_with_role(... text[] ...),
--      public.admin_create_account_with_role(... jsonb ...)"
--
-- 症状:
--   Aladdin 管理画面から新規アカウント発行を試みると
--   Cloudflare Worker (auth-admin) が "link failed" (500) を返す。
--   Auth user は作成→即座にロールバック削除される。
--
-- 修正:
--   旧関数 (text[] 版) を DROP して新関数 (jsonb + can_view_pii 版) のみ残す。
--   Worker が渡す p_allowed_promos は JSON 配列なので JSONB として受理される。
--
-- 実行順序:
--   1. Supabase Dashboard → SQL Editor で本 SQL を実行
--   2. 動作確認: 管理画面から任意のテストアカウントを発行して成功することを確認
-- =========================================================

BEGIN;

DROP FUNCTION IF EXISTS public.admin_create_account_with_role(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT[], JSONB
);

COMMIT;

NOTIFY pgrst, 'reload schema';
