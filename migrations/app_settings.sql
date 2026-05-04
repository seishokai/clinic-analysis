-- =============================================================
-- app_settings: 全ユーザー共有のアプリ設定 (key-value JSONB)
-- v293: Quick チップ (top5非表示リスト + カスタムチップ) などを
--       全ユーザー (admin / agency / staff_promo) で共有するため。
--
-- 用途例:
--   key='quick_promo_hidden'  value=["promo1","promo2"]   (top5非表示リスト)
--   key='quick_promo_custom'  value=[{"label":"third全","promos":[...]}, ...]
--
-- 運用: admin が変更 → 全ユーザーに反映 (リロード時に取得)
-- =============================================================

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT
);

-- RLS有効化
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- 既存ポリシーがあれば削除して再作成 (冪等)
DROP POLICY IF EXISTS "app_settings_read_anon"          ON app_settings;
DROP POLICY IF EXISTS "app_settings_read_authenticated" ON app_settings;
DROP POLICY IF EXISTS "app_settings_write_authenticated" ON app_settings;

-- 全認証ユーザー読み取り可
CREATE POLICY "app_settings_read_anon"
  ON app_settings FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "app_settings_read_authenticated"
  ON app_settings FOR SELECT
  TO authenticated
  USING (true);

-- 認証ユーザーは書き込み可 (admin/agency/staff_promo 全員)
CREATE POLICY "app_settings_write_authenticated"
  ON app_settings FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- 確認用: テーブル一覧
SELECT 'app_settings ready' AS status, COUNT(*) AS rows FROM app_settings;
