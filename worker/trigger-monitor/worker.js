// Cloudflare Worker: seishokai-trigger-monitor
// =========================================================
// 予約枠監視 (GitHub Actions monitor.yml) をブラウザのワンクリックから
// 起動するためのプロキシ。GitHub PAT は Worker secret に格納し、
// フロントエンドには絶対に出さない。
//
// 環境変数 (Secrets):
//   GITHUB_PAT       fine-grained PAT。Repository = seishokai/clinic-analysis,
//                    Permissions = Actions: Read and write
//   ALLOWED_ORIGIN   https://seishokai.github.io
//
// エンドポイント:
//   POST /trigger    ← workflow_dispatch を起動
//   GET  /status     ← 最新Workflow実行状況を返す (フロントのポーリング用)

const REPO = 'seishokai/clinic-analysis';
const WORKFLOW = 'monitor.yml';
const REF = 'master';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin === '*' ? '*' : (origin === allowedOrigin ? allowedOrigin : ''),
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

    if (!env.GITHUB_PAT) {
      return json({ ok: false, error: 'GITHUB_PAT secret not configured' }, 500);
    }

    const ghHeaders = {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${env.GITHUB_PAT}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'seishokai-trigger-monitor',
    };

    // POST /trigger - workflow を起動
    if (url.pathname === '/trigger' && request.method === 'POST') {
      try {
        const ghRes = await fetch(
          `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
          {
            method: 'POST',
            headers: { ...ghHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: REF }),
          }
        );
        if (!ghRes.ok) {
          const detail = await ghRes.text();
          return json({ ok: false, error: 'GitHub API failed: ' + ghRes.status, detail }, 502);
        }
        // GitHub の workflow_dispatch は 204 No Content を返す
        return json({ ok: true, message: 'Workflow triggered (約4分後完了)' });
      } catch (e) {
        return json({ ok: false, error: 'fetch error: ' + (e.message || String(e)) }, 500);
      }
    }

    // GET /status - 直近の Workflow 実行状況を返す
    if (url.pathname === '/status' && request.method === 'GET') {
      try {
        const ghRes = await fetch(
          `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
          { method: 'GET', headers: ghHeaders }
        );
        if (!ghRes.ok) {
          const detail = await ghRes.text();
          return json({ ok: false, error: 'GitHub API failed: ' + ghRes.status, detail }, 502);
        }
        const data = await ghRes.json();
        const run = data.workflow_runs && data.workflow_runs[0];
        if (!run) return json({ ok: true, status: null });
        return json({
          ok: true,
          status: run.status,           // queued / in_progress / completed
          conclusion: run.conclusion,   // success / failure / cancelled / null
          updated_at: run.updated_at,
          run_started_at: run.run_started_at,
          html_url: run.html_url,
          event: run.event,             // workflow_dispatch / schedule
        });
      } catch (e) {
        return json({ ok: false, error: 'fetch error: ' + (e.message || String(e)) }, 500);
      }
    }

    return json({ ok: false, error: 'not found', path: url.pathname }, 404);
  },
};
