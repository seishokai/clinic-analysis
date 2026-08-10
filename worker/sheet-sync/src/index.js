/* ============================================================
 * sheet-sync Worker v800
 *   Cron: なし (Aladdin ブラウザから 10 分毎 fetch)
 *   HTTP: /status, /sync (手動、要 token), /debug
 *
 * v800 の設計変更 (旧: INSERT ONLY → 新: UPDATE-or-INSERT):
 *
 *   シート行 = 「実際に来院した人」の証跡。それを Aladdin に反映:
 *
 *   1. 予約ツール経由 (source_tool=DXHUB/セレクト) の予約行が存在:
 *      - 未編集 → 「検討中」に UPDATE (来院したことを反映)
 *      - 編集済み → 何もしない (安井さん等の作業を守る)
 *   2. 予約ツール経由の行が無い (直予約 walk-in):
 *      - 「検討中」で新規 INSERT (保険 含めば「治療中」)
 *      - service に来院理由を格納
 *
 * subrequest 見積 (Free 50 制限):
 *   12 (CSV) + 15 (patient SELECT/INSERT batches) + 1 (visits SELECT)
 *   + 15 (UPDATE/INSERT batches) + 1 (sync_log) = ~44
 * ============================================================ */

import CONFIG from '../config/sheet-tabs.js';

// ==================== Utils ====================
const normName = (n) => (n == null ? '' : String(n).replace(/[\s　]+/g, '').toLowerCase());

// 医院名の正規化 (フル名 → 短縮名)。Aladdin app.js の normFac と揃える
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
  // v800: M/D 形式は現在日以降なら「去年」と解釈 (2026-12-28 のような未来日 → 2025-12-28)
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

// sync_source → 決定的 hash (0..86399 秒)。apply_at のユニーク化用
function hashSec(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h) % 86400;
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
    out.push({
      tab: tab.name,
      row: i + 1,
      facility: tab.facility,     // 短縮名 (BF銀座, ウィズ 等)
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

function sbHeaders(env, extra = {}) {
  return {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    ...extra,
  };
}

// v800: 「触った」判定 (どれか 1 つでも当てはまれば touched)
function isTouched(visit) {
  if (visit.status && visit.status !== '未対応') return true;
  if (visit.memo != null && String(visit.memo).length > 0) return true;
  if (visit.contract_amount != null && Number(visit.contract_amount) > 0) return true;
  if (visit.next_visit_date != null) return true;
  const u = visit.updated_by;
  if (u && !['system-sync', 'sheet-came', 'sheet-direct', 'unknown', ''].includes(u)) return true;
  return false;
}

// v800: 保険判定 (来院理由に「保険」含めば 治療中)
function statusFromReason(reason) {
  if (reason && String(reason).includes('保険')) return '治療中';
  return '検討中';
}

// ==================== Main sync (v800) ====================
async function runSync(env, triggerName) {
  const startMs = Date.now();
  const cutoffIso = env.CUTOFF_DATE || CONFIG.cutoff_date;
  const aliases = CONFIG.header_aliases;

  // ---- Phase 1: 12 タブ CSV 取得 & candidates 抽出 (12 subrequests) ----
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
    return await finalize(env, triggerName, startMs, perTab, 0, 0, 0, 0, 0);
  }

  // ---- Phase 2: 既存 patients を chunk SELECT ----
  const uniqueNames = Array.from(new Set(allCandidates.map(c => c.normalized_name)));
  const CHUNK = 200;
  const patientMap = new Map();
  for (let i = 0; i < uniqueNames.length; i += CHUNK) {
    const chunk = uniqueNames.slice(i, i + CHUNK);
    const inList = chunk.map(n => `"${n.replace(/"/g, '\\"')}"`).join(',');
    const selUrl = `${env.SUPABASE_URL}/rest/v1/patients?normalized_name=in.(${encodeURIComponent(inList)})&select=id,normalized_name,phone_last4`;
    const selRes = await fetch(selUrl, { headers: sbHeaders(env) });
    if (!selRes.ok) {
      return await finalize(env, triggerName, startMs, perTab, allCandidates.length, 0, 0, 0, allCandidates.length,
        `patients SELECT chunk ${i} failed: ${selRes.status} ${await selRes.text()}`);
    }
    const existing = await selRes.json();
    for (const p of existing) if (!patientMap.has(p.normalized_name)) patientMap.set(p.normalized_name, p.id);
  }

  // ---- Phase 3: 不足 patients を bulk INSERT ----
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
        return await finalize(env, triggerName, startMs, perTab, allCandidates.length, 0, 0, 0, allCandidates.length,
          `patients INSERT batch ${i} failed: ${insRes.status} ${await insRes.text()}`);
      }
      const created = await insRes.json();
      for (const p of (Array.isArray(created) ? created : [])) patientMap.set(p.normalized_name, p.id);
    }
  }

  // ---- Phase 4: cutoff 以降の既存 visits を全 SELECT ----
  //   マッチング用に (patient_id, normFac(facility), book_date) をキーにする
  const visSelUrl = `${env.SUPABASE_URL}/rest/v1/patient_visits?book_date=gte.${cutoffIso}&deleted=eq.false&select=id,patient_id,facility,book_date,status,memo,contract_amount,next_visit_date,updated_by,source_tool`;
  const visRes = await fetch(visSelUrl, { headers: sbHeaders(env) });
  if (!visRes.ok) {
    return await finalize(env, triggerName, startMs, perTab, allCandidates.length, 0, 0, 0, allCandidates.length,
      `visits SELECT failed: ${visRes.status} ${await visRes.text()}`);
  }
  const existingVisits = await visRes.json();

  // key = patient_id | normFac(facility) | book_date
  const visitsByKey = new Map();
  for (const v of existingVisits) {
    const key = `${v.patient_id}|${normFac(v.facility)}|${v.book_date}`;
    if (!visitsByKey.has(key)) visitsByKey.set(key, []);
    visitsByKey.get(key).push(v);
  }

  // ---- Phase 5: 各 candidate を分類 (update / skip / insert) ----
  const toUpdate = [];  // 予約ツール由来の未編集行を検討中に
  const toInsert = [];  // walk-in (直予約)
  let skippedTouched = 0;
  let skippedAlreadyTagged = 0;  // 既に 検討中/治療中 で shieet 起源

  for (const c of allCandidates) {
    const patientId = patientMap.get(c.normalized_name);
    if (!patientId) continue;

    const key = `${patientId}|${c.facility}|${c.book_date}`;
    const matches = visitsByKey.get(key) || [];

    if (matches.length > 0) {
      // Case A: 予約ツール由来の未編集行を検討中に UPDATE
      const untouched = matches.filter(m => !isTouched(m));
      if (untouched.length > 0) {
        for (const u of untouched) {
          toUpdate.push(u.id);
        }
      } else {
        skippedTouched++;
      }
      // Case B: 全部 touched なら何もしない (既に人手で処理済み)
    } else {
      // Case C: 直予約 (walk-in) → 新規 INSERT
      toInsert.push({
        candidate: c,
        patient_id: patientId,
        status: statusFromReason(c.reason),
      });
    }
  }

  // ---- Phase 6: UPDATE (検討中 + updated_by=sheet-came) ----
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
      // 部分失敗は許容、ログのみ
      console.log('visits UPDATE batch failed', patchRes.status, await patchRes.text());
    }
  }

  // ---- Phase 7: INSERT (直予約 walk-in) ----
  let inserted = 0;
  const BATCH_I = 200;
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
  for (let i = 0; i < insPayload.length; i += BATCH_I) {
    const batch = insPayload.slice(i, i + BATCH_I);
    const iRes = await fetch(`${env.SUPABASE_URL}/rest/v1/patient_visits?on_conflict=patient_id,apply_at`, {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=representation,resolution=ignore-duplicates' }),
      body: JSON.stringify(batch),
    });
    if (iRes.ok) {
      const created = await iRes.json();
      inserted += Array.isArray(created) ? created.length : 0;
    } else {
      console.log('visits INSERT batch failed', iRes.status, await iRes.text());
    }
  }

  return await finalize(env, triggerName, startMs, perTab, allCandidates.length, updated, inserted, skippedTouched);
}

async function finalize(env, trigger, startMs, details, rowsRead, rowsUpdated, rowsInserted, rowsSkipped, rowsError, errorMessage) {
  const durationMs = Date.now() - startMs;
  const tabsRead = details.filter(d => !d.error).length;
  const errs = rowsError != null ? rowsError : details.filter(d => d.error).length;
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/sync_log`, {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        trigger,
        tabs_read: tabsRead,
        rows_read: rowsRead,
        rows_inserted: rowsInserted,
        rows_skipped: (rowsUpdated || 0) + (rowsSkipped || 0),   // 「触ってない」count を skip 相当に
        rows_error: errs,
        duration_ms: durationMs,
        error_message: errorMessage,
        details: { perTab: details, updated: rowsUpdated || 0, inserted_walkin: rowsInserted || 0, skipped_touched: rowsSkipped || 0 },
      }),
    });
  } catch (_) {}
  return {
    tabsRead, rowsRead,
    rowsUpdated: rowsUpdated || 0,      // 予約ツール行 → 検討中 に更新した数
    rowsInserted: rowsInserted || 0,    // 直予約 (walk-in) 新規追加
    rowsSkippedTouched: rowsSkipped || 0, // 人手で編集済のためスキップ
    rowsError: errs,
    durationMs, errorMessage,
    details,
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
      const aliases = CONFIG.header_aliases;
      const debug = [];
      for (const tab of CONFIG.tabs) {
        try {
          const csv = await fetchTabCsv(env.SHEET_ID, tab.name);
          const rows = parseCsv(csv);
          const cols = tab.columns || detectColumns(rows[0], aliases);
          const cands = await extractCandidates(env.SHEET_ID, tab, aliases, cutoffIso);
          debug.push({
            tab: tab.name,
            header_first15: (rows[0] || []).slice(0, 15),
            detected_cols: cols,
            candidate_count: cands.length,
            first_3: cands.slice(0, 3).map(c => ({
              name: c.patient_name, book_date: c.book_date,
              reason: c.reason, source_channel: c.source_channel, facility: c.facility,
            })),
          });
        } catch (e) {
          debug.push({ tab: tab.name, error: String(e.message || e) });
        }
      }
      return new Response(JSON.stringify(debug, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/status' || url.pathname === '/') {
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/v_latest_sync?select=*`, { headers: sbHeaders(env) });
      const latest = await r.json();
      return new Response(JSON.stringify({
        service: 'sheet-sync v800',
        latest: Array.isArray(latest) && latest.length > 0 ? latest[0] : null,
      }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response('sheet-sync v800\n\nGET /status  → 最新の同期結果\nGET /sync?token=xxx → 手動同期\nGET /debug?token=xxx → 診断\n', {
      headers: { ...cors, 'Content-Type': 'text/plain' },
    });
  },
};
