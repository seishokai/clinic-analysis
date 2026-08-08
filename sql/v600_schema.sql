-- ============================================================
-- Aladdin v600 新スキーマ (Phase 0)
--   Sheets を主データにするのを廃し、Supabase を唯一の真実にする。
--   このスクリプトは「空テーブルを作るだけ」で本番データには
--   一切触らない。既存の booking_status / manual_bookings / bf_history
--   はそのまま並行運用する。
--
--   実行順: Supabase SQL Editor で全体を 1 回 Run するだけ。
--   Rollback: 末尾の DROP コメントを解除して Run。
--
--   設計判断 (2026-08-08 拓未さん GO):
--     Q1 = 電話下 4 桁で別人判定
--     Q2 = 同一患者の新規予約として追加 (履歴保持)
--     Q3 = Sheets 同期は 1 時間ごと自動
-- ============================================================

-- ------------------------------------------------------------
-- 1. patients (患者マスタ) — 1 患者 1 行
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patients (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 表示用の名前 (最新申込のもの or 手動編集で上書き)
  name              TEXT NOT NULL,
  -- 名寄せキー: 全空白 (半角/全角/無) 除去 + 小文字化
  --   同一人物判定は (normalized_name, phone_last4) の組で行う (Q1)
  normalized_name   TEXT NOT NULL,

  -- 連絡先
  phone             TEXT,
  -- 電話番号下 4 桁 (数字のみ)。Q1 の同一人物判定キー
  phone_last4       TEXT,
  email             TEXT,

  -- メタ
  primary_facility  TEXT,   -- 主たる来院医院 (最新の visits から)
  first_seen        TIMESTAMPTZ,  -- 初回申込日 (visits の最古 apply_at)
  last_activity     TIMESTAMPTZ,  -- 最新アクティビティ (visits or status_events の最新)

  -- 患者レベルの自由記述メモ (来院ごとのメモは patient_visits.memo)
  patient_note      TEXT,

  -- ソフト削除
  deleted           BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at        TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        TEXT,
  updated_by        TEXT
);

COMMENT ON TABLE patients IS 'v600: 患者マスタ。normalized_name + phone_last4 で同一人物判定。';

CREATE INDEX IF NOT EXISTS idx_patients_norm_phone
  ON patients (normalized_name, phone_last4);
CREATE INDEX IF NOT EXISTS idx_patients_normname
  ON patients (normalized_name);
CREATE INDEX IF NOT EXISTS idx_patients_phone4
  ON patients (phone_last4);
CREATE INDEX IF NOT EXISTS idx_patients_email
  ON patients (email);
CREATE INDEX IF NOT EXISTS idx_patients_deleted
  ON patients (deleted) WHERE deleted = FALSE;


-- ------------------------------------------------------------
-- 2. patient_visits (予約・来院) — 1 患者 : N 予約
--    Q2: 同じ人が再申込したら別 visit として追加。過去履歴を保持。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patient_visits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id        UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,

  -- 日付 (Sheets 由来)
  apply_at          TIMESTAMPTZ NOT NULL,   -- 申込日時 (Sheets の元データ)
  apply_date        DATE NOT NULL,          -- 申込日 (日付部分、絞り込み用)
  book_at           TIMESTAMPTZ,            -- 予約日時
  book_date         DATE,                    -- 予約日 (日付部分)

  -- ソース (Sheets の どの sheet/tool 由来か)
  source_tool       TEXT,     -- DXHUB / セレクト / 手動 / import
  source_row_id     TEXT,     -- Sheets 側の識別子 (import 冪等性のため)
  facility          TEXT,     -- 予約医院
  service           TEXT,     -- 相談内容
  promo_code        TEXT,     -- プロモコード (source 列)

  -- 状態
  status            TEXT,                 -- 未対応/確認済/来院済/成約/キャンセル/等
  bf_status         TEXT,                 -- BF ライフサイクル状態
  contract_amount   NUMERIC(12, 2),       -- 契約金額
  contract_service  TEXT,                 -- 成約商材
  contract_date     DATE,                 -- 成約月 (YYYY-MM-01)
  payment_month     DATE,                 -- 入金月
  incentive_amount  NUMERIC(12, 2),
  incentive_month   DATE,
  incentive_paid    BOOLEAN NOT NULL DEFAULT FALSE,
  paid_at           TIMESTAMPTZ,
  paid_by           TEXT,

  -- BF 関連の追加フィールド
  memo              TEXT,       -- 来院ごとのメモ (BF/一般両用)
  next_visit_date   DATE,       -- 次回予定日 (bf_next_date 相当)
  next_visit_fixed  BOOLEAN NOT NULL DEFAULT FALSE,
  cs_facility       TEXT,       -- BF CS 医院
  cs_doctor         TEXT,       -- BF CS 担当医
  set_facility      TEXT,       -- BF セット医院
  travel_cost       NUMERIC(10, 2),

  -- 編集された値 (edited_book_date/edited_service 相当)
  --   patient.name とは別。visit 単位で表示上変えたい時のみ
  edited_book_date  DATE,
  edited_service    TEXT,
  edited_facility   TEXT,

  -- ソフト削除 (「除外」相当)
  deleted           BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at        TIMESTAMPTZ,
  deleted_reason    TEXT,   -- 除外(削除) / キャンセル / 重複統合 等

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        TEXT,
  updated_by        TEXT,

  -- 同一 patient + 同 apply_at (秒精度) は 1 レコード限定
  --   Sheets 再取り込み時の冪等性を保証
  UNIQUE (patient_id, apply_at)
);

COMMENT ON TABLE patient_visits IS 'v600: 予約・来院。1 患者に N 件。Sheets 再取り込みでも apply_at で dedup。';

CREATE INDEX IF NOT EXISTS idx_visits_patient
  ON patient_visits (patient_id);
CREATE INDEX IF NOT EXISTS idx_visits_status
  ON patient_visits (status) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_visits_bf_status
  ON patient_visits (bf_status) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_visits_book_date
  ON patient_visits (book_date DESC) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_visits_apply_date
  ON patient_visits (apply_date DESC) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_visits_facility
  ON patient_visits (facility) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_visits_source_row
  ON patient_visits (source_tool, source_row_id);


-- ------------------------------------------------------------
-- 3. status_events (ステータス変更履歴) — append-only、絶対 UPDATE しない
--    Q2 の「履歴保持」の実装。BF 履歴もここに統合。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS status_events (
  id                BIGSERIAL PRIMARY KEY,
  visit_id          UUID NOT NULL REFERENCES patient_visits(id) ON DELETE CASCADE,
  patient_id        UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,

  from_status       TEXT,
  to_status         TEXT,
  from_bf_status    TEXT,
  to_bf_status      TEXT,

  -- 変更理由・コンテキスト
  event_type        TEXT NOT NULL DEFAULT 'status_change',
    -- status_change / memo / contract / next_visit / cs_change / import / etc
  note              TEXT,   -- 自由記述 (「電話で日程確認」など)
  changed_fields    JSONB,  -- 具体的な変更内容 (before/after)

  changed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by        TEXT
);

COMMENT ON TABLE status_events IS 'v600: ステータス・メモ変更の追記型履歴。UPDATE 禁止。';

CREATE INDEX IF NOT EXISTS idx_events_visit
  ON status_events (visit_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_patient
  ON status_events (patient_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type
  ON status_events (event_type, changed_at DESC);


-- ------------------------------------------------------------
-- 4. sheets_import_log (Sheets 同期の実行ログ) — Q3 の 1 時間ごと同期用
--    どの Sheets 行を いつ どう処理したか記録。冪等性検証用。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sheets_import_log (
  id                BIGSERIAL PRIMARY KEY,
  run_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_tool       TEXT NOT NULL,
  rows_scanned      INT NOT NULL DEFAULT 0,
  rows_new          INT NOT NULL DEFAULT 0,
  rows_skipped      INT NOT NULL DEFAULT 0,
  rows_error        INT NOT NULL DEFAULT 0,
  duration_ms       INT,
  error_detail      JSONB,   -- 失敗した行の raw + 理由
  triggered_by      TEXT     -- cron / manual / worker
);

COMMENT ON TABLE sheets_import_log IS 'v600: Sheets → patients 同期の実行ログ。';

CREATE INDEX IF NOT EXISTS idx_import_log_time
  ON sheets_import_log (run_at DESC);


-- ------------------------------------------------------------
-- 5. トリガー: updated_at 自動更新
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION _set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patients_updated ON patients;
CREATE TRIGGER trg_patients_updated
  BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION _set_updated_at();

DROP TRIGGER IF EXISTS trg_visits_updated ON patient_visits;
CREATE TRIGGER trg_visits_updated
  BEFORE UPDATE ON patient_visits
  FOR EACH ROW EXECUTE FUNCTION _set_updated_at();


-- ------------------------------------------------------------
-- 6. status_events 自動記録トリガー
--   patient_visits の status / bf_status / memo 等が変わったら
--   status_events に自動追記する。UI 側で明示的に書かなくても履歴が残る。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION _log_status_event() RETURNS TRIGGER AS $$
DECLARE
  _changed JSONB := '{}'::jsonb;
  _type    TEXT := 'update';
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    _changed := _changed || jsonb_build_object('status',
      jsonb_build_object('from', OLD.status, 'to', NEW.status));
    _type := 'status_change';
  END IF;
  IF NEW.bf_status IS DISTINCT FROM OLD.bf_status THEN
    _changed := _changed || jsonb_build_object('bf_status',
      jsonb_build_object('from', OLD.bf_status, 'to', NEW.bf_status));
    _type := 'status_change';
  END IF;
  IF NEW.memo IS DISTINCT FROM OLD.memo THEN
    _changed := _changed || jsonb_build_object('memo',
      jsonb_build_object('from', OLD.memo, 'to', NEW.memo));
  END IF;
  IF NEW.contract_amount IS DISTINCT FROM OLD.contract_amount THEN
    _changed := _changed || jsonb_build_object('contract_amount',
      jsonb_build_object('from', OLD.contract_amount, 'to', NEW.contract_amount));
    _type := COALESCE(NULLIF(_type,'update'), 'contract');
  END IF;
  IF NEW.next_visit_date IS DISTINCT FROM OLD.next_visit_date THEN
    _changed := _changed || jsonb_build_object('next_visit_date',
      jsonb_build_object('from', OLD.next_visit_date, 'to', NEW.next_visit_date));
  END IF;
  IF _changed <> '{}'::jsonb THEN
    INSERT INTO status_events (visit_id, patient_id, from_status, to_status,
      from_bf_status, to_bf_status, event_type, changed_fields, changed_by)
    VALUES (NEW.id, NEW.patient_id, OLD.status, NEW.status,
      OLD.bf_status, NEW.bf_status, _type, _changed, NEW.updated_by);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_visits_log_event ON patient_visits;
CREATE TRIGGER trg_visits_log_event
  AFTER UPDATE ON patient_visits
  FOR EACH ROW EXECUTE FUNCTION _log_status_event();


-- ------------------------------------------------------------
-- 7. patients.last_activity 自動更新
--   visits が更新されるたびに親 patient の last_activity を進める
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION _bump_patient_activity() RETURNS TRIGGER AS $$
BEGIN
  UPDATE patients SET last_activity = NOW()
    WHERE id = NEW.patient_id AND (last_activity IS NULL OR last_activity < NOW());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_visits_bump_activity ON patient_visits;
CREATE TRIGGER trg_visits_bump_activity
  AFTER INSERT OR UPDATE ON patient_visits
  FOR EACH ROW EXECUTE FUNCTION _bump_patient_activity();


-- ------------------------------------------------------------
-- 8. 便利ビュー: patient_visits_with_patient
--   UI が joining する手間を省く。patient 情報も一緒に取れる。
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_visits_with_patient AS
SELECT
  v.id                AS visit_id,
  v.patient_id,
  p.name              AS patient_name,
  p.normalized_name,
  p.phone,
  p.phone_last4,
  p.email,
  v.apply_at, v.apply_date, v.book_at, v.book_date,
  v.source_tool, v.source_row_id,
  v.facility, v.service, v.promo_code,
  v.status, v.bf_status,
  v.contract_amount, v.contract_service, v.contract_date,
  v.payment_month, v.incentive_amount, v.incentive_month,
  v.incentive_paid, v.paid_at, v.paid_by,
  v.memo, v.next_visit_date, v.next_visit_fixed,
  v.cs_facility, v.cs_doctor, v.set_facility, v.travel_cost,
  v.edited_book_date, v.edited_service, v.edited_facility,
  v.deleted, v.deleted_at, v.deleted_reason,
  v.created_at, v.updated_at, v.updated_by,
  p.patient_note,
  p.primary_facility
FROM patient_visits v
JOIN patients p ON p.id = v.patient_id
WHERE p.deleted = FALSE;

COMMENT ON VIEW v_visits_with_patient IS 'v600: UI 用の統合ビュー。patient と visit を join。';


-- ------------------------------------------------------------
-- 9. RLS (Row Level Security) — Phase 0 では全開。Phase 3 で締める。
-- ------------------------------------------------------------
ALTER TABLE patients          ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_visits    ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sheets_import_log ENABLE ROW LEVEL SECURITY;

-- 全操作許可 (Phase 3 で認証ベースに置換)
DROP POLICY IF EXISTS "allow_all_patients" ON patients;
CREATE POLICY "allow_all_patients" ON patients FOR ALL USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS "allow_all_visits" ON patient_visits;
CREATE POLICY "allow_all_visits" ON patient_visits FOR ALL USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS "allow_all_events" ON status_events;
CREATE POLICY "allow_all_events" ON status_events FOR ALL USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS "allow_all_import_log" ON sheets_import_log;
CREATE POLICY "allow_all_import_log" ON sheets_import_log FOR ALL USING (TRUE) WITH CHECK (TRUE);


-- ------------------------------------------------------------
-- 10. Realtime を有効化 (Supabase の Realtime channel で購読可能に)
-- ------------------------------------------------------------
-- ALTER PUBLICATION supabase_realtime ADD TABLE patients;
-- ALTER PUBLICATION supabase_realtime ADD TABLE patient_visits;
-- ALTER PUBLICATION supabase_realtime ADD TABLE status_events;
-- ↑ Phase 3 (UI 切替時) に有効化。今は不要。


-- ============================================================
-- 動作確認 (実行後にこれを Run すると期待通り作成できたか分かる)
-- ============================================================
-- SELECT
--   table_name,
--   pg_size_pretty(pg_total_relation_size(('public.'||table_name)::regclass)) AS size
-- FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN ('patients','patient_visits','status_events','sheets_import_log')
-- ORDER BY table_name;


-- ============================================================
-- ROLLBACK (必要な場合のみ末尾を Run)
-- ============================================================
-- DROP VIEW  IF EXISTS v_visits_with_patient;
-- DROP TABLE IF EXISTS sheets_import_log;
-- DROP TABLE IF EXISTS status_events;
-- DROP TABLE IF EXISTS patient_visits;
-- DROP TABLE IF EXISTS patients;
-- DROP FUNCTION IF EXISTS _log_status_event();
-- DROP FUNCTION IF EXISTS _bump_patient_activity();
-- DROP FUNCTION IF EXISTS _set_updated_at();
