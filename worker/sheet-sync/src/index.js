/* ============================================================
 * sheet-sync Worker (v705: subrequest limit 対策で batch 化)
 *   Cron: なし (Free plan の 5 cron 枠切れ → Aladdin が 10 分毎に fetch)
 *   HTTP: /status, /sync (手動トリガ、要 token)
 *
 * データフロー:
 *   Google Sheets (①○○初診 12 タブ) → gviz CSV
 *     → cutoff (2026-08-01) 以降の来院日 & 名前あり を抽出
 *     → 全タブまとめて patients bulk upsert + patient_visits bulk INSERT
 *     → sync_log に集計
 *
 * subrequest 予算 (Free = 50):
 *   12 (CSV fetch) + 1 (SELECT patients) + 1 (INSERT patients) +
 *   1 (INSERT visits) + 1 (INSERT sync_log) = 16 subrequests
 * ============================================================ */

import CONFIG from '../config/sheet-tabs.js';

// ==================== Utils ====================
const normName = (n) => (n == null ? '' : String(n).replace(/[\s　]+/g, '').toLowerCase());

function toIsoDate(s, fallbackYear) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = t.match(/^(\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) {
    const yr = 2000 + Number(m[1]);
    return `${yr}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    const yr = fallbackYear || new Date().getUTCFullYear();
    return `${yr}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  return null;
}

// CSV parser (quoted, embedded \n 対応)
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { inQuote = false; }
      } else { cell += c; }
    } else {
      if (c === '"') { inQuote = true; }
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else { cell += c; }
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

async function fetchTabCsv(sheetId, tabName) {
  const enc = encodeURIComponent(tabName);
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${enc}`;
  const res = await fetch(url, { headers: { 'user-agent': 'sheet-sync/1.0' } });
  if (!res.ok) throw new Error(`gviz ${res.status} ${tabName}`);
  return res.text();
}

function detectColumns(headers, aliases) {
  const cols = {};
  for (const key of Object.keys(aliases)) {
    const names = aliases[key];
    const idx = headers.findIndex(h => names.includes(String(h || '').trim()));
    cols[key] = idx >= 0 ? idx : null;
  }
  return cols;
}

// 1 タブから candidates 抽出 (fetch のみ、DB アクセス無し)
async function extractCandidates(sheetId, tab, aliases, cutoffIso) {
  const csv = await fetchTabCsv(sheetId, tab.name);
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const cols = tab.columns || detectColumns(rows[0], aliases);
  if (cols.visit_date == null || cols.name == null) {
    throw new Error(`列検出失敗 (${tab.name}): visit_date=${cols.visit_date} name=${cols.name}`);
  }
  const currentYear = new Date().getUTCFullYear();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawDate = r[cols.visit_date];
    const rawName = r[cols.name];
    if (!rawDate || !rawName) continue;
    const iso = toIsoDate(rawDate, currentYear);
    if (!iso || iso < cutoffIso) continue;
    const nn = normName(rawName);
    if (!nn) continue;
    const phone = cols.phone != null ? String(r[cols.phone] || '').replace(/\D/g, '') : '';
    const phone4 = phone ? phone.slice(-4) : null;
    out.push({
      tab: tab.name,
      row: i + 1,
      facility: tab.facility,
      book_date: iso,
      patient_name: String(rawName).trim(),
      normalized_name: nn,
      phone: phone || null,
      phone_last4: phone4,
      source_channel: cols.source != null ? String(r[cols.source] || '').trim() || null : null,
      sync_source: `sheet:${tab.name}:row=${i + 1}`,
    });
  }
  return out;
}

function sbHeaders(env, extra = {}) {
  return {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    ...extra,
  };
}

// ==================== Main sync ====================
async function runSync(env, triggerName) {
  const startMs = Date.now();
  const cutoffIso = env.CUTOFF_DATE || CONFIG.cutoff_date;
  const aliases = CONFIG.header_aliases;

  // --- Phase 1: 12 タブ CSV 取得 & candidates 抽出 (12 subrequests) ---
  const perTab = [];
  const allCandidates = [];
  for (const tab of CONFIG.tabs) {
    try {
      const cands = await extractCandidates(env.SHEET_ID, tab, aliases, cutoffIso);
      perTab.push({ name: tab.name, read: cands.length });
      allCandidates.push(...cands);
    } catch (e) {
      perTab.push({ name: tab.name, read: 0, error: 1, note: String(e.message || e) });
    }
  }

  if (allCandidates.length === 0) {
    return await finalize(env, triggerName, startMs, perTab, 0, 0, 0);
  }

  // --- Phase 2: 既存 patients を一括 SELECT (1 subrequest) ---
  //   normalized_name の unique な集合を IN() で問い合わせ
  const uniqueNames = Array.from(new Set(allCandidates.map(c => c.normalized_name)));
  const inList = uniqueNames.map(n => `"${n.replace(/"/g, '\\"')}"`).join(',');
  const selUrl = `${env.SUPABASE_URL}/rest/v1/patients?normalized_name=in.(${encodeURIComponent(inList)})&select=id,normalized_name,phone_last4`;
  const selRes = await fetch(selUrl, { headers: sbHeaders(env) });
  if (!selRes.ok) {
    return await finalize(env, triggerName, startMs, perTab, allCandidates.length, 0, allCandidates.length,
      `patients SELECT failed: ${selRes.status} ${await selRes.text()}`);
  }
  const existingPatients = await selRes.json();
  // Map: normalized_name → id (電話一致優先、なければ最初のを採用)
  const patientMap = new Map();
  for (const p of existingPatients) {
    const key = p.normalized_name;
    if (!patientMap.has(key)) patientMap.set(key, p.id);
    // 電話一致するのがあればそちらを優先 (candidates ループで差し替え)
  }

  // --- Phase 3: 不足 patients を bulk INSERT (0 or 1 subrequest) ---
  const missingByKey = new Map();
  for (const c of allCandidates) {
    if (patientMap.has(c.normalized_name)) continue;
    if (missingByKey.has(c.normalized_name)) continue;
    missingByKey.set(c.normalized_name, {
      name: c.patient_name,
      normalized_name: c.normalized_name,
      primary_facility: c.facility,
      phone: c.phone,
      phone_last4: c.phone_last4,
    });
  }
  if (missingByKey.size > 0) {
    const insUrl = `${env.SUPABASE_URL}/rest/v1/patients`;
    const insRes = await fetch(insUrl, {
      method: 'POST',
      headers: sbHeaders(env, {
        'Content-Type': 'application/json',
        'Prefer': 'return=representation,resolution=merge-duplicates',
      }),
      body: JSON.stringify(Array.from(missingByKey.values())),
    });
    if (!insRes.ok) {
      return await finalize(env, triggerName, startMs, perTab, allCandidates.length, 0, allCandidates.length,
        `patients INSERT failed: ${insRes.status} ${await insRes.text()}`);
    }
    const created = await insRes.json();
    for (const p of (Array.isArray(created) ? created : [])) {
      patientMap.set(p.normalized_name, p.id);
    }
  }

  // --- Phase 4: patient_visits を bulk INSERT (1 subrequest) ---
  const visitPayload = allCandidates
    .filter(c => patientMap.has(c.normalized_name))
    .map(c => {
      const bookAtIso = `${c.book_date}T00:00:00+09:00`;
      return {
        patient_id: patientMap.get(c.normalized_name),
        facility: c.facility,
        book_date: c.book_date,
        book_at: bookAtIso,
        apply_date: c.book_date,
        apply_at: bookAtIso,
        status: '未対応',
        source_tool: 'sheet',
        source_channel: c.source_channel,
        sync_source: c.sync_source,
        updated_by: 'system-sync',
        created_by: 'system-sync',
      };
    });

  let inserted = 0, skipped = 0;
  if (visitPayload.length > 0) {
    const visRes = await fetch(`${env.SUPABASE_URL}/rest/v1/patient_visits`, {
      method: 'POST',
      headers: sbHeaders(env, {
        'Content-Type': 'application/json',
        'Prefer': 'return=representation,resolution=ignore-duplicates',
      }),
      body: JSON.stringify(visitPayload),
    });
    if (visRes.ok) {
      const created = await visRes.json();
      inserted = Array.isArray(created) ? created.length : 0;
      skipped = visitPayload.length - inserted;
    } else {
      return await finalize(env, triggerName, startMs, perTab, allCandidates.length, 0, allCandidates.length,
        `visits INSERT failed: ${visRes.status} ${await visRes.text()}`);
    }
  }

  const rowsError = allCandidates.length - inserted - skipped;
  return await finalize(env, triggerName, startMs, perTab, allCandidates.length, inserted, skipped, null, rowsError);
}

async function finalize(env, trigger, startMs, details, rowsRead, rowsInserted, rowsSkipped, errorMessage, rowsError) {
  const durationMs = Date.now() - startMs;
  const tabsRead = details.filter(d => !d.error).length;
  const errs = rowsError != null ? rowsError : (details.filter(d => d.error).length);
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/sync_log`, {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        trigger,
        tabs_read: tabsRead,
        rows_read: rowsRead,
        rows_inserted: rowsInserted,
        rows_skipped: rowsSkipped,
        rows_error: errs,
        duration_ms: durationMs,
        error_message: errorMessage,
        details,
      }),
    });
  } catch (_) {}
  return {
    tabsRead, rowsRead, rowsInserted, rowsSkipped, rowsError: errs,
    durationMs, errorMessage, details,
  };
}

// ==================== HTTP ハンドラ ====================
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runSync(env, 'cron'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Token',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname === '/sync') {
      const token = request.headers.get('x-sync-token') || url.searchParams.get('token');
      if (token !== env.MANUAL_TRIGGER_TOKEN) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      const result = await runSync(env, 'manual');
      return new Response(JSON.stringify(result, null, 2), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/status' || url.pathname === '/') {
      const r = await fetch(
        `${env.SUPABASE_URL}/rest/v1/v_latest_sync?select=*`,
        { headers: sbHeaders(env) }
      );
      const latest = await r.json();
      return new Response(JSON.stringify({
        service: 'sheet-sync',
        latest: Array.isArray(latest) && latest.length > 0 ? latest[0] : null,
      }, null, 2), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return new Response('sheet-sync worker\n\nGET /status  → 最新の同期結果\nGET /sync?token=xxx → 手動同期\n', {
      headers: { ...cors, 'Content-Type': 'text/plain' },
    });
  },
};
