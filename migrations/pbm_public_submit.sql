-- PBM 公開申請 RPC (共通パスワード Seishokai1 で申請可能)
-- Supabase Auth を使わず、誰でも パスワード + 申請者名手入力 で申請できる

CREATE OR REPLACE FUNCTION submit_pbm_application_public(
  p_password TEXT,
  p_applicant_name TEXT,
  p_patient_name TEXT,
  p_clinic_name TEXT,
  p_contract_date DATE DEFAULT NULL,
  p_settlement_amount NUMERIC DEFAULT NULL,
  p_payment_due_date DATE DEFAULT NULL,
  p_doctor_name TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id INTEGER;
BEGIN
  -- 共通パスワードチェック (変更したい場合は下記文字列だけ置換)
  IF p_password IS NULL OR p_password <> 'Seishokai1' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'パスワードが違います');
  END IF;

  IF p_applicant_name IS NULL OR TRIM(p_applicant_name) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', '申請者名は必須です');
  END IF;
  IF p_patient_name IS NULL OR TRIM(p_patient_name) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', '患者名は必須です');
  END IF;
  IF p_clinic_name IS NULL OR TRIM(p_clinic_name) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', '医院名は必須です');
  END IF;

  INSERT INTO pbm_applications (
    applicant_account_id, applicant_name, patient_name, clinic_name,
    contract_date, settlement_amount, payment_due_date, doctor_name, notes
  ) VALUES (
    NULL, TRIM(p_applicant_name), TRIM(p_patient_name), TRIM(p_clinic_name),
    p_contract_date, p_settlement_amount, p_payment_due_date,
    p_doctor_name, COALESCE(p_notes, '')
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

GRANT EXECUTE ON FUNCTION submit_pbm_application_public(TEXT, TEXT, TEXT, TEXT, DATE, NUMERIC, DATE, TEXT, TEXT) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
