/**
 * Aladdin バグレポート → GitHub Issue 作成 Worker
 *
 * フロー:
 *  1. Aladdin フォーム送信 → Supabase INSERT admin_bug_reports
 *  2. フロントから POST /report {report_id} を Worker へ
 *  3. Worker が Supabase から詳細取得 → GitHub Issue 作成 → github_issue_url を UPDATE
 *
 * 環境変数 (secret):
 *   GITHUB_PAT             — repo scope の Personal Access Token
 *   GITHUB_REPO            — seishokai/clinic-analysis
 *   SUPABASE_URL           — https://xxx.supabase.co
 *   SUPABASE_SERVICE_KEY   — service_role キー (RLS 迂回して安全に UPDATE)
 *   ALLOWED_ORIGIN         — https://seishokai.github.io (CORS)
 */

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.length === 0 || allowed.includes(origin) ? origin : allowed[0] || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS(okOrigin) });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS(okOrigin) });
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, error: 'invalid json' }, 400, okOrigin); }

    const { report_id } = body || {};
    if (!report_id) return json({ ok: false, error: 'report_id required' }, 400, okOrigin);

    try {
      // 1. Supabase から詳細取得
      const supUrl = `${env.SUPABASE_URL}/rest/v1/admin_bug_reports?id=eq.${encodeURIComponent(report_id)}&select=*`;
      const supRes = await fetch(supUrl, {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        },
      });
      if (!supRes.ok) throw new Error(`Supabase fetch failed: ${supRes.status}`);
      const rows = await supRes.json();
      const rpt = Array.isArray(rows) ? rows[0] : null;
      if (!rpt) return json({ ok: false, error: 'report not found' }, 404, okOrigin);

      // 既に issue 作成済みならスキップ
      if (rpt.github_issue_url) {
        return json({ ok: true, skipped: true, issue_url: rpt.github_issue_url }, 200, okOrigin);
      }

      // 2. GitHub Issue body 組み立て
      const prioIcon = { '至急': '🚨', '通常': '🐛', '低': '💤' }[rpt.priority] || '🐛';
      const title = `${prioIcon} [Aladdin] ${rpt.title}`;
      const bodyLines = [
        `**優先度:** ${rpt.priority}`,
        `**該当画面:** ${rpt.screen || '不明'}`,
        `**送信者:** ${rpt.reporter_name || '匿名'}${rpt.reporter_email ? ` (${rpt.reporter_email})` : ''}`,
        `**送信日時:** ${rpt.created_at}`,
        `**Supabase report_id:** \`${rpt.id}\``,
        '',
        '## 詳細',
        '',
        rpt.description,
        '',
      ];
      if (rpt.screenshot_url) {
        bodyLines.push('## スクリーンショット');
        bodyLines.push('');
        bodyLines.push(`![screenshot](${rpt.screenshot_url})`);
        bodyLines.push('');
      }
      bodyLines.push('---');
      bodyLines.push('_この Issue は Aladdin 修正依頼フォームから自動作成されました。_');
      bodyLines.push('_対応完了後は Supabase の admin_bug_reports.status を「解決」に更新してください。_');

      const issueBody = bodyLines.join('\n');
      const labels = ['aladdin-report'];
      if (rpt.priority === '至急') labels.push('priority:urgent');
      else if (rpt.priority === '通常') labels.push('priority:normal');
      else labels.push('priority:low');

      // 3. GitHub Issue 作成
      const ghUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/issues`;
      const ghRes = await fetch(ghUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GITHUB_PAT}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'aladdin-bug-reporter/1.0',
        },
        body: JSON.stringify({ title, body: issueBody, labels }),
      });
      if (!ghRes.ok) {
        const errTxt = await ghRes.text();
        console.error('GitHub error', ghRes.status, errTxt);
        return json({ ok: false, error: `GitHub API ${ghRes.status}: ${errTxt.slice(0, 200)}` }, 502, okOrigin);
      }
      const issue = await ghRes.json();
      const issueUrl = issue.html_url;

      // 4. Supabase UPDATE で github_issue_url を書き込み
      const updUrl = `${env.SUPABASE_URL}/rest/v1/admin_bug_reports?id=eq.${encodeURIComponent(report_id)}`;
      const updRes = await fetch(updUrl, {
        method: 'PATCH',
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ github_issue_url: issueUrl }),
      });
      if (!updRes.ok) {
        console.warn('Supabase UPDATE failed but issue was created:', await updRes.text());
      }

      return json({ ok: true, issue_url: issueUrl, issue_number: issue.number }, 200, okOrigin);
    } catch (e) {
      console.error('worker error', e);
      return json({ ok: false, error: String(e.message || e) }, 500, okOrigin);
    }
  },
};

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS(origin) },
  });
}
