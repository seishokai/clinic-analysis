/**
 * Aladdin バグレポート → GitHub Issue 作成 Worker
 *
 * フロー:
 *  1. Aladdin フォーム送信 → Supabase INSERT admin_bug_reports
 *  2. フロントから POST /report {report_id} を Worker へ
 *  3. Worker が Supabase から詳細取得 → GitHub Issue 作成 → github_issue_url を UPDATE
 *  4. (v501) GAS 経由で NOTIFY_EMAIL_TO へメール通知 (Best-effort、失敗しても issue は作られる)
 *
 * 環境変数 (secret):
 *   GITHUB_PAT             — repo scope の Personal Access Token
 *   GITHUB_REPO            — seishokai/clinic-analysis
 *   SUPABASE_URL           — https://xxx.supabase.co
 *   SUPABASE_SERVICE_KEY   — service_role キー (RLS 迂回して安全に UPDATE)
 *   ALLOWED_ORIGIN         — https://seishokai.github.io (CORS)
 *   GAS_WEBAPP_URL         — kenshu-mailer 等の Apps Script Web App URL
 *   GAS_SECRET             — GAS 側 doPost で照合する共有シークレット
 *   NOTIFY_EMAIL_TO        — 通知先メール (カンマ区切りで複数可)。既定=tkm.koike@gmail.com
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

      // 5. v501: GAS 経由でメール通知 (Best-effort、失敗しても issue は返す)
      //   拓未さんが 修正依頼 に気付かず溜まる問題への対策。
      ctx.waitUntil(sendBugReportNotification(env, rpt, issueUrl).catch((e) => {
        console.warn('bug-report notify failed', e);
      }));

      return json({ ok: true, issue_url: issueUrl, issue_number: issue.number }, 200, okOrigin);
    } catch (e) {
      console.error('worker error', e);
      return json({ ok: false, error: String(e.message || e) }, 500, okOrigin);
    }
  },
};

// v501: GAS メーラー経由で通知メール送信
//   環境変数 GAS_WEBAPP_URL / GAS_SECRET / NOTIFY_EMAIL_TO が揃っている場合のみ送信。
//   contract: POST {secret, subject, html, text, recipients: [email...]}
async function sendBugReportNotification(env, rpt, issueUrl) {
  if (!env.GAS_WEBAPP_URL || !env.GAS_SECRET) return;
  const recipientsRaw = env.NOTIFY_EMAIL_TO || 'tkm.koike@gmail.com';
  const recipients = recipientsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) return;
  const prioIcon = { '至急': '🚨', '通常': '🐛', '低': '💤' }[rpt.priority] || '🐛';
  const subject = `${prioIcon}【Aladdin 修正依頼】${rpt.title}`;
  const escapeHtml = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  const brWrap = (s) => escapeHtml(s).replace(/\r?\n/g, '<br>');
  const adminUrl = 'https://seishokai.github.io/clinic-analysis/#/admin';
  const priorityColor = rpt.priority === '至急' ? '#dc2626' : rpt.priority === '通常' ? '#f59e0b' : '#94a3b8';
  const text = [
    '新しい Aladdin 修正依頼が届きました。',
    '',
    `【優先度】${rpt.priority || '通常'}`,
    `【該当画面】${rpt.screen || '不明'}`,
    `【送信者】${rpt.reporter_name || '匿名'}${rpt.reporter_email ? ` (${rpt.reporter_email})` : ''}`,
    `【タイトル】${rpt.title}`,
    '',
    '【詳細】',
    rpt.description || '(なし)',
    '',
    '── リンク ──',
    `Aladdin 管理画面: ${adminUrl}`,
    `GitHub Issue: ${issueUrl}`,
    `Supabase report_id: ${rpt.id}`,
  ].join('\n');
  const html = `<div style="font-family:'Hiragino Sans','Noto Sans JP','Meiryo',sans-serif;max-width:560px;margin:auto;color:#0f172a">
    <div style="background:linear-gradient(135deg,#fef3c7,#fde68a);border:1px solid #f59e0b;border-radius:12px 12px 0 0;padding:16px 20px">
      <div style="font-size:11px;color:#92400e;font-weight:700;letter-spacing:2px">ALADDIN BUG REPORT</div>
      <div style="font-size:18px;font-weight:800;color:#0f172a;margin-top:4px">🐛 新しい修正依頼が届きました</div>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:20px;font-size:14px;line-height:1.7;background:#fff">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="color:#64748b;width:80px;padding:4px 8px 4px 0;vertical-align:top">優先度</td>
            <td style="padding:4px 0"><span style="background:${priorityColor};color:#fff;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:800">${escapeHtml(rpt.priority || '通常')}</span></td></tr>
        <tr><td style="color:#64748b;padding:4px 8px 4px 0;vertical-align:top">該当画面</td>
            <td style="padding:4px 0;font-weight:600">${escapeHtml(rpt.screen || '不明')}</td></tr>
        <tr><td style="color:#64748b;padding:4px 8px 4px 0;vertical-align:top">送信者</td>
            <td style="padding:4px 0;font-weight:600">${escapeHtml(rpt.reporter_name || '匿名')}${rpt.reporter_email ? ` <span style="color:#64748b;font-weight:400">(${escapeHtml(rpt.reporter_email)})</span>` : ''}</td></tr>
        <tr><td style="color:#64748b;padding:4px 8px 4px 0;vertical-align:top">タイトル</td>
            <td style="padding:4px 0;font-weight:800;color:#0f172a;font-size:14px">${escapeHtml(rpt.title)}</td></tr>
      </table>
      <div style="margin-top:14px;padding:12px 14px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;line-height:1.6;color:#0f172a;white-space:pre-wrap;word-break:break-word">${brWrap(rpt.description || '(詳細なし)')}</div>
      ${rpt.screenshot_url ? `<div style="margin-top:12px"><a href="${escapeHtml(rpt.screenshot_url)}" style="color:#0369a1;text-decoration:underline;font-size:12px">📷 スクリーンショットを開く</a></div>` : ''}
      <div style="margin-top:20px;padding-top:14px;border-top:1px solid #e5e7eb;display:flex;gap:8px;flex-wrap:wrap">
        <a href="${escapeHtml(adminUrl)}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700;font-size:13px">📋 Aladdin で対応</a>
        <a href="${escapeHtml(issueUrl)}" style="display:inline-block;background:#fff;color:#0f172a;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700;font-size:13px;border:1px solid #d4d4d8">🔗 GitHub Issue</a>
      </div>
      <div style="margin-top:14px;font-size:10px;color:#94a3b8;letter-spacing:.3px">report_id: ${escapeHtml(rpt.id)}</div>
    </div>
  </div>`;
  const res = await fetch(env.GAS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ secret: env.GAS_SECRET, subject, html, text, recipients }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`GAS notify HTTP ${res.status}`);
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS(origin) },
  });
}
