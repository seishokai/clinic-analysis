#!/usr/bin/env node
/**
 * migrate-v600-dryrun.js — Aladdin 再設計 Phase 1 移行 dry-run
 *
 * 現行の Google Sheets + Supabase (booking_status / manual_bookings / bf_history)
 * を読み、新スキーマ (patients / patient_visits / status_events) の形にクラスタリング
 * して JSON レポートを出力する。DB には一切書かない。
 *
 * 使い方:
 *   npm install @supabase/supabase-js   # 初回のみ
 *   node scripts/migrate-v600-dryrun.js
 *
 * 出力: .dry-run-report.json
 *
 * レポートを見て件数・金額・同一人物クラスタが妥当なら Phase 2 (本番 import) へ。
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ==================== Config ====================
const SUPABASE_URL = 'https://ndlfqrvoejwgqfdtghmg.supabase.co';
// service_role キーが env に設定されていれば RLS バイパス (推奨: 移行時のみ)。
// 未設定なら anon キーで読み込み (booking_status / bf_history は RLS で 0 行になる)。
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5kbGZxcnZvZWp3Z3FmZHRnaG1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1ODIxNjcsImV4cCI6MjA5MTE1ODE2N30.pE-l-4NgQTpEb9DvjeRptargvrsYH9YKyRLt06flPik';
// PowerShell/paste 経由で改行/空白が混入すると HTTP header に invalid value エラー。
// JWT は base64url + '.' のみで構成されるので、それ以外の文字を全て除去して sanitize する。
function _cleanJwt(s) {
  if (!s) return '';
  return String(s).replace(/[^A-Za-z0-9._\-=]/g, '');
}
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

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==================== Utils ====================
function normName(n) {
  if (n == null) return '';
  return String(n).replace(/[\s　]+/g, '').toLowerCase();
}
function phoneDigitsLast4(p) {
  if (p == null) return '';
  return String(p).replace(/\D/g, '').slice(-4);
}
function normDateKey(s) {
  if (!s) return '';
  const s2 = String(s);
  const m = s2.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return s2;
}
function toIsoTimestamp(s) {
  if (!s) return null;
  const s2 = String(s);
  const m = s2.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})(?:\D+(\d{1,2})\D+(\d{1,2}))?/);
  if (!m) return null;
  const [, y, mo, d, hh = '0', mm = '0'] = m;
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00+09:00`;
}
function toDate(s) {
  const k = normDateKey(s);
  return k && /^\d{4}-\d{2}-\d{2}$/.test(k) ? k : null;
}

// ==================== CSV Parsing (Aladdin と同ロジック) ====================
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
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
  const lines = csv.split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 5 || !cols[2]) continue;
    rows.push({
      applyDate: cols[0] || '', bookDate: cols[1] || '',
      name: cols[2] || '', service: cols[3] || '', facility: cols[4] || '',
      email: cols[5] || '', phone: (cols[6] || '').replace(/[-\s]/g, ''),
      source: cols[7] || '', status: cols[8] || '未対応',
    });
  }
  return rows;
}
function parseSelectCsv(csv, facility) {
  const lines = csv.split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 3 || !cols[2]) continue;
    rows.push({
      applyDate: cols[0] || '', bookDate: cols[1] || '',
      name: cols[2] || '', service: '矯正無料相談', facility,
      email: cols[4] || '', phone: (cols[3] || '').replace(/[-\s]/g, ''),
      source: 'セレクトタイプ', status: '',
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
  // Supabase の default limit は 1000。ページング。
  let all = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error, status } = await sb.from(table).select('*').range(from, from + pageSize - 1);
    if (error) {
      console.error(`  ✗ ${table} fetch error [status=${status}]:`, error.message);
      if (error.details) console.error('    details:', error.details);
      if (error.hint) console.error('    hint:', error.hint);
      throw error;
    }
    if (!data || data.length === 0) {
      if (all.length === 0) {
        console.warn(`  ⚠ ${table} は 0 行を返した。RLS で anon がブロックされている可能性あり。`);
      }
      break;
    }
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}
async function countRowsHead(table) {
  const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true });
  if (error) return `error: ${error.message}`;
  return count;
}

// ==================== Clustering (name + phone_last4 → patient) ====================
function clusterPatients(allRows) {
  // key: normName + '|' + phone4 (or 'X' if no phone)
  const clusters = new Map();
  for (const r of allRows) {
    const nn = normName(r.name);
    if (!nn) continue;
    const p4 = phoneDigitsLast4(r.phone) || 'X';
    const key = nn + '|' + p4;
    if (!clusters.has(key)) {
      clusters.set(key, {
        clusterKey: key,
        normalized_name: nn,
        phone_last4: p4 === 'X' ? null : p4,
        // canonical patient info (use first non-empty)
        name: r.name,
        phone: r.phone || null,
        email: r.email || null,
        primary_facility: r.facility || null,
        rows: [],
      });
    }
    const c = clusters.get(key);
    // Prefer richer name / phone / email
    if (r.name && r.name.length > (c.name || '').length) c.name = r.name;
    if (!c.phone && r.phone) c.phone = r.phone;
    if (!c.email && r.email) c.email = r.email;
    if (!c.primary_facility && r.facility) c.primary_facility = r.facility;
    c.rows.push(r);
  }
  return clusters;
}

// ==================== Build report ====================
function buildVisitFromRow(r, dbByKey, dbByNormDate) {
  // Try to find matching booking_status / manual_bookings row
  const exactKey = r.name + '|' + r.applyDate;
  let dbRow = dbByKey.get(exactKey);
  if (!dbRow) {
    const nnDate = normName(r.name) + '|' + normDateKey(r.applyDate);
    dbRow = dbByNormDate.get(nnDate);
  }
  return {
    source_tool: r.sourceTool,
    source_sheet: r.sourceSheet,
    apply_date: toDate(r.applyDate),
    apply_at: toIsoTimestamp(r.applyDate),
    book_date: toDate(r.bookDate),
    book_at: toIsoTimestamp(r.bookDate),
    facility: r.facility || null,
    service: r.service || null,
    promo_code: r.source || null,
    status: (dbRow && dbRow.status) || r.status || null,
    bf_status: (dbRow && dbRow.bf_status) || null,
    contract_amount: dbRow && dbRow.contract_amount != null ? Number(dbRow.contract_amount) : null,
    contract_service: dbRow && dbRow.contract_service || null,
    contract_date: dbRow && dbRow.contract_date || null,
    payment_month: dbRow && dbRow.payment_month || null,
    incentive_amount: dbRow && dbRow.incentive_amount != null ? Number(dbRow.incentive_amount) : null,
    incentive_month: dbRow && dbRow.incentive_month || null,
    incentive_paid: dbRow && dbRow.incentive_paid || false,
    memo: dbRow && (dbRow.memo || dbRow.bf_memo) || null,
    next_visit_date: dbRow && dbRow.bf_next_date || null,
    cs_facility: dbRow && dbRow.bf_cs_facility || null,
    cs_doctor: dbRow && dbRow.bf_cs_doctor || null,
    set_facility: dbRow && dbRow.bf_set_facility || null,
    travel_cost: dbRow && dbRow.bf_travel_cost != null ? Number(dbRow.bf_travel_cost) : null,
    _hasDbRow: !!dbRow,
    _dbRowName: dbRow ? dbRow.name : null,
  };
}

function buildReport(clusters, bookingStatus, manualBookings, bfHistory) {
  // Build lookup indexes for DB rows
  const dbByKey = new Map();
  const dbByNormDate = new Map();
  for (const s of bookingStatus) {
    dbByKey.set(s.name + '|' + s.apply_date, s);
    dbByNormDate.set(normName(s.name) + '|' + normDateKey(s.apply_date), s);
  }
  for (const s of manualBookings) {
    dbByKey.set(s.name + '|' + s.apply_date, s);
    dbByNormDate.set(normName(s.name) + '|' + normDateKey(s.apply_date), s);
  }

  // Convert each cluster into a patient + visits
  const patients = [];
  const warnings = [];
  let visitsTotal = 0;
  let totalContractAmount = 0;
  let contractCount = 0;
  const statusHistogram = {};

  for (const c of clusters.values()) {
    // Facilities across the cluster (may indicate different facilities per visit)
    const facilities = [...new Set(c.rows.map(r => r.facility).filter(Boolean))];
    // Visits from rows
    const visits = c.rows.map(r => buildVisitFromRow(r, dbByKey, dbByNormDate));
    visits.forEach(v => {
      visitsTotal++;
      if (v.contract_amount) { totalContractAmount += v.contract_amount; contractCount++; }
      const st = v.bf_status || v.status || '(空)';
      statusHistogram[st] = (statusHistogram[st] || 0) + 1;
    });
    const visitDates = visits.map(v => v.apply_at).filter(Boolean).sort();
    const firstSeen = visitDates[0] || null;
    // Detect warnings
    if (facilities.length > 1) {
      warnings.push({
        type: 'multi_facility',
        name: c.name,
        phone_last4: c.phone_last4,
        facilities,
        visitCount: visits.length,
      });
    }
    if (c.rows.length > 1 && !c.phone_last4) {
      // Same normalized name, no phone → risky merge (could be different people)
      warnings.push({
        type: 'no_phone_multi_visit',
        name: c.name,
        visitCount: visits.length,
        applyDates: c.rows.map(r => r.applyDate).slice(0, 5),
      });
    }
    patients.push({
      clusterKey: c.clusterKey,
      name: c.name,
      normalized_name: c.normalized_name,
      phone: c.phone,
      phone_last4: c.phone_last4,
      email: c.email,
      primary_facility: c.primary_facility,
      first_seen: firstSeen,
      visits,
      visitCount: visits.length,
    });
  }

  // Build status_events from bf_history
  const events = bfHistory.map(h => ({
    booking_name: h.booking_name,
    booking_apply_date: h.booking_apply_date,
    from_status: h.from_status,
    to_status: h.to_status,
    memo: h.memo,
    changed_at: h.created_at,
    changed_by: h.changed_by,
  }));

  // DB rows unaccounted for (existed in DB but no matching Sheets row)
  const sheetsExactKeys = new Set();
  clusters.forEach(c => c.rows.forEach(r => {
    sheetsExactKeys.add(normName(r.name) + '|' + normDateKey(r.applyDate));
  }));
  const orphanBookingStatus = bookingStatus.filter(s => {
    const k = normName(s.name) + '|' + normDateKey(s.apply_date);
    return !sheetsExactKeys.has(k);
  });

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalPatients: patients.length,
      totalVisits: visitsTotal,
      totalContractAmount,
      contractCount,
      averageVisitsPerPatient: patients.length ? +(visitsTotal / patients.length).toFixed(2) : 0,
      inputCounts: {
        sheetsRows: [...clusters.values()].reduce((n, c) => n + c.rows.length, 0),
        bookingStatus: bookingStatus.length,
        manualBookings: manualBookings.length,
        bfHistory: bfHistory.length,
      },
      orphanBookingStatus: orphanBookingStatus.length,
    },
    statusHistogram,
    warnings: {
      total: warnings.length,
      multiFacility: warnings.filter(w => w.type === 'multi_facility').length,
      noPhoneMultiVisit: warnings.filter(w => w.type === 'no_phone_multi_visit').length,
      samples: warnings.slice(0, 20),
    },
    orphanSamples: orphanBookingStatus.slice(0, 20).map(o => ({
      name: o.name,
      apply_date: o.apply_date,
      status: o.status,
      bf_status: o.bf_status,
      updated_at: o.updated_at,
    })),
    patientSamples: patients.slice(0, 10).map(p => ({
      name: p.name,
      phone_last4: p.phone_last4,
      email: p.email,
      primary_facility: p.primary_facility,
      visitCount: p.visitCount,
      firstVisit: p.first_seen,
    })),
    events: {
      total: events.length,
    },
  };
}

// ==================== Main ====================
async function main() {
  const t0 = Date.now();
  console.log('==================================================');
  console.log('  Aladdin v600 Migration Dry-Run');
  console.log('==================================================');
  console.log(`  Supabase key: ${USING_SERVICE_ROLE ? '★ service_role (RLS バイパス)' : 'anon (RLS 有効)'}`);
  if (!USING_SERVICE_ROLE) {
    console.log('  ⚠ anon で実行中。booking_status/bf_history は RLS で 0 行になる可能性大。');
    console.log('  → service_role キーを env var に設定して再実行を推奨:');
    console.log('     $env:SUPABASE_SERVICE_KEY = "eyJ..."');
  }

  console.log('\n[0/4] Supabase 疎通確認 (RLS/anon 可視性チェック)...');
  for (const t of ['booking_status', 'manual_bookings', 'bf_history']) {
    const n = await countRowsHead(t);
    console.log(`  ${t.padEnd(20)} 見える行数: ${n}`);
  }

  console.log('\n[1/4] Sheets を取得中...');
  const sheetRows = await fetchAllSheets();
  console.log(`  → ${sheetRows.length} 行 (5 sheets)`);

  console.log('\n[2/4] Supabase booking_status を取得中...');
  const bookingStatus = await fetchAll('booking_status');
  console.log(`  → ${bookingStatus.length} 行`);

  console.log('\n[3/4] manual_bookings & bf_history を取得中...');
  const [manualBookings, bfHistory] = await Promise.all([
    fetchAll('manual_bookings').catch(() => []),
    fetchAll('bf_history').catch(() => []),
  ]);
  console.log(`  → manual_bookings: ${manualBookings.length} 行 / bf_history: ${bfHistory.length} 行`);

  console.log('\n[4/4] 患者クラスタリング & レポート生成中...');
  const allRows = [...sheetRows, ...manualBookings.map(m => ({
    applyDate: m.apply_date, bookDate: m.book_date, name: m.name,
    service: m.service, facility: m.facility, email: m.email,
    phone: m.phone, source: m.source, status: m.status,
    sourceTool: '手動', sourceSheet: 'manual_bookings',
  }))];
  const clusters = clusterPatients(allRows);
  const report = buildReport(clusters, bookingStatus, manualBookings, bfHistory);

  const outFile = path.join(__dirname, '..', '.dry-run-report.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  const dt = Date.now() - t0;
  console.log('\n==================================================');
  console.log('  DRY-RUN 完了');
  console.log('==================================================');
  console.log(`\n所要時間: ${(dt / 1000).toFixed(1)} 秒`);
  console.log(`\n【集約結果】`);
  console.log(`  入力: Sheets ${report.summary.inputCounts.sheetsRows} 行 + booking_status ${report.summary.inputCounts.bookingStatus} 行`);
  console.log(`  出力: patients ${report.summary.totalPatients} 患者 / visits ${report.summary.totalVisits} 予約`);
  console.log(`  平均 visits/patient: ${report.summary.averageVisitsPerPatient}`);
  console.log(`  契約金額合計: ¥${report.summary.totalContractAmount.toLocaleString()} (${report.summary.contractCount} 件)`);
  console.log(`\n【警告】`);
  console.log(`  複数医院 (同一患者が別医院で受診): ${report.warnings.multiFacility} 件`);
  console.log(`  電話番号無しの複数申込 (別人 vs 同一の判別困難): ${report.warnings.noPhoneMultiVisit} 件`);
  console.log(`  DB のみ存在 (Sheets に紐付かない booking_status 行): ${report.summary.orphanBookingStatus} 件`);
  console.log(`\n【状態分布 top】`);
  const topStatuses = Object.entries(report.statusHistogram)
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
  topStatuses.forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v}`));
  console.log(`\n完全レポート → ${outFile}`);
  console.log('\n【判断】このサマリで違和感なければ Phase 2 (本番 import) へ。');
  console.log('  違和感あれば .dry-run-report.json を私に送ってください。');
}

main().catch(e => {
  console.error('\n✗ ERROR:', e);
  process.exit(1);
});
