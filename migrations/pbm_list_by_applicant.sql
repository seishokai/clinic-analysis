-- ============================================================
-- pbm_list_by_applicant.sql
-- スタッフが pbm-apply.html から「過去の自分の申請」を一覧で見るための公開RPC
--
-- 適用方法:
--   Supabase Dashboard → SQL Editor で 1 回だけ実行
--
-- 仕組み:
--   既存の submit_pbm_application_public と同じく共通パスワード認証。
--   ログイン不要で、パスワード + 申請者名(自分が入力したもの)で
--   自分の過去申請を最大200件取得できる。
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_pbm_applications_by_applicant(
  p_password TEXT,
  p_applicant_name TEXT
)
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

  IF p_applicant_name IS NULL OR TRIM(p_applicant_name) = '' THEN
    RAISE EXCEPTION '申請者名は必須です';
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
  WHERE TRIM(a.applicant_name) ILIKE TRIM(p_applicant_name)
  ORDER BY a.applied_at DESC
  LIMIT 200;
END;
$$;

-- 公開アクセス許可 (Supabase の anon ロールから呼べるようにする)
GRANT EXECUTE ON FUNCTION public.list_pbm_applications_by_applicant(TEXT, TEXT)
  TO anon, authenticated;

-- ============================================================
-- 動作確認 (コメント、必要なら実行)
-- ============================================================
-- SELECT * FROM public.list_pbm_applications_by_applicant('Seishokai1', '小池 隆史');
