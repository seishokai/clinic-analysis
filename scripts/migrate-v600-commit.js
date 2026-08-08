#!/usr/bin/env node
/**
 * migrate-v600-commit.js — Aladdin 再設計 Phase 2 本番 import
 *
 * dry-run で確認した集約結果を実際に Supabase の新スキーマ (patients /
 * patient_visits / status_events) に INSERT する。既存の booking_status /
 * manual_bookings / bf_history は一切変更しない (並行運用可能なまま)。
 *
 * 使い方:
 *   npm run migrate:commit
 *   (service_role キー or anon 一時 policy が必要 — dry-run 手順と同じ)
 *
 *   $env:SUPABASE_SERVICE_KEY = "eyJ..."  # 推奨
 *   npm run migrate:commit
 *
 * 特徴:
 * - Q4 決定: DB のみ存在の orphan booking_status も patient_visits に取り込む
 * - 冪等性: 何度実行しても患者/visit の重複は作らない
 *     (patients は normalized_name+phone_last4 で SELECT 済 skip、
 *      visits は UNIQUE(patient_id, apply_at) で upsert)
 * - 30 秒カウントダウン付き (中断可)。--yes で skip
 * - トランザクションではないので途中停止時は再実行で続きから
 */

const { createClient } = require('@supabase/supabase-js');

// ==================== Config ====================
const SUPABASE_URL = 'https://ndlfqrvoejwgqfdtghmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5kbGZxcnZvZWp3Z3FmZHRnaG1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1ODIxNjcsImV4cCI6MjA5MTE1ODE2N30.pE-l-4NgQTpEb9DvjeRptargvrsYH9YKyRLt06flPik';
function _cleanJwt(s) { return s ? String(s).replace(/[^A-Za-z0-9._\-=]/g, '') : ''; }
const SUPABASE_KEY = _cleanJwt(process.env.SUPABASE_SERVICE_KEY) || SUPABASE_ANON_KEY;
const USING_SERVICE_ROLE = !!process.env.SUPABASE_SERVICE_KEY && _cleanJwt(process.env.SUPABASE_SERVICE_KEY).length > 0;
const BK_SHEET_ID = '10misKpAtMitwIagGDUoMvQS7U9pfEQ0ODxG8A7DLzaQ';

const SHEETS = [
  { label: '元データ', encoded: '%E5%85%83%E3%83%87%E3%83%BC%E3%82%BF', tool: 'DXHUB', facility: null },
  { label: '銀座セレクトタイプ', encoded: '%E9%8A%80%E5%BA%A7%E3%82%BB%E3%83%AC%E3%82%AF%E3%83%88%E3%82%BF%E3%82%A4%E3%83%97', tool: 'セレクト', facility: 'BF銀座' },
  { label: 'ウィズセレクトタイプ', encoded: '%E3%82%A6%E3%82%A3%E3%82%BA%E3%82%BB%E3%83%AC%E3%82%AF%E3%83%88%E3%82%BF%E3%82%A4%E3%83%97', tool: 'セレクト', facility: 'ウィズ' },
  { label: '京都セレクトタイプ', encoded: '%E4%BA%AC%E9%83%BD%E3%82%BB%E3%83%AC%E3%82%AF%E3%83%88%E3%82%BF%E3%82%A4%E3%83%97', tool: 'セレクト', facility: '京都' },
  { label: 'ルミナスセレクトタイプ', encoded: '%E3%83%AB%E3%83%9F%E3%83%8A%E3%82%B9%E3%82%BB%E3%83%AC%E3%82%AF%E3%83%88%E3%82%BF%E3%82%A4%E3%83%97', tool: 'セレクト', facility: 'ルミナス' },
];

const args = process.argv.slice(2);
const SKIP_CONFIRM = args.includes('--yes');
const BATCH_SIZE = 200;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==================== Utils ====================
function normName(n) { return n == null ? '' : String(n).replace(/[\s　]+/g, '').toLowerCase(); }
function phoneDigitsLast4(p) { return p == null ? '' : String(p).replace(/\D/g, '').slice(-4); }
function normDateKey(s) {
  if (!s) return '';
  const m = String(s).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : String(s);
}
function toIsoTs(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})(?:\D+(\d{1,2})\D+(\d{1,2}))?/);
  if (!m) return null;
  const [, y, mo, d, hh = '0', mm = '0'] = m;
  const p = n => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}T${p(hh)}:${p(mm)}:00+09:00`;
}
function toDate(s) {
  const k = normDateKey(s);
  return /^\d{4}-\d{2}-\d{2}$/.test(k) ? k : null;
}
// v600 fix: DB DATE 列用の堅牢な parser。
//   YYYY-MM-DD / YYYY/MM/DD → そのまま
//   YYYY-MM / YYYY/MM (月のみ) → YYYY-MM-01
//   その他/空/不正 → null (DB エラー回避)
function toDbDate(s) {
  if (!s) return null;
  const s2 = String(s).trim();
  if (!s2) return null;
  // YYYY-MM-DD (already valid)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s2)) return s2;
  // YYYY/MM/DD or YYYY-M-D (with optional time)
  let m = s2.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  // YYYY-MM or YYYY/MM (month-only) → add -01
  m = s2.match(/^(\d{4})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-01`;
  return null;
}

// ==================== CSV Parsing ====================
function parseCsvLine(line) {
  const result = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else current += c;
  }
  result.push(current.trim());
  return result;
}
function parseDxhubCsv(csv) {
  const lines = csv.split('\n'); const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 5 || !cols[2]) continue;
    rows.push({
      applyDate: cols[0] || '', bookDate: cols[1] || '', name: cols[2] || '',
      service: cols[3] || '', facility: cols[4] || '', email: cols[5] || '',
      phone: (cols[6] || '').replace(/[-\s]/g, ''), source: cols[7] || '', status: cols[8] || '未対応',
    });
  }
  return rows;
}
function parseSelectCsv(csv, facility) {
  const lines = csv.split('\n'); const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 3 || !cols[2]) continue;
    rows.push({
      applyDate: cols[0] || '', bookDate: cols[1] || '', name: cols[2] || '',
      service: '矯正無料相談', facility, email: cols[4] || '',
      phone: (cols[3] || '').replace(/[-\s]/g, ''), source: 'セレクトタイプ', status: '',
    });
  }
  return rows;
}

// ==================== Fetching ====================
async function fetchSheet(spec) {
  const url = `https://docs.google.com/spreadsheets/d/${BK_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${spec.encoded}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${spec.label}: ${res.status}`);
  const csv = await res.text();
  const rows = spec.tool === 'DXHUB' ? parseDxhubCsv(csv) : parseSelectCsv(csv, spec.facility);
  return rows.map(r => ({ ...r, sourceTool: spec.tool, sourceSheet: spec.label }));
}
async function fetchAllSheets() {
  const results = await Promise.all(SHEETS.map(fetchSheet));
  return results.flat();
}
async function fetchAll(table) {
  let all = []; const pageSize = 1000; let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select('*').range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ==================== Clustering ====================
function clusterPatients(allRows) {
  const clusters = new Map();
  for (const r of allRows) {
    const nn = normName(r.name);
    if (!nn) continue;
    const p4 = phoneDigitsLast4(r.phone) || 'X';
    const key = nn + '|' + p4;
    if (!clusters.has(key)) {
      clusters.set(key, {
        clusterKey: key, normalized_name: nn,
        phone_last4: p4 === 'X' ? null : p4,
        name: r.name, phone: r.phone || null, email: r.email || null,
        primary_facility: r.facility || null, rows: [],
      });
    }
    const c = clusters.get(key);
    if (r.name && r.name.length > (c.name || '').length) c.name = r.name;
    if (!c.phone && r.phone) c.phone = r.phone;
    if (!c.email && r.email) c.email = r.email;
    if (!c.primary_facility && r.facility) c.primary_facility = r.facility;
    c.rows.push(r);
  }
  return clusters;
}

// ==================== Visit builder ====================
function buildVisit(r, dbByKey, dbByNormDate) {
  const exactKey = r.name + '|' + r.applyDate;
  let dbRow = dbByKey.get(exactKey);
  if (!dbRow) {
    const nnDate = normName(r.name) + '|' + normDateKey(r.applyDate);
    dbRow = dbByNormDate.get(nnDate);
  }
  return {
    _sourceKey: r.sourceTool + ':' + normName(r.name) + ':' + normDateKey(r.applyDate),
    source_tool: r.sourceTool || null,
    source_row_id: null,
    apply_at: toIsoTs(r.applyDate),
    apply_date: toDbDate(r.applyDate),
    book_at: toIsoTs(r.bookDate),
    book_date: toDbDate(r.bookDate),
    facility: r.facility || null,
    service: r.service || null,
    promo_code: r.source || null,
    status: (dbRow && dbRow.status) || r.status || null,
    bf_status: (dbRow && dbRow.bf_status) || null,
    contract_amount: dbRow && dbRow.contract_amount != null ? Number(dbRow.contract_amount) : null,
    contract_service: dbRow && dbRow.contract_service || null,
    // v600 fix: DATE 型は全て toDbDate で YYYY-MM-DD or null に正規化 (「2026-04」対策)
    contract_date: toDbDate(dbRow && dbRow.contract_date),
    payment_month: toDbDate(dbRow && dbRow.payment_month),
    incentive_amount: dbRow && dbRow.incentive_amount != null ? Number(dbRow.incentive_amount) : null,
    incentive_month: toDbDate(dbRow && dbRow.incentive_month),
    incentive_paid: !!(dbRow && dbRow.incentive_paid),
    paid_at: dbRow && dbRow.paid_at || null,
    paid_by: dbRow && dbRow.paid_by || null,
    memo: dbRow && (dbRow.memo || dbRow.bf_memo) || null,
    next_visit_date: toDbDate(dbRow && dbRow.bf_next_date),
    cs_facility: dbRow && dbRow.bf_cs_facility || null,
    cs_doctor: dbRow && dbRow.bf_cs_doctor || null,
    set_facility: dbRow && dbRow.bf_set_facility || null,
    travel_cost: dbRow && dbRow.bf_travel_cost != null ? Number(dbRow.bf_travel_cost) : null,
    edited_book_date: toDbDate(dbRow && dbRow.edited_book_date),
    edited_service: dbRow && dbRow.edited_service || null,
    deleted: false,
    updated_by: 'migrate:v600',
  };
}

// ==================== Batch INSERT ====================
async function insertBatched(table, rows, opts = {}) {
  const totalRows = rows.length;
  if (totalRows === 0) return { inserted: 0, errors: 0 };
  let inserted = 0; let errors = 0;
  for (let i = 0; i < totalRows; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const q = opts.onConflict
      ? sb.from(table).upsert(chunk, { onConflict: opts.onConflict, ignoreDuplicates: opts.ignoreDup || false })
      : sb.from(table).insert(chunk);
    const { data, error } = opts.returning ? await q.select() : await q;
    if (error) {
      console.error(`  ✗ ${table} batch ${i}-${i + chunk.length}: ${error.message}`);
      errors += chunk.length;
      if (opts.throwOnError) throw error;
      continue;
    }
    inserted += chunk.length;
    if (opts.returning && data) {
      // caller wants inserted rows back (for id mapping)
      if (!opts._collected) opts._collected = [];
      opts._collected.push(...data);
    }
    process.stdout.write(`\r  ${table}: ${inserted}/${totalRows} inserted`);
  }
  process.stdout.write('\n');
  return { inserted, errors, data: opts._collected };
}

// ==================== Main ====================
async function main() {
  const t0 = Date.now();
  console.log('==================================================');
  console.log('  Aladdin v600 Migration — COMMIT (本番)');
  console.log('==================================================');
  console.log(`  Supabase key: ${USING_SERVICE_ROLE ? '★ service_role' : 'anon'}`);

  console.log('\n[1/6] データ取得中...');
  const [sheetRows, bookingStatus, manualBookings, bfHistory] = await Promise.all([
    fetchAllSheets(),
    fetchAll('booking_status'),
    fetchAll('manual_bookings').catch(() => []),
    fetchAll('bf_history').catch(() => []),
  ]);
  console.log(`  Sheets ${sheetRows.length} / booking_status ${bookingStatus.length} / manual ${manualBookings.length} / history ${bfHistory.length}`);

  console.log('\n[2/6] クラスタリング...');
  const allRows = [...sheetRows, ...manualBookings.map(m => ({
    applyDate: m.apply_date, bookDate: m.book_date, name: m.name,
    service: m.service, facility: m.facility, email: m.email,
    phone: m.phone, source: m.source, status: m.status,
    sourceTool: '手動', sourceSheet: 'manual_bookings',
  }))];
  const clusters = clusterPatients(allRows);
  console.log(`  patients (name+phone_last4): ${clusters.size} 患者`);

  // dbByKey / dbByNormDate for join
  const dbByKey = new Map(), dbByNormDate = new Map();
  for (const s of [...bookingStatus, ...manualBookings]) {
    dbByKey.set(s.name + '|' + s.apply_date, s);
    dbByNormDate.set(normName(s.name) + '|' + normDateKey(s.apply_date), s);
  }

  // ---- Q4: Orphan handling ----
  const sheetsKeysNorm = new Set();
  clusters.forEach(c => c.rows.forEach(r => {
    sheetsKeysNorm.add(normName(r.name) + '|' + normDateKey(r.applyDate));
  }));
  const orphans = bookingStatus.filter(s =>
    !sheetsKeysNorm.has(normName(s.name) + '|' + normDateKey(s.apply_date)));
  console.log(`  orphan booking_status (Q4=取り込む): ${orphans.length} 件`);

  // Add orphans as synthetic rows to clusters
  for (const o of orphans) {
    const nn = normName(o.name);
    if (!nn) continue;
    const p4 = 'X'; // orphans have no phone info
    const key = nn + '|' + p4;
    if (!clusters.has(key)) {
      clusters.set(key, {
        clusterKey: key, normalized_name: nn, phone_last4: null,
        name: o.name, phone: null, email: null,
        primary_facility: o.bf_cs_facility || null,
        rows: [],
      });
    }
    const c = clusters.get(key);
    c.rows.push({
      applyDate: o.apply_date, bookDate: o.book_date, name: o.name,
      service: null, facility: o.bf_cs_facility || null,
      email: null, phone: null, source: null, status: o.status,
      sourceTool: 'DB_orphan', sourceSheet: 'booking_status_orphan',
    });
  }
  console.log(`  clusters after orphan merge: ${clusters.size} 患者`);

  // ---- CONFIRM ----
  console.log('\n==================================================');
  console.log(`  書き込み計画:`);
  console.log(`    patients:       ${clusters.size} 行`);
  console.log(`    patient_visits: ${[...clusters.values()].reduce((s, c) => s + c.rows.length, 0)} 行`);
  console.log(`    status_events:  ${bfHistory.length} 行 (bf_history から)`);
  console.log(`  対象テーブル: patients / patient_visits / status_events`);
  console.log(`  ※ 既存の booking_status / manual_bookings / bf_history は変更しない`);
  console.log('==================================================');
  if (!SKIP_CONFIRM) {
    console.log('\n★ 30 秒後に書き込み開始。中断は Ctrl+C ★');
    for (let s = 30; s > 0; s--) {
      process.stdout.write(`\r  カウントダウン: ${s} 秒 `);
      await new Promise(r => setTimeout(r, 1000));
    }
    process.stdout.write('\n');
  }

  console.log('\n[3/6] patients INSERT...');
  const patientRows = [...clusters.values()].map(c => ({
    name: c.name || 'UNKNOWN',
    normalized_name: c.normalized_name,
    phone: c.phone || null,
    phone_last4: c.phone_last4,
    email: c.email || null,
    primary_facility: c.primary_facility || null,
    patient_note: null,
    deleted: false,
    created_by: 'migrate:v600',
    updated_by: 'migrate:v600',
  }));
  const pRes = await insertBatched('patients', patientRows, { returning: true });
  console.log(`  ✓ ${pRes.inserted} patients inserted (errors: ${pRes.errors})`);
  if (!pRes.data || pRes.data.length !== pRes.inserted) {
    throw new Error(`patients returning size mismatch: expected ${pRes.inserted}, got ${pRes.data?.length}`);
  }
  // Build clusterKey -> patient_id map
  //   Insert order preserved by supabase, so map by index
  const patientIdByCluster = new Map();
  const clusterArr = [...clusters.values()];
  clusterArr.forEach((c, i) => {
    const dbRow = pRes.data[i];
    if (dbRow && dbRow.id) patientIdByCluster.set(c.clusterKey, dbRow.id);
  });
  console.log(`  cluster→id map: ${patientIdByCluster.size} entries`);

  console.log('\n[4/6] patient_visits INSERT...');
  const visitRows = [];
  for (const c of clusterArr) {
    const pid = patientIdByCluster.get(c.clusterKey);
    if (!pid) continue;
    for (const r of c.rows) {
      const v = buildVisit(r, dbByKey, dbByNormDate);
      if (!v.apply_at) continue; // skip rows without apply_at (mandatory)
      v.patient_id = pid;
      delete v._sourceKey;
      visitRows.push(v);
    }
  }
  // Dedup within batch by (patient_id, apply_at) — same UNIQUE constraint
  const seenVisit = new Set(); const uniqVisits = [];
  for (const v of visitRows) {
    const k = v.patient_id + '|' + v.apply_at;
    if (seenVisit.has(k)) continue;
    seenVisit.add(k); uniqVisits.push(v);
  }
  console.log(`  visits to insert: ${uniqVisits.length} (dedup dropped ${visitRows.length - uniqVisits.length})`);
  const vRes = await insertBatched('patient_visits', uniqVisits, {
    onConflict: 'patient_id,apply_at', ignoreDup: true,
  });
  console.log(`  ✓ ${vRes.inserted} visits inserted (errors: ${vRes.errors})`);

  console.log('\n[5/6] status_events INSERT (bf_history から)...');
  // Look up visit_id by (normName, normDateKey) from history
  const { data: allVisits } = await sb.from('patient_visits')
    .select('id, patient_id, apply_at')
    .range(0, 9999);
  const visitByNormKey = new Map();
  for (const v of allVisits || []) {
    const nd = normDateKey(v.apply_at);
    // We need name — join with patients
  }
  // Simpler: fetch patient_id → normalized_name map
  const { data: allPatients } = await sb.from('patients')
    .select('id, normalized_name')
    .range(0, 9999);
  const nnByPid = new Map();
  (allPatients || []).forEach(p => nnByPid.set(p.id, p.normalized_name));
  const visitKeyToId = new Map();
  for (const v of allVisits || []) {
    const nn = nnByPid.get(v.patient_id);
    if (!nn) continue;
    visitKeyToId.set(nn + '|' + normDateKey(v.apply_at), { vid: v.id, pid: v.patient_id });
  }
  const eventRows = [];
  for (const h of bfHistory) {
    const k = normName(h.booking_name) + '|' + normDateKey(h.booking_apply_date);
    const target = visitKeyToId.get(k);
    if (!target) continue; // history without matching visit → skip
    eventRows.push({
      visit_id: target.vid, patient_id: target.pid,
      from_status: null, to_status: null,
      from_bf_status: h.from_status || null, to_bf_status: h.to_status || null,
      event_type: 'status_change',
      note: h.memo || null,
      changed_fields: { migrated_from: 'bf_history', bf_history_id: h.id },
      changed_at: h.created_at || new Date().toISOString(),
      changed_by: h.changed_by || 'migrate:v600',
    });
  }
  console.log(`  events to insert: ${eventRows.length}/${bfHistory.length} (matched to visits)`);
  const eRes = await insertBatched('status_events', eventRows);
  console.log(`  ✓ ${eRes.inserted} events inserted (errors: ${eRes.errors})`);

  console.log('\n[6/6] 検証...');
  const [cp, cv, ce] = await Promise.all([
    sb.from('patients').select('*', { count: 'exact', head: true }),
    sb.from('patient_visits').select('*', { count: 'exact', head: true }),
    sb.from('status_events').select('*', { count: 'exact', head: true }),
  ]);
  console.log(`  patients:       ${cp.count} 行`);
  console.log(`  patient_visits: ${cv.count} 行`);
  console.log(`  status_events:  ${ce.count} 行`);

  const dt = Date.now() - t0;
  console.log('\n==================================================');
  console.log('  COMMIT 完了');
  console.log('==================================================');
  console.log(`  所要時間: ${(dt / 1000).toFixed(1)} 秒`);
  console.log(`  patients: ${pRes.inserted} / visits: ${vRes.inserted} / events: ${eRes.inserted}`);
  console.log(`  合計エラー: ${pRes.errors + vRes.errors + eRes.errors} 件`);
  console.log('\n【確認】Supabase Table Editor で patients / patient_visits を目視確認してください。');
  console.log('【次】 Phase 3: UI (app.js) を新スキーマ読み書きに切替。');
}

main().catch(e => {
  console.error('\n✗ FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
