-- =========================================================
-- LINE グループリンク集 テーブル
-- =========================================================
-- Aladdin 営業ポータル `/sales/line-groups.html` から利用。
-- 店舗グループ (14) + 単独グループ (可変) を一箇所で管理し、
-- スタッフはスマホでタップして LINE アプリで開ける。
--
-- 実行手順:
--   1. Supabase Dashboard → SQL Editor で本 SQL を実行
--   2. https://seishokai.github.io/clinic-analysis/sales/line-groups.html
--      にアクセスして動作確認
-- =========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.line_groups (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  category     TEXT         NOT NULL CHECK (category IN ('store','solo')),  -- 店舗 / 単独
  name         TEXT         NOT NULL,
  url          TEXT,                                     -- LINE グループ URL (未設定なら NULL)
  sort_order   INTEGER      NOT NULL DEFAULT 0,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_line_groups_active ON public.line_groups(is_active);
CREATE INDEX IF NOT EXISTS idx_line_groups_sort   ON public.line_groups(category, sort_order);

-- updated_at 自動更新
CREATE OR REPLACE FUNCTION public.touch_line_groups_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_line_groups_updated_at ON public.line_groups;
CREATE TRIGGER trg_line_groups_updated_at
  BEFORE UPDATE ON public.line_groups
  FOR EACH ROW EXECUTE FUNCTION public.touch_line_groups_updated_at();

-- RLS: 閲覧は全員、書込は誰でも (フロントで管理者パスワードゲート)
ALTER TABLE public.line_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS line_groups_read ON public.line_groups;
CREATE POLICY line_groups_read ON public.line_groups FOR SELECT
  TO anon, authenticated USING (TRUE);
DROP POLICY IF EXISTS line_groups_write ON public.line_groups;
CREATE POLICY line_groups_write ON public.line_groups FOR ALL
  TO anon, authenticated USING (TRUE) WITH CHECK (TRUE);

-- 初期データ投入 (テーブル空の場合のみ、冪等)
INSERT INTO public.line_groups (category, name, url, sort_order)
SELECT * FROM (VALUES
  ('store', 'エスカ',   NULL::TEXT,  10),
  ('store', 'アール',   NULL,        20),
  ('store', 'ウィズ',   NULL,        30),
  ('store', '茶屋',     NULL,        40),
  ('store', 'ルミナス', NULL,        50),
  ('store', '知立',     NULL,        60),
  ('store', '小牧',     NULL,        70),
  ('store', '八事',     NULL,        80),
  ('store', 'にじいろ', NULL,        90),
  ('store', '京都',     NULL,       100),
  ('store', '大森',     NULL,       110),
  ('store', '銀座',     NULL,       120),
  ('store', '中日',     NULL,       130),
  ('store', 'アサノ',   NULL,       140),
  ('solo',  'ドクター清翔会',        NULL,                                    10),
  ('solo',  'ドクターシフト',        NULL,                                    20),
  ('solo',  '清翔会グループ',        'https://line.me/ti/g/F3J9AxntA8',       30),
  ('solo',  'seishokaiグループ全体', 'https://line.me/ti/g/jqjfM-Kcj4',       40)
) AS v(category, name, url, sort_order)
WHERE (SELECT COUNT(*) FROM public.line_groups) = 0;

-- 営業ポータルにカード追加 (LINE グリーン風にハイライト)
INSERT INTO public.sales_tabs (label, url, external, highlight, sort_order, is_active)
SELECT '💬 LINE グループ', '/clinic-analysis/sales/line-groups.html', FALSE, TRUE, 45, TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM public.sales_tabs
  WHERE url = '/clinic-analysis/sales/line-groups.html' AND parent_id IS NULL
);

COMMIT;
