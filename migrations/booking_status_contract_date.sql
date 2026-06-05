-- ============================================================
-- booking_status_contract_date.sql
-- 「成約日」列を保存するためのカラムを追加
--
-- 適用方法: Supabase SQL Editor で 1 回実行
--
-- 効果:
--   来院一覧タブの「成約商材」と「売上」の間に「成約日」入力欄が
--   表示され、入力値が DB に保存される。
-- ============================================================

ALTER TABLE public.booking_status
  ADD COLUMN IF NOT EXISTS contract_date DATE;

-- 動作確認 (必要なら実行):
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'booking_status' AND column_name = 'contract_date';
