-- ============================================================
-- booking_status_expected_amount.sql
-- 「売り上げ見込み」列を保存するためのカラムを追加
--
-- 適用方法: Supabase SQL Editor で 1 回実行
--
-- 効果:
--   来院管理 → インプラントタブの「売上」横に「売り上げ見込み」入力欄が
--   表示され、入力値が DB に保存される。
--   インプラントの治療段階(CT/診断〜セット)で、まだ成約していないが
--   見込み金額として把握したいケースに使用。
-- ============================================================

ALTER TABLE public.booking_status
  ADD COLUMN IF NOT EXISTS expected_amount NUMERIC;

-- 動作確認 (必要なら実行):
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'booking_status' AND column_name = 'expected_amount';
