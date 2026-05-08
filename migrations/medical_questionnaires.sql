-- =============================================================
-- medical_questionnaires: 事前 Web 問診票
--
-- 仕組み:
--   1. shareconnect 予約完了メールに問診票 URL が入る
--      → ?name={name}&clinic={clinicName}&date={date}&time={time}&email={email}&phone={phone}
--   2. ランディングページ (/monshin/index.html) が
--      lookup_questionnaire_treatment(name, book_date, clinic) RPC で
--      manual_bookings.service を引いて治療種別を判定 (スマートルーター)
--   3. ヒットしなければ患者が選択 (フォールバック)
--   4. 記入内容を medical_questionnaires に INSERT
--   5. アラジン側は v_booking_with_questionnaire view 経由で
--      予約・来院管理に紐付け表示
--
-- 紐付けキー: (booking_name, booking_book_date, clinic_name)
--   - booking_name = manual_bookings.name
--   - booking_book_date = manual_bookings.book_date  (予約日 = 来院日)
--   - clinic_name = manual_bookings.facility
--
-- 治療種別:
--   kyosei      矯正
--   bf          ブラックフィルム / ラミネート系
--   implant     インプラント
--   whitening   ホワイトニング
--   laburie     ラブリエ
--   general     一般診療・その他
-- =============================================================

CREATE TABLE IF NOT EXISTS medical_questionnaires (
  id BIGSERIAL PRIMARY KEY,

  -- 治療種別 (検索・分析用)
  treatment TEXT NOT NULL,

  -- 患者情報 (URL パラメータから受信したものをそのまま保存)
  patient_name TEXT NOT NULL,
  patient_email TEXT,
  patient_phone TEXT,

  -- 紐付け用 (manual_bookings.facility / book_date と一致させる)
  -- 注意: manual_bookings.book_date / apply_date は TEXT 型 (YYYY-MM-DD or YYYY/M/D)
  --       なので合わせる
  clinic_name TEXT,
  booking_book_date TEXT,
  booking_book_time TEXT,
  booking_apply_date TEXT,

  -- 共通医療項目 (既往歴・服薬・アレルギー・妊娠 等)
  -- スキーマ柔軟性のため JSONB で保持
  common_answers JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- 治療別の質問への回答 (kyosei.ts などのテンプレ準拠)
  treatment_answers JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- アップロードファイル URL (保険証・診察券 等。Storage パスを文字列配列で保持)
  upload_files JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- メタ情報
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent TEXT,
  source TEXT,          -- 'shareconnect_email' / 'manual' など
  resolved_via TEXT,    -- 'smart_router' / 'fallback_select'
  raw_url_params JSONB, -- デバッグ用、URL クエリ全部保存

  -- 管理用
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  admin_memo TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 高速検索用インデックス
CREATE INDEX IF NOT EXISTS idx_mq_link
  ON medical_questionnaires (patient_name, booking_book_date, clinic_name);
CREATE INDEX IF NOT EXISTS idx_mq_treatment
  ON medical_questionnaires (treatment);
CREATE INDEX IF NOT EXISTS idx_mq_clinic
  ON medical_questionnaires (clinic_name);
CREATE INDEX IF NOT EXISTS idx_mq_submitted_at
  ON medical_questionnaires (submitted_at DESC);

-- updated_at 自動更新トリガ
CREATE OR REPLACE FUNCTION mq_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mq_updated_at ON medical_questionnaires;
CREATE TRIGGER trg_mq_updated_at
  BEFORE UPDATE ON medical_questionnaires
  FOR EACH ROW EXECUTE FUNCTION mq_set_updated_at();


-- =============================================================
-- RLS: anon は INSERT のみ、authenticated は全権限
-- =============================================================
ALTER TABLE medical_questionnaires ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mq_insert_anon"          ON medical_questionnaires;
DROP POLICY IF EXISTS "mq_read_authenticated"   ON medical_questionnaires;
DROP POLICY IF EXISTS "mq_update_authenticated" ON medical_questionnaires;
DROP POLICY IF EXISTS "mq_delete_authenticated" ON medical_questionnaires;

-- 公開フォームから INSERT 可能 (誰でも問診票記入できる)
CREATE POLICY "mq_insert_anon"
  ON medical_questionnaires FOR INSERT
  TO anon
  WITH CHECK (true);

-- 認証ユーザー (アラジン側) は全件読める
CREATE POLICY "mq_read_authenticated"
  ON medical_questionnaires FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "mq_update_authenticated"
  ON medical_questionnaires FOR UPDATE
  TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "mq_delete_authenticated"
  ON medical_questionnaires FOR DELETE
  TO authenticated
  USING (true);


-- =============================================================
-- 日付正規化ヘルパー
-- '2026/5/19' / '2026-5-19' / '2026-05-19' を全部 'YYYY-MM-DD' に揃える
-- =============================================================
CREATE OR REPLACE FUNCTION mq_normalize_date(d TEXT) RETURNS TEXT
  LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result DATE;
  cleaned TEXT;
BEGIN
  IF d IS NULL OR TRIM(d) = '' THEN RETURN NULL; END IF;
  -- スラッシュをハイフンに統一 (2026/4/17 → 2026-4-17)
  cleaned := REPLACE(TRIM(d), '/', '-');
  -- 時刻部分を除去 (2026-4-17 10:00 → 2026-4-17)
  cleaned := SPLIT_PART(cleaned, ' ', 1);
  BEGIN
    result := cleaned::DATE;
    RETURN result::TEXT;
  EXCEPTION WHEN OTHERS THEN
    RETURN d;
  END;
END;
$$;

-- =============================================================
-- スマートルーター用 RPC
-- 公開フォームから anon 権限で呼び出される
-- 与えられた (name, book_date, clinic) で manual_bookings を検索
-- 治療種別 service と source を返す
-- =============================================================
CREATE OR REPLACE FUNCTION lookup_questionnaire_treatment(
  p_name TEXT,
  p_book_date TEXT,
  p_clinic TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_date TEXT;
  v_clinic_clean TEXT;
  v_name_clean TEXT;
  v_record RECORD;
BEGIN
  v_target_date  := mq_normalize_date(p_book_date);
  v_clinic_clean := COALESCE(NULLIF(TRIM(p_clinic), ''), '');
  v_name_clean   := REPLACE(TRIM(COALESCE(p_name, '')), ' ', '');

  -- Strategy 1: 名前完全一致 (空白除去) + 日付一致
  SELECT name, service, facility, source, apply_date, book_date INTO v_record
    FROM manual_bookings
    WHERE REPLACE(name, ' ', '') = v_name_clean
      AND mq_normalize_date(book_date) = v_target_date
    ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('found', true, 'matched_by', 'exact_name_date',
      'name', v_record.name, 'service', v_record.service,
      'facility', v_record.facility, 'source', v_record.source,
      'apply_date', v_record.apply_date, 'book_date', v_record.book_date);
  END IF;

  -- Strategy 2: 名前部分一致 (双方向 substring) + 日付一致
  IF v_name_clean <> '' THEN
    SELECT name, service, facility, source, apply_date, book_date INTO v_record
      FROM manual_bookings
      WHERE (REPLACE(name, ' ', '') ILIKE '%' || v_name_clean || '%'
          OR v_name_clean ILIKE '%' || REPLACE(name, ' ', '') || '%')
        AND mq_normalize_date(book_date) = v_target_date
      ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('found', true, 'matched_by', 'partial_name_date',
        'name', v_record.name, 'service', v_record.service,
        'facility', v_record.facility, 'source', v_record.source,
        'apply_date', v_record.apply_date, 'book_date', v_record.book_date);
    END IF;
  END IF;

  -- Strategy 3: 名前部分一致 + 医院部分一致 (双方向 substring) ← 日付不一致をカバー
  IF v_name_clean <> '' AND v_clinic_clean <> '' THEN
    SELECT name, service, facility, source, apply_date, book_date INTO v_record
      FROM manual_bookings
      WHERE (REPLACE(name, ' ', '') ILIKE '%' || v_name_clean || '%'
          OR v_name_clean ILIKE '%' || REPLACE(name, ' ', '') || '%')
        AND (facility ILIKE '%' || v_clinic_clean || '%'
          OR v_clinic_clean ILIKE '%' || facility || '%')
      ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('found', true, 'matched_by', 'partial_name_clinic',
        'name', v_record.name, 'service', v_record.service,
        'facility', v_record.facility, 'source', v_record.source,
        'apply_date', v_record.apply_date, 'book_date', v_record.book_date);
    END IF;
  END IF;

  -- 見つからなかった場合は診断情報を返す (デバッグしやすくするため)
  RETURN jsonb_build_object(
    'found', false, 'reason', 'no_matching_booking',
    'p_name', p_name, 'p_book_date', p_book_date, 'p_clinic', p_clinic,
    'v_target_date', v_target_date, 'v_name_clean', v_name_clean,
    'v_clinic_clean', v_clinic_clean
  );
END;
$$;

GRANT EXECUTE ON FUNCTION lookup_questionnaire_treatment(TEXT, TEXT, TEXT)
  TO anon, authenticated, service_role;


-- =============================================================
-- 予約 ⇄ 問診票 紐付け view (アラジンの予約・来院管理から参照)
--
-- LEFT JOIN なので、問診票が無い予約も全部出てくる。
-- 問診票が複数ある場合は最新 (submitted_at DESC) のものを採用。
-- =============================================================
CREATE OR REPLACE VIEW v_booking_with_questionnaire AS
SELECT
  mb.name              AS booking_name,
  mb.apply_date        AS booking_apply_date,
  mb.book_date         AS booking_book_date,
  mb.facility          AS clinic_name,
  mb.service           AS booking_service,
  mb.source            AS booking_source,
  mb.status            AS booking_status,
  mb.email             AS booking_email,
  mb.phone             AS booking_phone,

  -- 問診票側
  mq.id                AS questionnaire_id,
  mq.treatment         AS questionnaire_treatment,
  mq.submitted_at      AS questionnaire_submitted_at,
  mq.common_answers    AS questionnaire_common_answers,
  mq.treatment_answers AS questionnaire_treatment_answers,
  mq.upload_files      AS questionnaire_upload_files,
  mq.admin_memo        AS questionnaire_admin_memo,
  (mq.id IS NOT NULL)  AS has_questionnaire
FROM manual_bookings mb
LEFT JOIN LATERAL (
  SELECT *
    FROM medical_questionnaires q
    WHERE REPLACE(q.patient_name, ' ', '') = REPLACE(mb.name, ' ', '')
      AND mq_normalize_date(q.booking_book_date) = mq_normalize_date(mb.book_date)
    ORDER BY q.submitted_at DESC
    LIMIT 1
) mq ON TRUE;

GRANT SELECT ON v_booking_with_questionnaire TO anon, authenticated, service_role;


-- =============================================================
-- 集計用 view (問診票タブの医院別件数表示などに使う)
-- =============================================================
CREATE OR REPLACE VIEW v_questionnaire_stats AS
SELECT
  clinic_name,
  treatment,
  COUNT(*)                    AS total,
  COUNT(*) FILTER (WHERE submitted_at > NOW() - INTERVAL '7 days') AS last_7d,
  COUNT(*) FILTER (WHERE submitted_at > NOW() - INTERVAL '30 days') AS last_30d,
  MAX(submitted_at)           AS last_submitted_at
FROM medical_questionnaires
GROUP BY clinic_name, treatment;

GRANT SELECT ON v_questionnaire_stats TO anon, authenticated, service_role;


-- 確認
SELECT 'medical_questionnaires migration ready' AS status,
       (SELECT COUNT(*) FROM medical_questionnaires) AS rows;

NOTIFY pgrst, 'reload schema';
