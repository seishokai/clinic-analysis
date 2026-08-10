-- ============================================================
-- v700: 初診管理シート → Aladdin 自動同期 用スキーマ拡張
--
-- 追加するもの:
--   1. patient_visits.source_channel : 初診由来 (「紹介」「インスタ」等) を格納
--   2. patient_visits.sync_source    : シート由来行を識別 (「sheet:①銀座初診:row=42」)
--   3. sync_log テーブル : 同期実行履歴
--
-- 実行方法:
--   Supabase Dashboard → SQL Editor で全文貼り付け → Run
--   (何度実行しても壊れないよう IF NOT EXISTS を全て付けた)
-- ============================================================

-- 1) patient_visits にカラム追加 -----------------------------------------------
ALTER TABLE patient_visits
  ADD COLUMN IF NOT EXISTS source_channel TEXT,
  ADD COLUMN IF NOT EXISTS sync_source    TEXT;

COMMENT ON COLUMN patient_visits.source_channel IS
  'v700: 初診由来 (「紹介」「インスタ」「TIKTOK」等)。シート E/F/G/H 列などから';
COMMENT ON COLUMN patient_visits.sync_source IS
  'v700: シート同期由来行の識別子。形式「sheet:<タブ名>:<row>」。手動 INSERT 行は NULL';

-- 過去に間違って作った index があれば削除 (v700 初版)
DROP INDEX IF EXISTS uidx_visits_dedup;

-- dedup index (同じ patient+facility+date は 1 行のみ)
--   normalized_name は patients テーブル側にあるので、代わりに patient_id で dedup
--   deleted=FALSE のみ対象 (ソフト削除された行は再取込可)
CREATE UNIQUE INDEX IF NOT EXISTS uidx_visits_dedup
  ON patient_visits (patient_id, facility, book_date)
  WHERE book_date IS NOT NULL AND deleted = FALSE;

-- 2) sync_log テーブル ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_log (
  id            BIGSERIAL PRIMARY KEY,
  run_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger       TEXT NOT NULL,               -- 'cron' | 'manual' | 'boot'
  tabs_read     INT NOT NULL DEFAULT 0,
  rows_read     INT NOT NULL DEFAULT 0,
  rows_inserted INT NOT NULL DEFAULT 0,
  rows_skipped  INT NOT NULL DEFAULT 0,
  rows_error    INT NOT NULL DEFAULT 0,
  duration_ms   INT,
  error_message TEXT,
  details       JSONB                        -- タブごとの内訳
);

CREATE INDEX IF NOT EXISTS idx_sync_log_run_at ON sync_log (run_at DESC);

COMMENT ON TABLE sync_log IS
  'v700: 初診管理シート 同期実行ログ。UI で「最終同期: 12:34」表示に使う';

-- 3) RLS: sync_log は auth 済ユーザ (全社員) が read 可能 --------------------
ALTER TABLE sync_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sync_log_read_authenticated" ON sync_log;
CREATE POLICY "sync_log_read_authenticated" ON sync_log
  FOR SELECT TO authenticated USING (true);

-- (INSERT は Worker が service_role キーで実行するので policy 不要)

-- 4) 便利 view: 最新の同期ステータス ------------------------------------------
CREATE OR REPLACE VIEW v_latest_sync AS
  SELECT
    id, run_at, trigger, tabs_read,
    rows_read, rows_inserted, rows_skipped, rows_error,
    duration_ms, error_message,
    EXTRACT(EPOCH FROM (NOW() - run_at)) AS seconds_ago
  FROM sync_log
  ORDER BY run_at DESC
  LIMIT 1;

GRANT SELECT ON v_latest_sync TO authenticated, anon;
