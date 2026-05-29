-- ============================================================
-- pbm_list_by_applicant.sql  (旧名のまま、内容は v448 で「全員分」版に変更)
-- スタッフが pbm-apply.html から PBM 申請の一覧を見るための公開RPC
--
-- 適用方法:
--   Supabase Dashboard → SQL Editor で 1 回だけ実行
--   (旧 list_pbm_applications_by_applicant を一緒に削除してから新規作成)
--
-- 仕組み:
--   共通パスワード認証。誰でも自分のと他人の申請を含む全件を確認できる
--   (運用上「自分のだけ見たい」ではなく「全員の状況を共有したい」要件)
-- ============================================================

-- 旧: applicant_name で絞る版があれば削除 (掃除)
DROP FUNCTION IF EXISTS public.list_pbm_applications_by_applicant(TEXT, TEXT);

-- 新: 全件返却 (共通パスワードのみで認証)
CREATE OR REPLACE FUNCTION public.list_pbm_applications_public(p_password TEXT)
RETURNS TABLE (
  id INTEGER,
  applied_at TIMESTAMPTZ,
  applicant_name TEXT,
  patient_name TEXT,
  clinic_name TEXT,
  doctor_name TEXT,
  contract_date DATE,
  settlement_amount NUMERIC,
  payment_due_date DATE,
  notes TEXT,
  status TEXT,
  rejection_reason TEXT,
  approved_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 共通パスワードチェック (submit と同じ)
  IF p_password IS NULL OR p_password <> 'Seishokai1' THEN
    RAISE EXCEPTION 'パスワードが違います';
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    a.applied_at,
    a.applicant_name,
    a.patient_name,
    a.clinic_name,
    a.doctor_name,
    a.contract_date,
    a.settlement_amount,
    a.payment_due_date,
    a.notes,
    a.status,
    a.rejection_reason,
    a.approved_at
  FROM public.pbm_applications a
  ORDER BY a.applied_at DESC
  LIMIT 500;
END;
$$;

-- 公開アクセス許可 (anon と authenticated の両方から呼べる)
GRANT EXECUTE ON FUNCTION public.list_pbm_applications_public(TEXT)
  TO anon, authenticated;

-- ============================================================
-- 動作確認 (コメント、必要なら実行)
-- ============================================================
-- SELECT * FROM public.list_pbm_applications_public('Seishokai1');
