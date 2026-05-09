-- ============================================================
-- medical_questionnaires: RLS完全修復 (ワンショット)
--
-- 症状: フォーム送信時に
--   "new row violates row-level security policy for table
--    medical_questionnaires"
--
-- 根本原因:
--   Supabase の anon ロールは
--     ① RLS ポリシー (CREATE POLICY) と
--     ② テーブルレベルの GRANT INSERT
--   両方ないと挿入できない。片方だけだと弾かれる。
--   過去のマイグレーションで②が抜けていた / 別の作業で剥がれた。
--
-- このスクリプトを Supabase SQL Editor で1回流せば永続的に直る。
-- 何度流しても安全 (idempotent)。
-- ============================================================

-- 1) RLS 有効化 (既に有効ならスキップされる)
ALTER TABLE medical_questionnaires ENABLE ROW LEVEL SECURITY;

-- 2) 既存ポリシーを一掃して綺麗な状態にする
DROP POLICY IF EXISTS "mq_insert_anon"          ON medical_questionnaires;
DROP POLICY IF EXISTS "mq_read_authenticated"   ON medical_questionnaires;
DROP POLICY IF EXISTS "mq_update_authenticated" ON medical_questionnaires;
DROP POLICY IF EXISTS "mq_delete_authenticated" ON medical_questionnaires;

-- 3) anon (公開フォーム) は INSERT のみ
CREATE POLICY "mq_insert_anon"
  ON medical_questionnaires FOR INSERT
  TO anon
  WITH CHECK (true);

-- 4) authenticated (アラジン管理画面) は全権限
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

-- 5) ★最重要★ テーブルレベル GRANT (RLSと別物)
GRANT INSERT ON medical_questionnaires TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON medical_questionnaires
  TO authenticated, service_role;

-- 6) BIGSERIAL の sequence も anon が使えないと INSERT 失敗する
GRANT USAGE, SELECT ON SEQUENCE medical_questionnaires_id_seq
  TO anon, authenticated, service_role;

-- 7) PostgREST にスキーマ再読込を通知
NOTIFY pgrst, 'reload schema';

-- 8) 結果確認
SELECT
  'RLS 修復完了' AS status,
  (SELECT COUNT(*) FROM pg_policies WHERE tablename = 'medical_questionnaires') AS policies_count,
  has_table_privilege('anon', 'medical_questionnaires', 'INSERT') AS anon_can_insert,
  has_sequence_privilege('anon', 'medical_questionnaires_id_seq', 'USAGE') AS anon_can_use_seq;
