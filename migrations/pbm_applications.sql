-- PBM インセンティブ申請テーブル
CREATE TABLE IF NOT EXISTS pbm_applications (
  id SERIAL PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW(),
  applicant_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  applicant_name TEXT NOT NULL,
  patient_name TEXT NOT NULL,
  clinic_name TEXT NOT NULL,
  contract_date DATE,
  settlement_amount NUMERIC,
  payment_due_date DATE,
  doctor_name TEXT,
  notes TEXT,
  clinic_reward INTEGER DEFAULT 15000,
  doctor_reward INTEGER DEFAULT 5000,
  status TEXT DEFAULT 'pending',         -- pending / approved / rejected / paid
  approved_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pbm_applications_applicant ON pbm_applications(applicant_account_id);
CREATE INDEX IF NOT EXISTS idx_pbm_applications_status ON pbm_applications(status);
CREATE INDEX IF NOT EXISTS idx_pbm_applications_applied_at ON pbm_applications(applied_at DESC);

-- RLS 有効化
ALTER TABLE pbm_applications ENABLE ROW LEVEL SECURITY;

-- 既存ポリシー削除 (べき等化)
DROP POLICY IF EXISTS pbm_applications_select ON pbm_applications;
DROP POLICY IF EXISTS pbm_applications_insert ON pbm_applications;
DROP POLICY IF EXISTS pbm_applications_update ON pbm_applications;

-- SELECT: admin は全件 / 申請者本人は自分の申請のみ
CREATE POLICY pbm_applications_select ON pbm_applications
  FOR SELECT USING (
    is_auth_admin()
    OR applicant_account_id IN (SELECT id FROM accounts WHERE supabase_user_id = auth.uid())
  );

-- INSERT: ログイン済みの全アカウント (自身のaccount_idで作成)
CREATE POLICY pbm_applications_insert ON pbm_applications
  FOR INSERT WITH CHECK (
    applicant_account_id IN (SELECT id FROM accounts WHERE supabase_user_id = auth.uid())
    OR is_auth_admin()
  );

-- UPDATE: admin のみ (ステータス変更等)
CREATE POLICY pbm_applications_update ON pbm_applications
  FOR UPDATE USING (is_auth_admin());

-- 申請RPC (申請者情報を自動付与)
DROP FUNCTION IF EXISTS submit_pbm_application(TEXT, TEXT, DATE, NUMERIC, DATE, TEXT, TEXT);
CREATE OR REPLACE FUNCTION submit_pbm_application(
  p_patient_name TEXT,
  p_clinic_name TEXT,
  p_contract_date DATE,
  p_settlement_amount NUMERIC,
  p_payment_due_date DATE,
  p_doctor_name TEXT,
  p_notes TEXT DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id INTEGER;
  v_applicant_name TEXT;
  v_application_id INTEGER;
BEGIN
  SELECT id, name INTO v_account_id, v_applicant_name
  FROM accounts WHERE supabase_user_id = auth.uid()
  LIMIT 1;

  IF v_account_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'login required');
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
    v_account_id, v_applicant_name, p_patient_name, p_clinic_name,
    p_contract_date, p_settlement_amount, p_payment_due_date, p_doctor_name, p_notes
  )
  RETURNING id INTO v_application_id;

  RETURN jsonb_build_object('ok', true, 'id', v_application_id);
END;
$$;

GRANT EXECUTE ON FUNCTION submit_pbm_application(TEXT, TEXT, DATE, NUMERIC, DATE, TEXT, TEXT) TO anon, authenticated, service_role;

-- 自分の申請一覧取得 RPC
DROP FUNCTION IF EXISTS list_my_pbm_applications();
CREATE OR REPLACE FUNCTION list_my_pbm_applications()
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id INTEGER;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE supabase_user_id = auth.uid() LIMIT 1;
  IF v_account_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT to_jsonb(p.*) FROM pbm_applications p
  WHERE is_auth_admin() OR p.applicant_account_id = v_account_id
  ORDER BY p.applied_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION list_my_pbm_applications() TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
