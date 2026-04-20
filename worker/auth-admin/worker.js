// Cloudflare Worker: seishokai-auth-admin
// =========================================================
// 環境変数 (Secrets):
//   SUPABASE_URL             例: https://ndlfqrvoejwgqfdtghmg.supabase.co
//   SUPABASE_ANON_KEY        Dashboardの「anon」key (public OK)
//   SUPABASE_SERVICE_ROLE_KEY Dashboardの「service_role」key (絶対に秘匿)
//   ALLOWED_ORIGIN           例: https://seishokai.github.io (CORS制限用)
// エンドポイント:
//   POST /auth-admin/create         ← アカウント作成
//   POST /auth-admin/reset-password ← PW再発行
//   POST /auth-admin/delete         ← Auth user削除 (accountsはRPCで別途)
// 認証:
//   ヘッダ Authorization: Bearer {admin_jwt}
//   Worker が Supabase rpc is_auth_admin で admin 確認

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin === '*' ? '*' : (origin === allowedOrigin ? allowedOrigin : ''),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const json = (data, status=200) => new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

    // admin JWT 検証ヘルパー
    const verifyAdmin = async () => {
      const h = request.headers.get('Authorization');
      if (!h?.startsWith('Bearer ')) return { ok: false, error: 'auth header missing' };
      const jwt = h.slice(7);
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/is_auth_admin`, {
        method: 'POST',
        headers: {
          'apikey': env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (!r.ok) return { ok: false, error: 'jwt verify failed: ' + r.status };
      const isAdmin = await r.json();
      if (isAdmin !== true) return { ok: false, error: 'admin only' };
      return { ok: true, jwt };
    };

    // POST /auth-admin/create
    if (url.pathname === '/auth-admin/create' && request.method === 'POST') {
      const v = await verifyAdmin();
      if (!v.ok) return json({ ok: false, error: v.error }, 401);

      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
      const { email, password, name, role, agency, allowed_promos } = body || {};
      if (!email || !password || !name || !role) return json({ ok: false, error: 'required fields missing' }, 400);
      if (!['admin','staff_promo','agency'].includes(role)) return json({ ok: false, error: 'invalid role' }, 400);

      // 1. Auth user 作成
      const createRes = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email, password, email_confirm: true,
          user_metadata: { name, role, agency: agency || '' },
        }),
      });
      const createJson = await createRes.json();
      if (!createRes.ok || !createJson.id) {
        return json({ ok: false, error: createJson.msg || createJson.error_description || createJson.error || 'Auth user creation failed', detail: createJson }, 500);
      }
      const newUid = createJson.id;

      // 2. accounts に紐付け
      const linkRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_create_account_with_role`, {
        method: 'POST',
        headers: {
          'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_user_uuid: newUid,
          p_email: email,
          p_name: name,
          p_role: role,
          p_agency: agency || '',
          p_allowed_promos: allowed_promos || [],
        }),
      });
      const linkJson = await linkRes.json();
      if (!linkJson?.ok) {
        // ロールバック: Auth user 削除
        await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${newUid}`, {
          method: 'DELETE',
          headers: {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        });
        return json({ ok: false, error: linkJson?.error || 'link failed' }, 500);
      }

      return json({ ok: true, user_id: newUid, email, password });
    }

    // POST /auth-admin/reset-password
    if (url.pathname === '/auth-admin/reset-password' && request.method === 'POST') {
      const v = await verifyAdmin();
      if (!v.ok) return json({ ok: false, error: v.error }, 401);
      const body = await request.json().catch(()=>({}));
      const { user_id, new_password } = body;
      if (!user_id || !new_password) return json({ ok: false, error: 'user_id and new_password required' }, 400);
      const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${user_id}`, {
        method: 'PUT',
        headers: {
          'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password: new_password }),
      });
      const rj = await r.json();
      if (!r.ok) return json({ ok: false, error: rj.msg || 'reset failed' }, 500);
      return json({ ok: true });
    }

    // POST /auth-admin/delete
    if (url.pathname === '/auth-admin/delete' && request.method === 'POST') {
      const v = await verifyAdmin();
      if (!v.ok) return json({ ok: false, error: v.error }, 401);
      const body = await request.json().catch(()=>({}));
      const { user_id, account_id } = body;
      if (!user_id) return json({ ok: false, error: 'user_id required' }, 400);
      // Auth user 削除
      const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${user_id}`, {
        method: 'DELETE',
        headers: {
          'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (!r.ok && r.status !== 404) {
        const rj = await r.json().catch(()=>({}));
        return json({ ok: false, error: rj.msg || 'auth delete failed' }, 500);
      }
      // accounts 側も削除 (account_id 指定あれば)
      if (account_id) {
        await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_delete_account`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ p_account_id: account_id }),
        });
      }
      return json({ ok: true });
    }

    return json({ ok: false, error: 'not found' }, 404);
  }
};
