/* ============================================================
 * sheet-sync Worker v924
 *   booking sync_source を行番号 → 内容ベース (name|book_date|register_at) に変更。
 *     元データ tab は新着が先頭 (降順) に入るため row=N が毎回ズレ、新規予約が
 *     既存 sync_source と衝突 → ignore-duplicates で silent drop されていた
 *     (2026-09 プロモ消失の根本原因)。
 *   併せて deleted / 重複削除 行の (patient, book_date) も INSERT ガードに追加
 *     (キー方式変更による削除済み行の復活を防止)。
 * v923:
 *   C6: PATCH/POST 失敗を patchErrs に集約 (従来 console.log のみ silent 失敗)
 *   B5: cutoff_date fallback を 2026-04-01 に統一 (env.CUTOFF_DATE 優先)
 * v922: A0 要確認 昇格判定に book_date 一致条件を追加
 *   A0: キャンセル入力 + 実来院 → status='要確認' に強制昇格 (isTouched 例外)
 *   A1: Phase 7 PATCH に status=eq.未対応 楽観排他 (Aladdin 保存優先)
 *   A3: 同名別電話 検出時 warning ログ (真の分離は DB migration 要)
 *   A4: rowsInserted / flaggedCancel を response に追加 (Aladdin 側視覚更新用)
 *   Cron: なし (Aladdin ブラウザから 10 分毎 fetch)
 *   HTTP: /status, /sync (手動、要 token), /debug
 *
 * v900 の設計:
 *
 *   Phase A: 予約管理シート (BOOKING_SHEET) → patient_visits INSERT
 *      - 5 タブ (元データ + 4 セレクト) を fetch
 *      - source_tool='DXHUB' or 'セレクト' で INSERT
 *      - status='未対応' (来院待ち)
 *      - sync_source='booking:<tab>:<normalized_name>|bk=<date>|reg=<register_at>' で dedup (v924)
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
// v915: 旧字体 → 常用漢字 正規化 (歯科患者名で頻出のもの)
//   髙橋 vs 高橋、齋藤 vs 斉藤 等の matcher バグ対策。
//   **削除**: 別人を誤マージするリスクの高い姓の異体字 (嶋↔島 中嶋/中島, 邊↔辺 渡邊/渡辺 等)。
//              これらは normalized_name unique index と組み合わせて別人統合の恐れ大。
//   残す: 髙↔高 (髙橋/高橋)、﨑↔崎、齋↔斉、眞↔真、濱↔浜、廣↔広、澤↔沢、惠↔恵、德↔徳、龍↔竜
//         (これらは殆どの場合同一人物のゆらぎ)
const KYUJITAI_MAP = {
  '髙':'高','﨑':'崎','德':'徳','齋':'斉','齊':'斉',
  '眞':'真','濱':'浜','廣':'広','澤':'沢',
  '惠':'恵','龍':'竜','萬':'万',
};
function normName(n) {
  if (n == null) return '';
  let s = String(n).replace(/[\s　]+/g, '').toLowerCase();
  let out = '';
  for (const ch of s) out += KYUJITAI_MAP[ch] || ch;
  return out;
}

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

// v915: 保護判定を厳格化。
//   ・'未対応' のみ「まだ sync が触ってない」= 対象。
//   ・'来院済' は sync が一度確定済み → 別 initial 行に誤 claim されるのを防ぐため touched 扱い。
//   ・contract_amount = 0 でも「値が入ってる」なら人間が触った扱い (NULL のみ空とみなす)。
const SYNC_MANAGED_STATUS = new Set(['未対応']);
function isTouched(visit) {
  if (visit.memo != null && String(visit.memo).length > 0) return true;
  if (visit.contract_amount != null) return true;                              // v915: 0 円成約も保護
  if (visit.next_visit_date != null) return true;
  const u = visit.updated_by;
  if (u && String(u).includes('@')) return true;
  if (visit.status && !SYNC_MANAGED_STATUS.has(visit.status)) return true;
  return false;
}

// v910: シート反映 = 「来院済」で一律 INSERT/UPDATE。
//   スタッフが後で「検討中(まだ考え中)」or「成約(治療進行)」に手動振り分け。
//   保険初診の自動「治療中」も廃止 (振り分けは人間の判断)。
const SHEET_ARRIVED_STATUS = '来院済';
function statusFromReason(_reason) { return SHEET_ARRIVED_STATUS; }

// v912: 初診由来 (source_channel) の一部をプロモコードに昇格
//   ユーザー方針: スマイルモア/ウィスマイル/オーマチティース の 3 種は
//   広告経由の識別として promo_code に反映する (半角/全角カナ両対応)。
const SOURCE_TO_PROMO = {
  'スマイルモア': 'スマイルモア', 'ｽﾏｲﾙﾓｱ': 'スマイルモア',
  'ウィスマイル': 'ウィスマイル', 'ｳｨｽﾏｲﾙ': 'ウィスマイル', 'ウイスマイル': 'ウィスマイル',
  'オーマチティース': 'オーマチティース', 'ｵｰﾏﾁﾃｨｰｽ': 'オーマチティース',
};
function promoFromSource(src) {
  if (!src) return null;
  return SOURCE_TO_PROMO[String(src).trim()] || null;
}

// v917: テストデータ判定 — シート側にゴミ名残ってても再作成しない
//   'テスト', 'テストテスト', 'テスト_xxx', 'てすと', 'test' 等を除外
function isTestName(name) {
  if (!name) return true;   // 名前空も除外
  const s = String(name).trim().toLowerCase().replace(/[\s　]+/g, '');
  if (!s) return true;
  return /^(テスト|てすと|test)/.test(s) || /テスト/.test(s);
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
    if (isTestName(rawName)) continue;   // v917: シート側のテストデータを sync 対象外
    const { date: bookDate, at: bookAt } = parseJpDateTime(rawBookAt);
    if (!bookDate || bookDate < cutoffIso) continue;
    // v920: register_at (申込日 col) を apply_date に分離
    //   従来は apply_date = book_date で「申込日 == 予約日」になり、来院タブで日付が同じで
    //   セレクトタイプの申込タイミングが読めなかった。register_at を親候補にする。
    const rawRegAt = cols.register_at != null ? r[cols.register_at] : null;
    const { date: applyDateFromReg, at: applyAtFromReg } = parseJpDateTime(rawRegAt);
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
      apply_date: applyDateFromReg || bookDate,   // v920: 申込日 (register_at 由来)
      apply_at: applyAtFromReg || bookAt,         // v920: 申込日時 (register_at 由来)
      patient_name: String(rawName).trim(),
      normalized_name: nn,
      phone: phone || null,
      phone_last4: phone ? phone.slice(-4) : null,
      email: cols.email != null ? String(r[cols.email] || '').trim() || null : null,
      service: cols.service != null ? String(r[cols.service] || '').trim() || null : null,
      // v729: セレクトタブ (cols.promo_code 未定義) は legacy 移行データ ('セレクトタイプ') と
      //   shape を揃えて promo_code を明示付与。分析タブ/来院タブでの表示乖離を解消。
      //   ※ 実効化には要デプロイ (app.js 側にも表示 fallback を追加済み)
      promo_code: cols.promo_code != null
        ? (String(r[cols.promo_code] || '').trim() || null)
        : (tab.tool === 'セレクト' ? 'セレクトタイプ' : null),
      // v924: 行番号は新着先頭挿入で毎回ズレるため、内容ベースの安定キーに変更。
      //   register_at (申込日時) + 正規化名 + 予約日 は行位置に依存しない。
      sync_source: `booking:${tab.name}:${nn}|bk=${bookDate}|reg=${String(rawRegAt || rawBookAt).trim()}`,
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
    if (isTestName(rawName)) continue;   // v917: シート側のテストデータを sync 対象外
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
  // v923 C6: PATCH/POST 失敗を rowsError に集約 (従来は console.log のみ silent 失敗)
  let patchErrs = 0;
  const patchErrMsgs = [];
  const recordErr = (label, res, body) => {
    patchErrs++;
    const msg = `${label} ${res.status} ${String(body || '').slice(0, 200)}`;
    patchErrMsgs.push(msg);
    console.log(msg);
  };

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

  // ---- Phase 3+4 統合 (v914): POST upsert で SELECT + INSERT を 1 段化 ----
  //   Free tier 50 subreq 対応 (SELECT chunk が cutoff 拡張で 50+ を超えるため)
  //   resolution=merge-duplicates: 既存行は指定フィールドが上書きされる。
  //   name/facility/phone はシート由来が最新なので上書き許容。
  // v915: PostgREST batch は全レコードで同じキー要求 (PGRST102) → 4 key 統一。
  //   同一 normalized_name の候補が複数ある場合、phone/phone_last4 が入ってる方を優先採用。
  //   これで「同じ人が sheet の複数場所に出て、片方だけ電話あり」でも既存電話を潰さない。
  //   primary_facility は多院利用者を守るため payload に一切含めない (新規 INSERT では NULL)。
  const uniquePatients = new Map();
  const suspectSamenameDiffPhone = [];   // v921 A3: 同名別電話 検出ログ用
  for (const c of allCandidates) {
    const existing = uniquePatients.get(c.normalized_name);
    if (existing) {
      // v921 A3: 別電話で来た同姓同名は警告 (DB unique index の関係で今は分離できない)
      if (existing.phone_last4 && c.phone_last4 && existing.phone_last4 !== c.phone_last4) {
        suspectSamenameDiffPhone.push({ name: c.patient_name, p1: existing.phone_last4, p2: c.phone_last4 });
      }
      if (!existing.phone && c.phone) existing.phone = c.phone;
      if (!existing.phone_last4 && c.phone_last4) existing.phone_last4 = c.phone_last4;
      continue;
    }
    uniquePatients.set(c.normalized_name, {
      name: c.patient_name,
      normalized_name: c.normalized_name,
      phone: c.phone || null,
      phone_last4: c.phone_last4 || null,
    });
  }
  if (suspectSamenameDiffPhone.length > 0) {
    console.log('v921 A3 WARN 同名別電話検出:', suspectSamenameDiffPhone.slice(0, 20));
  }
  const patientMap = new Map();
  const patArr = Array.from(uniquePatients.values());
  const P_BATCH = 1000;   // v915: PostgREST default 1000-row response limit と揃える (超えると response truncate)
  for (let i = 0; i < patArr.length; i += P_BATCH) {
    const batch = patArr.slice(i, i + P_BATCH);
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/patients?on_conflict=normalized_name`, {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=representation,resolution=merge-duplicates' }),
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      return await finalize(env, triggerName, startMs, bookingPerTab, initialPerTab, 0, 0, 0, 0, 0, allCandidates.length,
        `patients UPSERT batch ${i} failed: ${res.status} ${await res.text()}`);
    }
    const rows = await res.json();
    for (const p of (Array.isArray(rows) ? rows : [])) patientMap.set(p.normalized_name, p.id);
  }

  // ---- v916: Phase 5 の前に「触った (patient, book_date)」を SELECT して事前フィルタ ----
  //   sheet-sync が新規 booking を INSERT する前に、既に staff が処理済の (patient, date) は skip して重複防止。
  //   Phase 6 の visitsByPatFac 構築にも同じ結果を使い回して subreq 節約。
  const allVisSelBase = `${env.SUPABASE_URL}/rest/v1/patient_visits?book_date=gte.${cutoffIso}&deleted=eq.false&status=neq.${encodeURIComponent('重複削除')}&select=id,patient_id,facility,book_date,apply_at,status,memo,contract_amount,next_visit_date,updated_by,source_tool,promo_code&order=id`;
  const allExistingVisits = [];
  const VIS_CHUNK_ALL = 1000;
  for (let offset = 0; offset < 100000; offset += VIS_CHUNK_ALL) {
    const visRes = await fetch(`${allVisSelBase}&offset=${offset}&limit=${VIS_CHUNK_ALL}`, { headers: sbHeaders(env) });
    if (!visRes.ok) {
      return await finalize(env, triggerName, startMs, bookingPerTab, initialPerTab, 0, 0, 0, 0, 0, initialCandidates.length,
        `visits pre-SELECT offset ${offset} failed: ${visRes.status} ${await visRes.text()}`);
    }
    const rows = await visRes.json();
    allExistingVisits.push(...rows);
    if (rows.length < VIS_CHUNK_ALL) break;
  }
  // v918: touched だけでなく「存在するだけ」で新規 INSERT を skip する (完全重複防止)。
  //   これで同 (patient, book_date) には常に 1 行しかない状態を維持。
  const existingPatDate = new Set();   // Phase 5 booking / Phase 8 walk-in の両方でチェック
  const existingPatApply = new Set();  // v924: (patient_id, apply_at) unique 制約の事前衝突チェック用
  const touchedPatDate = new Set();    // Phase 6 で untouched 判定に使う (残す)
  for (const v of allExistingVisits) {
    existingPatDate.add(`${v.patient_id}|${v.book_date}`);
    if (v.apply_at) existingPatApply.add(`${v.patient_id}|${Date.parse(v.apply_at)}`);
    const isTouchedV = (v.memo && v.memo.length > 0) || v.contract_amount != null || v.next_visit_date != null
      || (v.updated_by && String(v.updated_by).includes('@')) || (v.status && !SYNC_MANAGED_STATUS.has(v.status));
    if (isTouchedV) touchedPatDate.add(`${v.patient_id}|${v.book_date}`);
  }
  // v924: deleted / 重複削除 行の (patient, book_date) も INSERT ガードに追加。
  //   sync_source が内容ベースになったため、過去に削除・重複整理した行が
  //   「存在しない」扱いで再INSERT (復活) するのを防ぐ。existingPatDate のみに足し、
  //   allExistingVisits (Phase 6 マッチ対象) には含めない。
  const guardSelBase = `${env.SUPABASE_URL}/rest/v1/patient_visits?book_date=gte.${cutoffIso}&or=(deleted.eq.true,status.eq.${encodeURIComponent('重複削除')})&select=patient_id,book_date,apply_at&order=id`;
  for (let offset = 0; offset < 20000; offset += VIS_CHUNK_ALL) {
    const gRes = await fetch(`${guardSelBase}&offset=${offset}&limit=${VIS_CHUNK_ALL}`, { headers: sbHeaders(env) });
    if (!gRes.ok) {
      return await finalize(env, triggerName, startMs, bookingPerTab, initialPerTab, 0, 0, 0, 0, 0, initialCandidates.length,
        `guard SELECT offset ${offset} failed: ${gRes.status} ${await gRes.text()}`);
    }
    const rows = await gRes.json();
    for (const v of rows) {
      existingPatDate.add(`${v.patient_id}|${v.book_date}`);
      if (v.apply_at) existingPatApply.add(`${v.patient_id}|${Date.parse(v.apply_at)}`);
    }
    if (rows.length < VIS_CHUNK_ALL) break;
  }

  // ---- Phase 5: 予約管理シート → patient_visits INSERT (dedup on sync_source + touched patient+date) ----
  let bookingInserted = 0;
  let bookingSkippedTouched = 0;
  const bookingPayload = bookingCandidates
    .filter(c => patientMap.has(c.normalized_name))
    .filter(c => {
      // v916: 既に触った行がある patient+book_date に新規 booking を作らない (重複防止の恒久対策)
      const pid = patientMap.get(c.normalized_name);
      if (existingPatDate.has(`${pid}|${c.book_date}`)) { bookingSkippedTouched++; return false; }   // v918: touched から existing に強化
      return true;
    })
    .map(c => {
      // v920: apply_date/apply_at は candidate (register_at 由来) を優先。fallback で book_date。
      const sec = hashSec(c.sync_source);
      const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
      const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      const applyAtFallback = `${c.book_date}T${hh}:${mm}:${ss}+09:00`;
      return {
        patient_id: patientMap.get(c.normalized_name),
        facility: c.facility,
        book_date: c.book_date,
        book_at: c.book_at,
        apply_date: c.apply_date || c.book_date,
        apply_at: c.apply_at || applyAtFallback,
        status: '未対応',
        service: c.service,
        source_tool: c.tool,
        promo_code: c.promo_code,
        sync_source: c.sync_source,
        updated_by: 'system-sync',
        created_by: 'system-sync',
      };
    })
    .filter(p => {
      // v924: (patient_id, apply_at) unique 制約との衝突を事前除外。
      //   on_conflict=sync_source では別キーの衝突が 409 になり batch 全体が落ちるため
      //   (予約日変更でシート行が書き換わったケース等)。batch 内の重複も同時に除く。
      const k = `${p.patient_id}|${Date.parse(p.apply_at)}`;
      if (existingPatApply.has(k)) { bookingSkippedTouched++; return false; }
      existingPatApply.add(k);
      return true;
    });
  const BATCH_B = 2000;
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
      recordErr('booking INSERT batch failed', iRes, await iRes.text());
    }
  }

  // ---- Phase 6: 初診管理シート → マッチ + UPDATE/INSERT ----
  //   v921: Aladdin 優先原則 — status が '未対応' の行だけを '来院済' へ更新するのが基本。
  //         唯一の例外 = **キャンセル入力なのに実来院あり** → status='要確認' に強制上書き
  //         (打ち間違い / 来院確認漏れ を可視化)
  const existingVisits = allExistingVisits.filter(v => v.status === '未対応');
  const cancelledVisits = allExistingVisits.filter(v => v.status === 'キャンセル');

  // v911 Phase 2: matcher (patient_id, facility) — 未対応行対象
  const visitsByPatFac = new Map();
  for (const v of existingVisits) {
    const key = `${v.patient_id}|${normFac(v.facility)}`;
    if (!visitsByPatFac.has(key)) visitsByPatFac.set(key, []);
    visitsByPatFac.get(key).push(v);
  }
  // v922: A0 用 — キャンセル行の (patient_id, facility, book_date) index
  //   v921 は (patient_id, facility) だけで拾ってしまい、過去別日の来院記録がある人の
  //   別日キャンセルまで誤検出していた。同日一致のみに絞る。
  const cancelByPatFacDate = new Map();
  for (const v of cancelledVisits) {
    const key = `${v.patient_id}|${normFac(v.facility)}|${v.book_date}`;
    if (!cancelByPatFacDate.has(key)) cancelByPatFacDate.set(key, []);
    cancelByPatFacDate.get(key).push(v);
  }

  const toUpdate = [];
  const promoUpdates = [];
  const toInsert = [];
  const toFlagCancel = [];   // v921 A0: キャンセル→要確認 に昇格する id リスト
  const claimed = new Set();
  let skippedTouched = 0;
  let dbg_no_patient = 0;
  const daysBetween = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
  for (const c of initialCandidates) {
    const patientId = patientMap.get(c.normalized_name);
    if (!patientId) { dbg_no_patient++; continue; }
    const key = `${patientId}|${c.facility}`;
    // v922 A0: 同日一致のみ 要確認 昇格 (patient_id + facility + book_date)
    const cancelKey = `${patientId}|${c.facility}|${c.book_date}`;
    const cancels = cancelByPatFacDate.get(cancelKey) || [];
    for (const cv of cancels) {
      if (!claimed.has(cv.id)) {
        claimed.add(cv.id);
        toFlagCancel.push(cv.id);
      }
    }
    const matches = (visitsByPatFac.get(key) || []).filter(m => !claimed.has(m.id));
    const sheetPromo = promoFromSource(c.source_channel);
    if (matches.length > 0) {
      const untouched = matches.filter(m => !isTouched(m));
      if (untouched.length > 0) {
        untouched.sort((a, b) => daysBetween(a.book_date, c.book_date) - daysBetween(b.book_date, c.book_date));
        const target = untouched[0];
        claimed.add(target.id);
        toUpdate.push({ id: target.id, newBookDate: c.book_date });
        if (sheetPromo && target.promo_code == null) promoUpdates.push({ id: target.id, promo: sheetPromo });
      } else {
        skippedTouched++;
      }
    } else if (cancels.length === 0) {
      // v918: キャンセルで既に flag 済ならもう INSERT しない
      if (existingPatDate.has(`${patientId}|${c.book_date}`)) {
        skippedTouched++;
      } else {
        toInsert.push({ candidate: c, patient_id: patientId, status: statusFromReason(c.reason), promo: sheetPromo });
      }
    }
  }

  // ---- Phase 7: UPDATE (booking 行 → 来院済) ----
  // v921 A1: 楽観排他。SELECT した瞬間に status='未対応' でも、PATCH までの数秒間に
  //   Aladdin 側でユーザーが status を別値に変更した可能性がある。
  //   `?status=eq.未対応` を URL 条件に追加することで、PATCH は「まだ未対応の行だけ」を対象にする。
  //   Aladdin で '成約' 等に手動更新した行は自然に上書きから守られる。
  let updated = 0;
  if (toUpdate.length > 0) {
    const BATCH_U = 100;
    for (let i = 0; i < toUpdate.length; i += BATCH_U) {
      const chunk = toUpdate.slice(i, i + BATCH_U);
      const idList = chunk.map(u => `"${u.id}"`).join(',');
      const patchUrl = `${env.SUPABASE_URL}/rest/v1/patient_visits?id=in.(${encodeURIComponent(idList)})&status=eq.${encodeURIComponent('未対応')}`;
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
        body: JSON.stringify({ status: SHEET_ARRIVED_STATUS, updated_by: 'sheet-came' }),
      });
      if (patchRes.ok) {
        const updatedRows = await patchRes.json();
        updated += Array.isArray(updatedRows) ? updatedRows.length : 0;
      } else {
        recordErr('visits PATCH batch failed', patchRes, await patchRes.text());
      }
    }
  }

  // ---- Phase 7c (v921 A0): キャンセル → 要確認 昇格 ----
  //   Aladdin で「キャンセル」入力しているのに 初診シートに来院記録あり → status='要確認' に強制。
  //   isTouched 保護を突破する唯一の例外 (打ち間違い/漏れの可視化)。
  let flaggedCancel = 0;
  if (toFlagCancel.length > 0) {
    const BATCH_F = 100;
    for (let i = 0; i < toFlagCancel.length; i += BATCH_F) {
      const chunk = toFlagCancel.slice(i, i + BATCH_F);
      const idList = chunk.map(id => `"${id}"`).join(',');
      const patchUrl = `${env.SUPABASE_URL}/rest/v1/patient_visits?id=in.(${encodeURIComponent(idList)})&status=eq.${encodeURIComponent('キャンセル')}`;
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
        body: JSON.stringify({ status: '要確認', updated_by: 'sheet-cancel-flag' }),
      });
      if (patchRes.ok) {
        const updatedRows = await patchRes.json();
        flaggedCancel += Array.isArray(updatedRows) ? updatedRows.length : 0;
      } else {
        recordErr('cancel→要確認 PATCH failed', patchRes, await patchRes.text());
      }
    }
  }

  // ---- Phase 7b: promo 昇格 (シート 初診由来 → promo_code) ----
  //   promo が同じもの同士でグループ化して PATCH id=in.() を打つ (通常 3 種以下)
  const promoGroups = new Map();
  for (const p of promoUpdates) {
    if (!promoGroups.has(p.promo)) promoGroups.set(p.promo, []);
    promoGroups.get(p.promo).push(p.id);
  }
  for (const [promo, ids] of promoGroups) {
    const idList = ids.map(id => `"${id}"`).join(',');
    const url = `${env.SUPABASE_URL}/rest/v1/patient_visits?id=in.(${encodeURIComponent(idList)})`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ promo_code: promo }),
    });
    if (!res.ok) recordErr('promo PATCH failed', res, await res.text());
  }

  // ---- Phase 8: INSERT (直予約 walk-in) ----
  let walkinInserted = 0;
  const insPayload = toInsert.map(({ candidate: c, patient_id, status, promo }) => {
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
      promo_code: promo || null,
      sync_source: c.sync_source,
      updated_by: 'sheet-direct',
      created_by: 'sheet-direct',
    };
  });
  const BATCH_W = 2000;
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
      recordErr('walk-in INSERT batch failed', iRes, await iRes.text());
    }
  }

  // v919: sync 直後に Supabase RPC auto_dedup() を呼んで NULL 正規化 & 重複整理を自動化
  //   (ユーザは 1 度だけ SQL Editor で `CREATE FUNCTION auto_dedup()` を実行しておく必要あり)
  let dedupResult = null;
  try {
    const rpcRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/auto_dedup`, {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json' }),
      body: '{}',
    });
    if (rpcRes.ok) {
      dedupResult = await rpcRes.json();
    } else {
      dedupResult = { error: `rpc ${rpcRes.status}: ${(await rpcRes.text()).slice(0, 200)}` };
    }
  } catch (e) { dedupResult = { error: String(e.message || e) }; }

  return await finalize(env, triggerName, startMs, bookingPerTab, initialPerTab,
    bookingInserted, updated, walkinInserted, skippedTouched,
    bookingCandidates.length + initialCandidates.length,
    patchErrs,                                                          // v923 C6: PATCH エラー数を rowsError に集約
    patchErrs > 0 ? patchErrMsgs.slice(0, 5).join(' | ') : undefined,   // v923 C6: エラーメッセージ (先頭 5 件)
    { patientMapSize: patientMap.size, uniquePatientsSize: uniquePatients.size, no_patient_id: dbg_no_patient,
      untouchedVisits: existingVisits.length, allExistingVisits: allExistingVisits.length,
      touchedPatDate: touchedPatDate.size, bookingSkippedTouched, autoDedup: dedupResult,
      samenameDiffPhoneCount: suspectSamenameDiffPhone.length,
      patchErrs,                                                        // v923 C6: 詳細確認用
    }, flaggedCancel);
}

async function finalize(env, trigger, startMs, bookingPerTab, initialPerTab,
                        bookingInserted, initialUpdated, walkinInserted, skippedTouched, rowsRead, rowsError, errorMessage, extraDbg, flaggedCancel = 0) {
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
    // v921: Aladdin 側 UI が rowsInserted を参照するので新規追加 (bookingInserted + walkinInserted)
    rowsInserted: (bookingInserted || 0) + (walkinInserted || 0),
    rowsSkipped: (initialUpdated || 0) + (skippedTouched || 0),
    bookingInserted: bookingInserted || 0,
    rowsUpdatedInitial: initialUpdated || 0,
    walkinInserted: walkinInserted || 0,
    rowsSkippedTouched: skippedTouched || 0,
    flaggedCancel: flaggedCancel || 0,   // v921 A0
    rowsError: errs,
    durationMs, errorMessage,
    dbg: extraDbg,
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
        service: 'sheet-sync v924',
        latest: Array.isArray(latest) && latest.length > 0 ? latest[0] : null,
      }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response('sheet-sync v924\n\nGET /status  → 最新の同期結果\nGET /sync?token=xxx → 手動同期\nGET /debug?token=xxx → 診断\n', {
      headers: { ...cors, 'Content-Type': 'text/plain' },
    });
  },
};
