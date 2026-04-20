-- =====================================================================
-- Supabase Auth 移行 / Phase 1 - 並走期間の基盤構築
-- =====================================================================
-- 目的: 既存 accounts テーブルに Supabase Auth 用のカラムを追加し、
--       プロファイル取得 RPC と監査ログテーブルを用意する。
--
-- 重要:
--   * 既存データは一切変更しない (ALTER ADD のみ、DROP/UPDATE/DELETE なし)
--   * RLS ポリシーは Phase 1 では "許容的" に設定し、現状の anon 動作を壊さない
--   * 本格的な権限分離・旧 password 列の廃止は Phase 3 以降で実施
--
-- 実行場所: Supabase Dashboard → SQL Editor
-- 実行順  : 最初にこのファイル (Phase 1) を実行 → 次に auth_phase2.sql
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1) accounts テーブルに Supabase Auth 連携カラムを追加 (NULL 許容)
-- ---------------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS supabase_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS email TEXT;

-- email は UNIQUE 制約を別途 (既存データに NULL があっても許容される)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_email_unique'
  ) THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_email_unique UNIQUE (email);
  END IF;
END $$;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS migrated_at TIMESTAMPTZ;

-- supabase_user_id の高速検索用インデックス
CREATE INDEX IF NOT EXISTS accounts_supabase_user_id_idx
  ON accounts (supabase_user_id);

-- ---------------------------------------------------------------------
-- 2) RLS を有効化 (Phase 1 は許容的ポリシー - 既存動作を維持)
-- ---------------------------------------------------------------------
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

-- 一時: 既存の anon キー動作を壊さないため、全許可ポリシーを設定
-- Phase 3 で supabase_user_id / role ベースの厳格なポリシーに置き換える
DROP POLICY IF EXISTS "accounts_read_all_phase1" ON accounts;
CREATE POLICY "accounts_read_all_phase1"
  ON accounts FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "accounts_write_admin_or_anon_phase1" ON accounts;
CREATE POLICY "accounts_write_admin_or_anon_phase1"
  ON accounts FOR ALL
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------
-- 3) 認証済みユーザ自身の accounts レコードを取得する RPC
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_account()
RETURNS accounts
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM accounts
  WHERE supabase_user_id = auth.uid()
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_account() TO authenticated, anon;

-- ---------------------------------------------------------------------
-- 4) 監査ログテーブル (新規、既存スキーマへの影響なし)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_audit (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_audit_user_id_idx ON auth_audit (user_id);
CREATE INDEX IF NOT EXISTS auth_audit_created_at_idx ON auth_audit (created_at DESC);

ALTER TABLE auth_audit ENABLE ROW LEVEL SECURITY;

-- Phase 1: insert のみ許容 (サービス側から書き込み、読み取りは admin のみ Phase 3 で追加)
DROP POLICY IF EXISTS "auth_audit_insert_phase1" ON auth_audit;
CREATE POLICY "auth_audit_insert_phase1"
  ON auth_audit FOR INSERT
  WITH CHECK (true);

COMMIT;

-- =====================================================================
-- 確認クエリ (任意):
--   SELECT column_name FROM information_schema.columns WHERE table_name='accounts';
--   SELECT proname FROM pg_proc WHERE proname='get_my_account';
--   SELECT policyname FROM pg_policies WHERE tablename='accounts';
-- =====================================================================
