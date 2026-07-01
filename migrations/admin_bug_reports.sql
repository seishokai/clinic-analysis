-- =========================================================
-- Aladdin 修正依頼 (バグレポート) テーブル
-- =========================================================
-- 管理者/スタッフが Aladdin から直接エラー報告・修正依頼を
-- 投稿できるようにする。
--
-- 送信フロー:
--   1. Aladdin UI (管理 → 🐛 修正依頼) からフォーム送信
--   2. スクリーンショットは Supabase Storage 'bug-reports' バケットへ
--   3. INSERT 完了後、Cloudflare Worker が GitHub Issue を作成し
--      github_issue_url を UPDATE
--
-- 実行手順:
--   1. Supabase Dashboard → SQL Editor で本 SQL を実行
--   2. Storage → New bucket → 名前 'bug-reports' / Public
-- =========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_bug_reports (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT         NOT NULL,
  description      TEXT         NOT NULL,
  screen           TEXT,                                    -- 該当画面 (予約/来院/分析…)
  priority         TEXT         NOT NULL DEFAULT '通常'
                                CHECK (priority IN ('至急','通常','低')),
  status           TEXT         NOT NULL DEFAULT '未対応'
                                CHECK (status IN ('未対応','対応中','解決','保留','却下')),
  screenshot_url   TEXT,                                    -- Supabase Storage public URL
  github_issue_url TEXT,                                    -- Worker が更新
  reporter_name    TEXT,                                    -- 送信者 (足立TC 等)
  reporter_email   TEXT,
  resolution_note  TEXT,                                    -- 対応メモ (Claude が書き込み)
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_bug_reports_status  ON public.admin_bug_reports(status);
CREATE INDEX IF NOT EXISTS idx_admin_bug_reports_created ON public.admin_bug_reports(created_at DESC);

-- updated_at 自動更新
CREATE OR REPLACE FUNCTION public.touch_admin_bug_reports_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_bug_reports_updated_at ON public.admin_bug_reports;
CREATE TRIGGER trg_admin_bug_reports_updated_at
  BEFORE UPDATE ON public.admin_bug_reports
  FOR EACH ROW EXECUTE FUNCTION public.touch_admin_bug_reports_updated_at();

-- resolved_at 自動セット (status='解決' に変わった時)
CREATE OR REPLACE FUNCTION public.set_resolved_at_on_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = '解決' AND (OLD.status IS NULL OR OLD.status <> '解決') THEN
    NEW.resolved_at = NOW();
  ELSIF NEW.status <> '解決' THEN
    NEW.resolved_at = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_resolved_at ON public.admin_bug_reports;
CREATE TRIGGER trg_set_resolved_at
  BEFORE UPDATE ON public.admin_bug_reports
  FOR EACH ROW EXECUTE FUNCTION public.set_resolved_at_on_status_change();

-- RLS
ALTER TABLE public.admin_bug_reports ENABLE ROW LEVEL SECURITY;

-- 閲覧: 認証済みユーザー全員
DROP POLICY IF EXISTS admin_bug_reports_read ON public.admin_bug_reports;
CREATE POLICY admin_bug_reports_read
  ON public.admin_bug_reports FOR SELECT
  TO anon, authenticated
  USING (TRUE);

-- 投稿: 誰でも可 (フォーム経由・スタッフも投稿できるように)
DROP POLICY IF EXISTS admin_bug_reports_insert ON public.admin_bug_reports;
CREATE POLICY admin_bug_reports_insert
  ON public.admin_bug_reports FOR INSERT
  TO anon, authenticated
  WITH CHECK (TRUE);

-- 更新: ステータス管理は誰でも可 (承認は運用側で)
DROP POLICY IF EXISTS admin_bug_reports_update ON public.admin_bug_reports;
CREATE POLICY admin_bug_reports_update
  ON public.admin_bug_reports FOR UPDATE
  TO anon, authenticated
  USING (TRUE);

-- 削除: admin のみ
DROP POLICY IF EXISTS admin_bug_reports_delete ON public.admin_bug_reports;
CREATE POLICY admin_bug_reports_delete
  ON public.admin_bug_reports FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.supabase_user_id = auth.uid()
        AND (a.role = 'admin' OR a.account_type = 'admin')
    )
  );

COMMIT;

-- =========================================================
-- Storage バケット作成 (Supabase Dashboard → Storage → New bucket)
--   名前: bug-reports
--   Public: ON (screenshot_url は GitHub Issue から参照するため公開)
-- Storage の RLS policy:
--   - anon INSERT 可 (フォーム経由)
--   - anon SELECT 可 (Public URL)
-- =========================================================
