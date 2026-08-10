/* ============================================================
 * sheet-sync Worker v900
 *   Cron: なし (Aladdin ブラウザから 10 分毎 fetch)
 *   HTTP: /status, /sync (手動、要 token), /debug
 *
 * v900 の設計:
 *
 *   Phase A: 予約管理シート (BOOKING_SHEET) → patient_visits INSERT
 *      - 5 タブ (元データ + 4 セレクト) を fetch
 *      - source_tool='DXHUB' or 'セレクト' で INSERT
 *      - status='未対応' (来院待ち)
 *      - sync_source='booking:<tab>:row=<N>' で dedup
 *
 *   Phase B: 初診管理シート (SHEET) → 来院確認 & 直予約追加
 *      - 予約行あり (Phase A で入ったもの or migrate:v600)
 *        + 未編集 → 「検討中」に UPDATE
 *      - 予約行なし → 「検討中」で INSERT (直予約 walk-in)
 *      - 保険初診 → 「治療中」
 *      - 触った行 (実ユーザ email) → SKIP
 *
 * subrequest budget (Free 50):
 *   5 (booking CSV) + 12 (initial CSV) + 10 (patients) +
 *   1 (visits SELECT) + 15 (INSERT/UPDATE batches) + 1 (sync_log) ≈ 44
 * ============================================================ */

import CONFIG from '../config/sheet-tabs.js';

// ==================== Utils ====================
const normName = (n) => (n == null ? '' : String(n).replace(/[\s　]+/g, '').toLowerCase());

function normFac(f) {
  if (!f) return '';
  const s = String(f);
  if (s.includes('BF銀座')) return 'BF銀座';
  if (s.includes('銀座'))   return 'BF銀座';
  if (s.includes('中日'))   return 'BF中日';
  if (s.includes('BF'))     return 'BF銀座';
  if (s.includes('エスカ')) return 'エスカ';
  if (s.includes('アール')) return 'アール';
  if (s.includes('ウィズ')) return 'ウィズ';
  if (s.includes('ルミナス'))return 'ルミナス';
  if (s.includes('茶屋'))   return '茶屋';
  if (s.includes('アサノ')) return 'アサノ';
  if (s.includes('知立'))   return '知立';
  if (s.includes('小牧'))   return '小牧';
  if (s.includes('八事'))   return '八事';
  if (s.includes('岩田'))   return '岩田';
  if (s.includes('大森'))   return '大森';
  if (s.includes('京都'))   return '京都';
  if (s.includes('訪問'))   return '訪問';
  return s;
}

// M/D or YYYY/M/D → ISO date. M/D は当年度、未来日は前年扱い
function toIsoDate(s, fallbackYear) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = t.match(/^(\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${2000 + Number(m[1])}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    const now = new Date();
    const yr = fallbackYear || now.getUTCFullYear();
    const d = new Date(yr, Number(m[1]) - 1, Number(m[2]));
    if (d > now) d.setFullYear(yr - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

// v900: 「2026年8月10日(土) 14時30分」 形式の日本語日時 → ISO date & ISO datetime
function parseJpDateTime(s) {
  if (!s) return { date: null, at: null };
  const t = String(s).trim();
  if (!t) return { date: null, at: null };
  const m = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:\([^)]*\))?\s*(\d{1,2})?時?(\d{1,2})?/);
  if (m) {
    const y = m[1], mo = String(m[2]).padStart(2, '0'), d = String(m[3]).padStart(2, '0');
    const hh = String(m[4] || 0).padStart(2, '0'), mi = String(m[5] || 0).padStart(2, '0');
    return { date: `${y}-${mo}-${d}`, at: `${y}-${mo}-${d}T${hh}:${mi}:00+09:00` };
  }
  // Fallback: 2026/8/16 9:30 形式
  const m2 = t.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s*(\d{1,2})?:?(\d{1,2})?/);
  if (m2) {
    const y = m2[1], mo = String(m2[2]).padStart(2, '0'), d = String(m2[3]).padStart(2, '0');
    const hh = String(m2[4] || 0).padStart(2, '0'), mi = String(m2[5] || 0).padStart(2, '0');
    return { date: `${y}-${mo}-${d}`, at: `${y}-${mo}-${d}T${hh}:${mi}:00+09:00` };
  }
  return { date: null, at: null };
}

function hashSec(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h) % 86400;
}

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

function sbHeaders(env, extra = {}) {
  return {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    ...extra,
  };
}

function isTouched(visit) {
  if (visit.status && visit.status !== '未対応') return true;
  if (visit.memo != null && String(visit.memo).length > 0) return true;
  if (visit.contract_amount != null && Number(visit.contract_amount) > 0) return true;
  if (visit.next_visit_date != null) return true;
  const u = visit.updated_by;
  if (u && String(u).includes('@')) return true;   // email 形式のみ実ユーザ
  return false;
}

function statusFromReason(reason) {
  if (!reason) return '検討中';
  return String(reason).includes('保険初診') ? '治療中' : '検討中';
}

// ==================== 予約管理シート extractor (v900) ====================
async function extractBookingCandidates(sheetId, tab, cutoffIso) {
  const csv = await fetchTabCsv(sheetId, tab.name);
  const rows = parseCsv(csv);
  const startRow = tab.has_header ? 1 : 0;
  if (rows.length < startRow + 1) return [];
  const cols = tab.cols;
  const out = [];
  for (let i = startRow; i < rows.length; i++) {
    const r = rows[i];
    const rawBookAt = r[cols.book_at];
    const rawName = r[cols.name];
    if (!rawBookAt || !rawName) continue;
    const { date: bookDate, at: bookAt } = parseJpDateTime(rawBookAt);
    if (!bookDate || bookDate < cutoffIso) continue;
    const nn = normName(rawName);
    if (!nn) continue;
    // Facility 決定 — DXHUB は col 4 から動的、セレクトはタブ設定固定
    const facility = tab.facility || (cols.facility != null ? normFac(r[cols.facility]) : null);
    if (!facility) continue;
    const phone = cols.phone != null ? String(r[cols.phone] || '').replace(/\D/g, '') : '';
    out.push({
      tab: tab.name,
      row: i + 1,
      tool: tab.tool,               // 'DXHUB' or 'セレクト'
      facility,
      book_date: bookDate,
      book_at: bookAt,
      patient_name: String(rawName).trim(),
      normalized_name: nn,
      phone: phone || null,
      phone_last4: phone ? phone.slice(-4) : null,
      email: cols.email != null ? String(r[cols.email] || '').trim() || null : null,
      service: cols.service != null ? String(r[cols.service] || '').trim() || null : null,
      promo_code: cols.promo_code != null ? String(r[cols.promo_code] || '').trim() || null : null,
      sync_source: `booking:${tab.name}:row=${i + 1}`,
    });
  }
  return out;
}

// ==================== 初診管理シート extractor (v802 と同じ) ====================
async function extractInitialCandidates(sheetId, tab, aliases, cutoffIso) {
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
    out.push({
      tab: tab.name,
      row: i + 1,
      facility: tab.facility,
      book_date: iso,
      patient_name: String(rawName).trim(),
      normalized_name: nn,
      phone: phone || null,
      phone_last4: phone ? phone.slice(-4) : null,
      source_channel: cols.source != null ? String(r[cols.source] || '').trim() || null : null,
      reason: cols.reason != null ? String(r[cols.reason] || '').trim() || null : null,
      sync_source: `sheet:${tab.name}:row=${i + 1}`,
    });
  }
  return out;
}

// ==================== Main sync (v900) ====================
async function runSync(env, triggerName) {
  const startMs = Date.now();
  const cutoffIso = env.CUTOFF_DATE || CONFIG.cutoff_date;
  const aliases = CONFIG.header_aliases;

  // ---- Phase 1: 予約管理シート candidates 抽出 ----
  const bookingCandidates = [];
  const bookingPerTab = [];
  for (const tab of CONFIG.booking_tabs || []) {
    try {
      const cands = await extractBookingCandidates(CONFIG.booking_sheet_id, tab, cutoffIso);
      bookingPerTab.push({ name: tab.name, read: cands.length });
      bookingCandidates.push(...cands);
    } catch (e) {
      bookingPerTab.push({ name: tab.name, read: 0, error: 1, note: String(e.message || e) });
    }
  }

  // ---- Phase 2: 初診管理シート candidates 抽出 ----
  const initialCandidates = [];
  const initialPerTab = [];
  for (const tab of CONFIG.tabs) {
    try {
      const cands = await extractInitialCandidates(CONFIG.sheet_id, tab, aliases, cutoffIso);
      initialPerTab.push({ name: tab.name, read: cands.length });
      initialCandidates.push(...cands);
    } catch (e) {
      initialPerTab.push({ name: tab.name, read: 0, error: 1, note: String(e.message || e) });
    }
  }

  const allCandidates = [...bookingCandidates, ...initialCandidates];
  if (allCandidates.length === 0) {
    return await finalize(env, triggerName, startMs, bookingPerTab, initialPerTab, 0, 0, 0, 0, 0, 0);
  }

  // ---- Phase 3: patients SELECT (chunked) ----
  const uniqueNames = Array.from(new Set(allCandidates.map(c => c.normalized_name)));
  const CHUNK = 200;
  const patientMap = new Map();
  for (let i = 0; i < uniqueNames.length; i += CHUNK) {
    const chunk = uniqueNames.slice(i, i + CHUNK);
    const inList = chunk.map(n => `"${n.replace(/"/g, '\\"')}"`).join(',');
    const selUrl = `${env.SUPABASE_URL}/rest/v1/patients?normalized_name=in.(${encodeURIComponent(inList)})&select=id,normalized_name`;
    const selRes = await fetch(selUrl, { headers: sbHeaders(env) });
    if (!selRes.ok) {
      return await finalize(env, triggerName, startMs, bookingPerTab, initialPerTab, 0, 0, 0, 0, 0, allCandidates.length,
        `patients SELECT chunk ${i} failed: ${selRes.status} ${await selRes.text()}`);
    }
    const existing = await selRes.json();
    for (const p of existing) if (!patientMap.has(p.normalized_name)) patientMap.set(p.normalized_name, p.id);
  }

  // ---- Phase 4: 不足 patients を bulk INSERT ----
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
    const arr = Array.from(missingByKey.values());
    const BATCH = 100;
    for (let i = 0; i < arr.length; i += BATCH) {
      const batch = arr.slice(i, i + BATCH);
      const insRes = await fetch(`${env.SUPABASE_URL}/rest/v1/patients`, {
        method: 'POST',
        headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=representation,resolution=merge-duplicates' }),
        body: JSON.stringify(batch),
      });
      if (!insRes.ok) {
        return await finalize(env, triggerName, startMs, bookingPerTab, initialPerTab, 0, 0, 0, 0, 0, allCandidates.length,
          `patients INSERT batch ${i} failed: ${insRes.status} ${await insRes.text()}`);
      }
      const created = await insRes.json();
      for (const p of (Array.isArray(created) ? created : [])) patientMap.set(p.normalized_name, p.id);
    }
  }

  // ---- Phase 5: 予約管理シート → patient_visits INSERT (dedup on sync_source) ----
  let bookingInserted = 0;
  const bookingPayload = bookingCandidates
    .filter(c => patientMap.has(c.normalized_name))
    .map(c => {
      const sec = hashSec(c.sync_source);
      const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
      const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      const applyAtIso = `${c.book_date}T${hh}:${mm}:${ss}+09:00`;
      return {
        patient_id: patientMap.get(c.normalized_name),
        facility: c.facility,
        book_date: c.book_date,
        book_at: c.book_at,
        apply_date: c.book_date,
        apply_at: applyAtIso,
        status: '未対応',
        service: c.service,
        source_tool: c.tool,           // 'DXHUB' or 'セレクト'
        promo_code: c.promo_code,
        sync_source: c.sync_source,
        updated_by: 'system-sync',
        created_by: 'system-sync',
      };
    });
  const BATCH_B = 200;
  for (let i = 0; i < bookingPayload.length; i += BATCH_B) {
    const batch = bookingPayload.slice(i, i + BATCH_B);
    // sync_source unique index (uidx_visits_sync_source) + patient_id,apply_at unique key の両方に対応するため
    // ignore-duplicates 使用。target は指定しない → PostgREST が best-effort で ON CONFLICT DO NOTHING
    const iRes = await fetch(`${env.SUPABASE_URL}/rest/v1/patient_visits?on_conflict=sync_source`, {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=representation,resolution=ignore-duplicates' }),
      body: JSON.stringify(batch),
    });
    if (iRes.ok) {
      const created = await iRes.json();
      bookingInserted += Array.isArray(created) ? created.length : 0;
    } else {
      console.log('booking INSERT batch failed', iRes.status, await iRes.text());
    }
  }

  // ---- Phase 6: 初診管理シート → マッチ + UPDATE/INSERT ----
  //   Phase 5 が終わってから existing visits を SELECT (新規 booking 行も含む fresh pool)
  const visSelUrl = `${env.SUPABASE_URL}/rest/v1/patient_visits?book_date=gte.${cutoffIso}&deleted=eq.false&select=id,patient_id,facility,book_date,status,memo,contract_amount,next_visit_date,updated_by,source_tool`;
  const visRes = await fetch(visSelUrl, { headers: sbHeaders(env) });
  if (!visRes.ok) {
    return await finalize(env, triggerName, startMs, bookingPerTab, initialPerTab, bookingInserted, 0, 0, 0, 0, initialCandidates.length,
      `visits SELECT failed: ${visRes.status} ${await visRes.text()}`);
  }
  const existingVisits = await visRes.json();

  const visitsByKey = new Map();
  for (const v of existingVisits) {
    const key = `${v.patient_id}|${normFac(v.facility)}|${v.book_date}`;
    if (!visitsByKey.has(key)) visitsByKey.set(key, []);
    visitsByKey.get(key).push(v);
  }

  const toUpdate = [];
  const toInsert = [];
  let skippedTouched = 0;
  for (const c of initialCandidates) {
    const patientId = patientMap.get(c.normalized_name);
    if (!patientId) continue;
    const key = `${patientId}|${c.facility}|${c.book_date}`;
    const matches = visitsByKey.get(key) || [];
    if (matches.length > 0) {
      const untouched = matches.filter(m => !isTouched(m));
      if (untouched.length > 0) {
        for (const u of untouched) toUpdate.push(u.id);
      } else {
        skippedTouched++;
      }
    } else {
      toInsert.push({ candidate: c, patient_id: patientId, status: statusFromReason(c.reason) });
    }
  }

  // ---- Phase 7: UPDATE (予約行 → 検討中) ----
  let updated = 0;
  const BATCH_U = 200;
  for (let i = 0; i < toUpdate.length; i += BATCH_U) {
    const ids = toUpdate.slice(i, i + BATCH_U);
    const idList = ids.map(id => `"${id}"`).join(',');
    const patchUrl = `${env.SUPABASE_URL}/rest/v1/patient_visits?id=in.(${encodeURIComponent(idList)})`;
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify({ status: '検討中', updated_by: 'sheet-came' }),
    });
    if (patchRes.ok) {
      const updatedRows = await patchRes.json();
      updated += Array.isArray(updatedRows) ? updatedRows.length : 0;
    } else {
      console.log('visits UPDATE batch failed', patchRes.status, await patchRes.text());
    }
  }

  // ---- Phase 8: INSERT (直予約 walk-in) ----
  let walkinInserted = 0;
  const insPayload = toInsert.map(({ candidate: c, patient_id, status }) => {
    const sec = hashSec(c.sync_source);
    const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    const applyAtIso = `${c.book_date}T${hh}:${mm}:${ss}+09:00`;
    const bookAtIso = `${c.book_date}T00:00:00+09:00`;
    return {
      patient_id,
      facility: c.facility,
      book_date: c.book_date,
      book_at: bookAtIso,
      apply_date: c.book_date,
      apply_at: applyAtIso,
      status,
      service: c.reason,
      source_tool: 'sheet-direct',
      source_channel: c.source_channel,
      sync_source: c.sync_source,
      updated_by: 'sheet-direct',
      created_by: 'sheet-direct',
    };
  });
  const BATCH_W = 200;
  for (let i = 0; i < insPayload.length; i += BATCH_W) {
    const batch = insPayload.slice(i, i + BATCH_W);
    const iRes = await fetch(`${env.SUPABASE_URL}/rest/v1/patient_visits?on_conflict=sync_source`, {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=representation,resolution=ignore-duplicates' }),
      body: JSON.stringify(batch),
    });
    if (iRes.ok) {
      const created = await iRes.json();
      walkinInserted += Array.isArray(created) ? created.length : 0;
    } else {
      console.log('walk-in INSERT batch failed', iRes.status, await iRes.text());
    }
  }

  return await finalize(env, triggerName, startMs, bookingPerTab, initialPerTab,
    bookingInserted, updated, walkinInserted, skippedTouched,
    bookingCandidates.length + initialCandidates.length);
}

async function finalize(env, trigger, startMs, bookingPerTab, initialPerTab,
                        bookingInserted, initialUpdated, walkinInserted, skippedTouched, rowsRead, rowsError, errorMessage) {
  const durationMs = Date.now() - startMs;
  const errs = rowsError || 0;
  const tabsRead = (bookingPerTab.filter(d => !d.error).length) + (initialPerTab.filter(d => !d.error).length);
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/sync_log`, {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        trigger,
        tabs_read: tabsRead,
        rows_read: rowsRead || 0,
        rows_inserted: (bookingInserted || 0) + (walkinInserted || 0),
        rows_skipped: (initialUpdated || 0) + (skippedTouched || 0),
        rows_error: errs,
        duration_ms: durationMs,
        error_message: errorMessage,
        details: {
          booking: { perTab: bookingPerTab, inserted: bookingInserted || 0 },
          initial: { perTab: initialPerTab, updated: initialUpdated || 0, walkin: walkinInserted || 0, skipped_touched: skippedTouched || 0 },
        },
      }),
    });
  } catch (_) {}
  return {
    tabsRead,
    rowsRead: rowsRead || 0,
    bookingInserted: bookingInserted || 0,
    rowsUpdatedInitial: initialUpdated || 0,
    walkinInserted: walkinInserted || 0,
    rowsSkippedTouched: skippedTouched || 0,
    rowsError: errs,
    durationMs, errorMessage,
    details: { booking: bookingPerTab, initial: initialPerTab },
  };
}

// ==================== HTTP ====================
export default {
  async scheduled(_event, env, ctx) { ctx.waitUntil(runSync(env, 'cron')); },

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
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      const result = await runSync(env, 'manual');
      return new Response(JSON.stringify(result, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/debug') {
      const token = request.headers.get('x-sync-token') || url.searchParams.get('token');
      if (token !== env.MANUAL_TRIGGER_TOKEN) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      const cutoffIso = env.CUTOFF_DATE || CONFIG.cutoff_date;
      const debug = { booking: [], initial: [] };
      // Booking
      for (const tab of CONFIG.booking_tabs || []) {
        try {
          const cands = await extractBookingCandidates(CONFIG.booking_sheet_id, tab, cutoffIso);
          debug.booking.push({
            tab: tab.name, tool: tab.tool,
            candidate_count: cands.length,
            first_3: cands.slice(0, 3).map(c => ({
              name: c.patient_name, book_date: c.book_date, facility: c.facility, service: c.service,
            })),
          });
        } catch (e) {
          debug.booking.push({ tab: tab.name, error: String(e.message || e) });
        }
      }
      // Initial
      for (const tab of CONFIG.tabs) {
        try {
          const cands = await extractInitialCandidates(CONFIG.sheet_id, tab, CONFIG.header_aliases, cutoffIso);
          debug.initial.push({
            tab: tab.name,
            candidate_count: cands.length,
            first_3: cands.slice(0, 3).map(c => ({
              name: c.patient_name, book_date: c.book_date, reason: c.reason, facility: c.facility,
            })),
          });
        } catch (e) {
          debug.initial.push({ tab: tab.name, error: String(e.message || e) });
        }
      }
      return new Response(JSON.stringify(debug, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/status' || url.pathname === '/') {
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/v_latest_sync?select=*`, { headers: sbHeaders(env) });
      const latest = await r.json();
      return new Response(JSON.stringify({
        service: 'sheet-sync v900',
        latest: Array.isArray(latest) && latest.length > 0 ? latest[0] : null,
      }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response('sheet-sync v900\n\nGET /status  → 最新の同期結果\nGET /sync?token=xxx → 手動同期\nGET /debug?token=xxx → 診断\n', {
      headers: { ...cors, 'Content-Type': 'text/plain' },
    });
  },
};
