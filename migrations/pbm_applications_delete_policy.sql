-- ============================================================
-- pbm_applications_delete_policy.sql
-- pbm_applications の DELETE を admin のみに許可
--
-- 適用方法: Supabase SQL Editor で 1 回実行
--
-- 効果:
--   管理画面の PBM申請タブから admin が誤申請・テストデータ等を
--   削除できるようになる。 admin 以外の DELETE は引き続き不可。
-- ============================================================

DROP POLICY IF EXISTS pbm_applications_delete ON public.pbm_applications;
CREATE POLICY pbm_applications_delete ON public.pbm_applications
  FOR DELETE USING (is_auth_admin());

-- 動作確認 (必要なら実行):
-- SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'public.pbm_applications'::regclass;
