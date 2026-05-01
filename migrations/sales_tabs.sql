-- =========================================================
-- 営業ポータル: タブ管理テーブル
-- =========================================================
-- Aladdin の /sales/ ページで動的にタブを管理するためのテーブル。
-- 階層は parent_id で再帰的に表現（任意の深さに対応）。
--
-- 実行手順:
--   1. Supabase Dashboard → SQL Editor で本 SQL を実行
--   2. /sales/index.html にアクセスして動作確認
-- =========================================================

BEGIN;

-- 1. テーブル作成
CREATE TABLE IF NOT EXISTS public.sales_tabs (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id    UUID         REFERENCES public.sales_tabs(id) ON DELETE CASCADE,
  label        TEXT         NOT NULL,
  url          TEXT,
  external     BOOLEAN      NOT NULL DEFAULT FALSE,  -- target=_blank で開くか
  highlight    BOOLEAN      NOT NULL DEFAULT FALSE,  -- 黄色ハイライト表示
  sort_order   INTEGER      NOT NULL DEFAULT 0,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by   UUID         REFERENCES auth.users(id),
  updated_by   UUID         REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_sales_tabs_parent ON public.sales_tabs(parent_id);
CREATE INDEX IF NOT EXISTS idx_sales_tabs_sort   ON public.sales_tabs(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_sales_tabs_active ON public.sales_tabs(is_active);

-- 2. updated_at 自動更新トリガー
CREATE OR REPLACE FUNCTION public.touch_sales_tabs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sales_tabs_updated_at ON public.sales_tabs;
CREATE TRIGGER trg_sales_tabs_updated_at
  BEFORE UPDATE ON public.sales_tabs
  FOR EACH ROW EXECUTE FUNCTION public.touch_sales_tabs_updated_at();

-- 3. RLS
ALTER TABLE public.sales_tabs ENABLE ROW LEVEL SECURITY;

-- 閲覧: 全員 (anon 含む) - 公開ポータルなので
DROP POLICY IF EXISTS sales_tabs_read ON public.sales_tabs;
CREATE POLICY sales_tabs_read
  ON public.sales_tabs FOR SELECT
  TO anon, authenticated
  USING (is_active = TRUE);

-- 書込み: admin のみ
DROP POLICY IF EXISTS sales_tabs_insert ON public.sales_tabs;
CREATE POLICY sales_tabs_insert
  ON public.sales_tabs FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.supabase_user_id = auth.uid()
        AND (a.role = 'admin' OR a.account_type = 'admin')
    )
  );

DROP POLICY IF EXISTS sales_tabs_update ON public.sales_tabs;
CREATE POLICY sales_tabs_update
  ON public.sales_tabs FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.supabase_user_id = auth.uid()
        AND (a.role = 'admin' OR a.account_type = 'admin')
    )
  );

DROP POLICY IF EXISTS sales_tabs_delete ON public.sales_tabs;
CREATE POLICY sales_tabs_delete
  ON public.sales_tabs FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.supabase_user_id = auth.uid()
        AND (a.role = 'admin' OR a.account_type = 'admin')
    )
  );

-- 4. 既存タブの初期データ投入
-- 注: /sales/index.html から開かれるため、内部URLは /clinic-analysis/ 起点の絶対パス
WITH inserted_parents AS (
  INSERT INTO public.sales_tabs (label, url, external, highlight, sort_order)
  VALUES
    ('研修サイト',         NULL,                                                FALSE, FALSE, 10),
    ('ドクターシフト',     'https://seishokai.github.io/shift/',                TRUE,  FALSE, 20),
    ('口コミ',             '/clinic-analysis/reviews.html',                    FALSE, FALSE, 30),
    ('SEO',                'https://seo-web-lake.vercel.app/sites/1',           TRUE,  FALSE, 40),
    ('デンタルローン',     '/clinic-analysis/dental-loan/',                    FALSE, FALSE, 50),
    ('🎯 PBMインセンティブ', '/clinic-analysis/pbm.html',                       FALSE, TRUE,  60)
  RETURNING id, label
)
INSERT INTO public.sales_tabs (parent_id, label, url, external, sort_order)
SELECT
  p.id,
  c.label,
  c.url,
  c.external,
  c.sort_order
FROM inserted_parents p
CROSS JOIN LATERAL (
  VALUES
    ('動画研修',       'https://owojchhi.gensparkspace.com/index.html', TRUE,  10),
    ('Q&A研修',        '/clinic-analysis/qa.html',                       FALSE, 20),
    ('矯正アドバンス', '/clinic-analysis/ortho.html',                    FALSE, 30),
    ('矯正アドバンス2','/clinic-analysis/ortho2.html',                   FALSE, 40)
) AS c(label, url, external, sort_order)
WHERE p.label = '研修サイト';

COMMIT;
