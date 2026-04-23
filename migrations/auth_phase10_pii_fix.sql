-- Phase 10 追加修正: 関数の EXECUTE 権限を付与してスキーマキャッシュを再読込
-- get_my_account が 400 で失敗する問題への対処

GRANT EXECUTE ON FUNCTION get_my_account() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin_list_accounts_for_mig() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin_update_account(INTEGER, TEXT, TEXT, JSONB, JSONB, BOOLEAN) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin_create_account_with_role(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BOOLEAN) TO anon, authenticated, service_role;

-- スキーマキャッシュをリロード
NOTIFY pgrst, 'reload schema';

-- 確認: get_my_account() を直接叩いてみる (anon ユーザーは NULL が返るはず)
-- SELECT get_my_account();
