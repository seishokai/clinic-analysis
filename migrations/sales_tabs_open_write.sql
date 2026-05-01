-- =========================================================
-- /sales/ の編集をパスワードベースに変更するため、
-- sales_tabs テーブルの書き込みRLSを緩める
-- =========================================================
-- 注意: クライアント側でパスワード "Edoyadepon1" で認証する仕組み。
-- 厳密なセキュリティ要件があれば Cloudflare Worker 経由に切り替えること。
-- 現状のリスク: anon key + テーブル名を知る人なら API で直接書き込み可能。
-- 対象は /sales/ のタブ管理 (label/url) のみで、機微情報は含まれないため
-- 利便性優先で許可する。
-- =========================================================

BEGIN;

-- 旧: portal_admin / accounts admin 限定 → 新: anon/authenticated 両方OK
DROP POLICY IF EXISTS sales_tabs_insert ON public.sales_tabs;
CREATE POLICY sales_tabs_insert
  ON public.sales_tabs FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS sales_tabs_update ON public.sales_tabs;
CREATE POLICY sales_tabs_update
  ON public.sales_tabs FOR UPDATE
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS sales_tabs_delete ON public.sales_tabs;
CREATE POLICY sales_tabs_delete
  ON public.sales_tabs FOR DELETE
  TO anon, authenticated
  USING (true);

COMMIT;
