-- ============================================================
-- booking_status_audit.sql
-- booking_status の INSERT/UPDATE/DELETE を自動で監査ログに残す
--
-- 適用方法:
--   Supabase Dashboard → SQL Editor で本ファイルを 1 回だけ実行
--
-- 効果:
--   以後の booking_status の変更は全て booking_status_audit に記録される
--   ・いつ (changed_at)
--   ・誰が (changed_by: 認証ユーザの email、無ければ UUID)
--   ・どの操作 (operation: INSERT/UPDATE/DELETE)
--   ・どのカラムが変わったか (changed_fields)
--   ・変更前 / 変更後の全カラム値 (old_row / new_row, JSONB)
--
-- アプリ側のコード変更は不要 (DB側だけで完結)
-- ============================================================

-- 1) 監査テーブル
CREATE TABLE IF NOT EXISTS public.booking_status_audit (
  id BIGSERIAL PRIMARY KEY,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  name TEXT,
  apply_date TEXT,
  changed_fields TEXT[],
  old_row JSONB,
  new_row JSONB
);

-- 検索用インデックス
CREATE INDEX IF NOT EXISTS booking_status_audit_lookup_idx
  ON public.booking_status_audit (name, apply_date, changed_at DESC);
CREATE INDEX IF NOT EXISTS booking_status_audit_changed_at_idx
  ON public.booking_status_audit (changed_at DESC);

-- 2) トリガー関数
-- SECURITY DEFINER: 関数オーナー(postgres)権限で実行するため、RLS で書き込みを
--                   完全に禁止しているテーブルにもこの関数経由でなら INSERT 可能。
CREATE OR REPLACE FUNCTION public.log_booking_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_user TEXT;
  v_changed_fields TEXT[];
  v_old_json JSONB;
  v_new_json JSONB;
BEGIN
  -- 認証ユーザの識別 (Supabase の JWT クレームを利用)
  BEGIN
    v_user := COALESCE(
      (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb)->>'email',
      (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb)->>'sub',
      current_user
    );
  EXCEPTION WHEN OTHERS THEN
    v_user := current_user;
  END;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.booking_status_audit
      (changed_by, operation, name, apply_date, new_row)
    VALUES
      (v_user, 'INSERT', NEW.name, NEW.apply_date, to_jsonb(NEW));
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.booking_status_audit
      (changed_by, operation, name, apply_date, old_row)
    VALUES
      (v_user, 'DELETE', OLD.name, OLD.apply_date, to_jsonb(OLD));
    RETURN OLD;

  ELSIF TG_OP = 'UPDATE' THEN
    v_old_json := to_jsonb(OLD);
    v_new_json := to_jsonb(NEW);
    -- 実際に値が変わったカラムだけを列挙 (updated_at だけの差分はノイズ扱い)
    v_changed_fields := ARRAY(
      SELECT k
      FROM jsonb_object_keys(v_new_json) AS k
      WHERE k NOT IN ('updated_at')
        AND v_old_json->k IS DISTINCT FROM v_new_json->k
    );
    -- 何も変わっていない (updated_at のみ動いた) ならログしない
    IF v_changed_fields IS NULL OR array_length(v_changed_fields, 1) IS NULL THEN
      RETURN NEW;
    END IF;
    INSERT INTO public.booking_status_audit
      (changed_by, operation, name, apply_date, changed_fields, old_row, new_row)
    VALUES
      (v_user, 'UPDATE', NEW.name, NEW.apply_date, v_changed_fields, v_old_json, v_new_json);
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$;

-- 3) トリガー本体
DROP TRIGGER IF EXISTS booking_status_audit_trigger ON public.booking_status;
CREATE TRIGGER booking_status_audit_trigger
AFTER INSERT OR UPDATE OR DELETE ON public.booking_status
FOR EACH ROW EXECUTE FUNCTION public.log_booking_status_change();

-- 4) RLS: 読み取りのみ許可、書き込みはトリガー (SECURITY DEFINER) 経由のみ
ALTER TABLE public.booking_status_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS booking_status_audit_select ON public.booking_status_audit;
CREATE POLICY booking_status_audit_select
  ON public.booking_status_audit
  FOR SELECT
  TO authenticated
  USING (true);

-- INSERT/UPDATE/DELETE 用のポリシーは作らない = 通常権限では不可。
-- (SECURITY DEFINER のトリガー関数のみが書き込める)

-- ============================================================
-- 履歴閲覧クエリ例 (実行不要、参考用にコメントアウト)
-- ============================================================

-- 特定人物の全変更履歴 (新しい順、JST 表示)
-- SELECT changed_at AT TIME ZONE 'Asia/Tokyo' AS at_jst,
--        changed_by,
--        operation,
--        changed_fields,
--        old_row->>'status'    AS old_status,
--        new_row->>'status'    AS new_status,
--        old_row->>'bf_status' AS old_bf_status,
--        new_row->>'bf_status' AS new_bf_status
-- FROM public.booking_status_audit
-- WHERE name = '太田悦子'
-- ORDER BY changed_at DESC;

-- 直近24時間の全変更 (誰が何を触ったかの俯瞰)
-- SELECT changed_at AT TIME ZONE 'Asia/Tokyo' AS at_jst,
--        changed_by, name, apply_date, operation, changed_fields
-- FROM public.booking_status_audit
-- WHERE changed_at > NOW() - INTERVAL '24 hours'
-- ORDER BY changed_at DESC;

-- 特定フィールド (例: status または bf_status) を触った変更だけ抽出
-- SELECT changed_at AT TIME ZONE 'Asia/Tokyo' AS at_jst,
--        changed_by, name, apply_date,
--        old_row->>'status' AS old_status,
--        new_row->>'status' AS new_status,
--        old_row->>'bf_status' AS old_bf_status,
--        new_row->>'bf_status' AS new_bf_status
-- FROM public.booking_status_audit
-- WHERE 'status' = ANY(changed_fields) OR 'bf_status' = ANY(changed_fields)
-- ORDER BY changed_at DESC
-- LIMIT 200;
