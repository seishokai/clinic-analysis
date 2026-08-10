/* ============================================================
 * sheet-sync Worker
 *   Cron: 10 分ごと (wrangler.jsonc の triggers)
 *   HTTP: /status, /sync (手動トリガ、要 token)
 *
 * データフロー:
 *   Google Sheets (①○○初診 12 タブ) → gviz CSV
 *     → cutoff (2026-08-01) 以降の来院日 & 名前あり を抽出
 *     → Aladdin Supabase: patients (upsert) + patient_visits (dedup INSERT)
 *     → sync_log に集計
 *
 * 上書きポリシー:
 *   patient_visits は uidx_visits_dedup (facility, normalized_name, book_date)
 *   でユニーク → 既存行は onConflict do nothing で touch しない (v700 SQL 参照)
 * ============================================================ */

import CONFIG from '../config/sheet-tabs.js';

// ==================== Utils ====================
const normName = (n) => (n == null ? '' : String(n).replace(/[\s　]+/g, '').toLowerCase());

/**
 * 各種日付フォーマットを YYYY-MM-DD にパース
 *   - 2026/08/10, 2026-08-10 → そのまま
 *   - 8/10 (M/D)             → 現在年で補完
 *   - 26/8/10 (YY/M/D)       → 20XX で補完
 */
function toIsoDate(s, fallbackYear) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  // YYYY/MM/DD or YYYY-M-D
  let m = t.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  // YY/M/D (2-digit year) → 20YY
  m = t.match(/^(\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) {
    const yr = 2000 + Number(m[1]);
    return `${yr}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  // M/D or M-D (現在年 or fallback)
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    const yr = fallbackYear || new Date().getUTCFullYear();
    return `${yr}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  return null;
}

// ==================== CSV parser (quoted, embedded \n 対応) ====================
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { inQuote = false; }
      } else {
        cell += c;
      }
    } else {
      if (c === '"') { inQuote = true; }
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else {
        cell += c;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

// ==================== Sheet tab loader ====================
async function fetchTabCsv(sheetId, tabName) {
  const enc = encodeURIComponent(tabName);
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${enc}`;
  const res = await fetch(url, { headers: { 'user-agent': 'sheet-sync/1.0' } });
  if (!res.ok) throw new Error(`gviz fetch failed: ${res.status} ${tabName}`);
  return res.text();
}

/**
 * ヘッダ行から (visit_date, name, source, ...) の列 index を検出
 * @param {string[]} headers row[0]
 * @param {Record<string,string[]>} aliases HEADER_ALIASES
 */
function detectColumns(headers, aliases) {
  const cols = {};
  for (const key of Object.keys(aliases)) {
    const names = aliases[key];
    const idx = headers.findIndex(h => names.includes(String(h || '').trim()));
    cols[key] = idx >= 0 ? idx : null;
  }
  return cols;
}

// ==================== 1 タブ分の同期 ====================
async function syncOneTab(env, tab, aliases, cutoffIso) {
  const csv = await fetchTabCsv(env.SHEET_ID, tab.name);
  const rows = parseCsv(csv);
  if (rows.length < 2) return { name: tab.name, read: 0, inserted: 0, skipped: 0, error: 0 };

  // 列 index を決定 (manual columns が優先、なければ auto detect)
  const cols = tab.columns || detectColumns(rows[0], aliases);

  // visit_date & name の列がない → skip
  if (cols.visit_date == null || cols.name == null) {
    return { name: tab.name, read: 0, inserted: 0, skipped: 0, error: 1, note: 'visit_date/name 列を検出できず' };
  }

  const now = new Date();
  const currentYear = now.getUTCFullYear();

  const candidates = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawDate = r[cols.visit_date];
    const rawName = r[cols.name];
    if (!rawDate || !rawName) continue;

    const iso = toIsoDate(rawDate, currentYear);
    if (!iso || iso < cutoffIso) continue;

    const nn = normName(rawName);
    if (!nn) continue;

    candidates.push({
      book_date: iso,
      patient_name: String(rawName).trim(),
      normalized_name: nn,
      facility: tab.facility,
      source_channel: cols.source != null ? String(r[cols.source] || '').trim() || null : null,
      reason: cols.reason != null ? String(r[cols.reason] || '').trim() || null : null,
      staff: cols.staff != null ? String(r[cols.staff] || '').trim() || null : null,
      doctor: cols.doctor != null ? String(r[cols.doctor] || '').trim() || null : null,
      phone: cols.phone != null ? String(r[cols.phone] || '').replace(/\D/g, '') || null : null,
      sync_source: `sheet:${tab.name}:row=${i + 1}`,
      sheet_row: i + 1,
    });
  }

  if (candidates.length === 0) return { name: tab.name, read: 0, inserted: 0, skipped: 0, error: 0 };

  // Supabase upsert (dedup on unique index → 既存行はスキップ、新規のみ INSERT)
  let inserted = 0, skipped = 0, errored = 0;
  for (const c of candidates) {
    // patients を先に upsert (normalized_name で照合、facility は比較に使わない
    //   ← DB は「BF銀座歯科・矯正歯科」等のフル名、シートは短縮名で不一致するため)
    let patientId;
    try {
      // 1) 既存 patient を探す (電話下 4 桁あれば優先マッチ)
      const nnQ = encodeURIComponent(c.normalized_name);
      const phoneQ = c.phone ? `&phone_last4=eq.${encodeURIComponent(c.phone.slice(-4))}` : '';
      const r1 = await fetch(
        `${env.SUPABASE_URL}/rest/v1/patients?normalized_name=eq.${nnQ}${phoneQ}&limit=1`,
        { headers: sbHeaders(env) }
      );
      const existing = await r1.json();
      if (Array.isArray(existing) && existing.length > 0) {
        patientId = existing[0].id;
      } else if (c.phone) {
        // 電話マッチで見つからなければ、name だけで再検索
        const r1b = await fetch(
          `${env.SUPABASE_URL}/rest/v1/patients?normalized_name=eq.${nnQ}&limit=1`,
          { headers: sbHeaders(env) }
        );
        const ex2 = await r1b.json();
        if (Array.isArray(ex2) && ex2.length > 0) patientId = ex2[0].id;
      }

      if (!patientId) {
        // 2) 新規 patient
        const r2 = await fetch(
          `${env.SUPABASE_URL}/rest/v1/patients`,
          {
            method: 'POST',
            headers: { ...sbHeaders(env), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
            body: JSON.stringify({
              name: c.patient_name,
              normalized_name: c.normalized_name,
              primary_facility: c.facility,
              phone: c.phone || null,
              phone_last4: c.phone ? c.phone.slice(-4) : null,
            }),
          }
        );
        if (!r2.ok) {
          errored++;
          continue;
        }
        const created = await r2.json();
        patientId = Array.isArray(created) ? created[0]?.id : created?.id;
      }
    } catch (_) {
      errored++;
      continue;
    }
    if (!patientId) { errored++; continue; }

    // 3) patient_visits INSERT (uidx_visits_dedup で既存行あれば 409 → skip)
    //   v701: patient_visits には normalized_name / patient_name カラム無し
    //         (それらは patients 側)。patient_id + facility + book_date で dedup
    //         apply_at / apply_date は NOT NULL なので book_date から補完
    const bookAtIso = `${c.book_date}T00:00:00+09:00`;
    const visitPayload = {
      patient_id: patientId,
      facility: c.facility,
      book_date: c.book_date,
      book_at: bookAtIso,
      apply_date: c.book_date,   // シートには申込日欠落 → 来院日で代用
      apply_at: bookAtIso,
      status: '未対応',
      source_tool: 'sheet',
      source_channel: c.source_channel,
      sync_source: c.sync_source,
      updated_by: 'system-sync',
      created_by: 'system-sync',
    };
    const r3 = await fetch(
      `${env.SUPABASE_URL}/rest/v1/patient_visits`,
      {
        method: 'POST',
        headers: {
          ...sbHeaders(env),
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal,resolution=ignore-duplicates',
        },
        body: JSON.stringify(visitPayload),
      }
    );
    if (r3.status === 201) inserted++;
    else if (r3.status === 200 || r3.status === 409) skipped++;
    else {
      errored++;
      // console.warn 相当 (Worker log)
      console.log('visit insert failed', r3.status, await r3.text());
    }
  }

  return {
    name: tab.name,
    read: candidates.length,
    inserted, skipped, error: errored,
  };
}

// Supabase REST 共通ヘッダ
function sbHeaders(env) {
  return {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  };
}

// ==================== メイン sync ====================
async function runSync(env, triggerName) {
  const startMs = Date.now();
  const cutoffIso = env.CUTOFF_DATE || CONFIG.cutoff_date;
  const aliases = CONFIG.header_aliases;

  const details = [];
  let tabsRead = 0, rowsRead = 0, rowsInserted = 0, rowsSkipped = 0, rowsError = 0;

  for (const tab of CONFIG.tabs) {
    try {
      const r = await syncOneTab(env, tab, aliases, cutoffIso);
      details.push(r);
      tabsRead++;
      rowsRead += r.read;
      rowsInserted += r.inserted;
      rowsSkipped += r.skipped;
      rowsError += r.error;
    } catch (e) {
      details.push({ name: tab.name, error: 1, note: String(e.message || e) });
      rowsError++;
    }
  }

  const durationMs = Date.now() - startMs;

  // sync_log に記録
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/sync_log`, {
      method: 'POST',
      headers: { ...sbHeaders(env), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        trigger: triggerName,
        tabs_read: tabsRead,
        rows_read: rowsRead,
        rows_inserted: rowsInserted,
        rows_skipped: rowsSkipped,
        rows_error: rowsError,
        duration_ms: durationMs,
        details,
      }),
    });
  } catch (_) { /* log 失敗は無視 */ }

  return { tabsRead, rowsRead, rowsInserted, rowsSkipped, rowsError, durationMs, details };
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
      // 手動同期 (token 検証)
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
      // 最新の sync_log を返す
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
