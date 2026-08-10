/* ============================================================
 * Aladdin v600 — Supabase 単一データ源版
 *
 * 設計方針:
 *   - 入力したものは絶対に消えない (UPDATE by id、race なし)
 *   - Sheets 非依存 (patients/patient_visits/status_events を直接 read/write)
 *   - 全 UPDATE は主キー id 指定なので name variant / date format の
 *     ジョイン問題が原理的に発生しない
 *   - 失敗は必ず可視化 (silent save なし)
 *
 * v521 との違い:
 *   - Google Sheets を毎回丸ごと fetch しない
 *   - bookingsData を丸ごと置換しない (差分更新)
 *   - name / apply_date の完全一致ジョインが要らない
 * ============================================================ */

(() => {
'use strict';

// v607: このバージョン識別子と ../v600/version.txt を比較して更新バナーを出す
const APP_VERSION = 'v730';

// v725: 起動直後 self-heal — この app.js が古い cached HTML から呼ばれていたら即 auto-reload。
//   HTML と app.js が cache 上ずれた状態を検出して 1回だけ URL bust リロードで直す。
(async () => {
  try {
    const r = await fetch('./version.txt?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const remote = (await r.text()).trim();
    if (remote && remote !== APP_VERSION) {
      // ループ防止: URL に ?bust= が既にあれば再リロードしない (直近試行済み)
      if (!location.search.includes('bust=')) {
        console.log('[self-heal] APP=' + APP_VERSION + ' remote=' + remote + ' → force reload');
        location.replace(location.pathname + '?bust=' + Date.now());
      }
    }
  } catch (_) { /* offline なら諦める */ }
})();

// v700: 初診管理シート → Aladdin 同期 Worker (v704: URL 修正: 実際は seishokai account)
const SHEET_SYNC_WORKER = 'https://sheet-sync.seishokai.workers.dev';
const SHEET_SYNC_TOKEN = 'aladdin-sync-2026';

// ==================== Config ====================
const SUPABASE_URL = 'https://ndlfqrvoejwgqfdtghmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5kbGZxcnZvZWp3Z3FmZHRnaG1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1ODIxNjcsImV4cCI6MjA5MTE1ODE2N30.pE-l-4NgQTpEb9DvjeRptargvrsYH9YKyRLt06flPik';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// Status options — 使用頻度順 (ユーザー指定: 未対応 → キャンセル → 検討中 → 残り)
// v606: 「確認済」は使わないので削除
const STATUS_OPTIONS = [
  '未対応', 'キャンセル', '検討中',
  '来院済', '予約変更',
  '予約連絡待ち', '後追いLINE済み', '離脱',
  '成約', 'ローン審査中', 'ローン審査落',
  '矯正決定(BF保留)', 'ラブリエ決定(BF保留)', 'インプラント決定(BF保留)',
  '印象待ち(治療無)', '印象待ち(治療有)', '治療中',
  'セット日確定待ち', 'セット待ち', 'セット完了',
  '除外', '重複削除',
];
// v707: '重複削除' はデフォルト非表示 & カウント除外 (staff がシート重複を潰した行の墓場)
const STATUS_HIDDEN_BY_DEFAULT = new Set(['重複削除']);

const FACILITIES = [
  'BF銀座', 'エスカ', 'アール', 'ウィズ', 'ルミナス',
  '茶屋', 'アサノ', '知立', '小牧', '八事', '岩田', '大森', '京都', '訪問',
];

// v600 fix #8: 予約枠 JSON の格納先 (github.io からの相対パス)
const SLOT_JSON = {
  shareconnect: '../data/reservation-status.json',
  apotool:      '../data/apotool-status.json',
};

// v601 fix: 予約一覧 (read-only) の Google Sheets ソース (v521 の loadBookings と同じ URL)
const BK_SHEET_ID = '10misKpAtMitwIagGDUoMvQS7U9pfEQ0ODxG8A7DLzaQ';
const BK_SHEETS = [
  { label: '元データ', encoded: '%E5%85%83%E3%83%87%E3%83%BC%E3%82%BF', tool: 'DXHUB' },
  { label: '銀座セレクトタイプ', encoded: '%E9%8A%80%E5%BA%A7%E3%82%BB%E3%83%AC%E3%82%AF%E3%83%88%E3%82%BF%E3%82%A4%E3%83%97', tool: 'セレクト', facility: 'BF銀座' },
  { label: 'ウィズセレクトタイプ', encoded: '%E3%82%A6%E3%82%A3%E3%82%BA%E3%82%BB%E3%83%AC%E3%82%AF%E3%83%88%E3%82%BF%E3%82%A4%E3%83%97', tool: 'セレクト', facility: 'ウィズ' },
  { label: '京都セレクトタイプ', encoded: '%E4%BA%AC%E9%83%BD%E3%82%BB%E3%83%AC%E3%82%AF%E3%83%88%E3%82%BF%E3%82%A4%E3%83%97', tool: 'セレクト', facility: '京都' },
  { label: 'ルミナスセレクトタイプ', encoded: '%E3%83%AB%E3%83%9F%E3%83%8A%E3%82%B9%E3%82%BB%E3%83%AC%E3%82%AF%E3%83%88%E3%82%BF%E3%82%A4%E3%83%97', tool: 'セレクト', facility: 'ルミナス' },
];

// ==================== State ====================
const state = {
  user: null,           // Supabase user
  view: 'visits',
  slots: null,          // { shareconnect, apotool } fetched JSONs
  bookings: null,       // 予約一覧 (Sheets 読取) の生データ
  bookingFilters: { search: '', facility: '', tool: '' },
  a2Period: 'all',      // v719: 分析タブの期間フィルタ
  a2Filters: { facility: '', treatment: '', promo: '' },   // v721: 分析タブの絞込
  visits: [],           // v_visits_with_patient rows
  patients: [],         // patients rows
  loading: false,
  filters: {
    search: '',
    facility: '',
    treatment: '',
    promo: '',
    status: '',
    period: 'all',      // 'thisMonth' | 'lastMonth' | '30'/'60'/'90'/'365' | 'month' | 'range' | 'all'
    periodMonth: '',    // YYYY-MM (when period === 'month')
    periodFrom: '',     // YYYY-MM-DD (when period === 'range')
    periodTo: '',       // YYYY-MM-DD (when period === 'range')
    dupOnly: false,     // v710: 同日同患者に複数行ある行だけ表示
  },
  memoTarget: null,     // { visit_id, name, current_memo }
};

// ==================== Utils ====================
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// v521 の getTreatmentCategory を移植: service 文字列 → 治療カテゴリ短縮
// v601 fix: 「削らないラミネートベニア」→ ラブリエ (0.04mmジルコニアラミネート) に修正。
//   従来は s.includes('ラミネート') → BF となっていて全部 BF 表示だった。
//   BF = ブラックフィルム、ラブリエ = 削らないラミネートベニア (別商材)。
function getTreatment(service, contractService) {
  const s = String(service || '').toLowerCase();
  const cs = String(contractService || '');
  if (cs && (cs.includes('矯正') || cs === 'BF')) {
    if (cs === 'BF') return 'BF';
    return '矯正';
  }
  if (cs.includes('ﾗﾌﾞﾘｴ') || cs.includes('ラブリエ')) return 'ラブリエ';
  if (cs.includes('ｲﾝﾌﾟﾗﾝﾄ') || cs.includes('インプラント')) return 'インプラント';
  // v601: BF は「ブラック」または「BF」を含む場合のみ (ラミネート は含まない)
  if (s.includes('ブラック') || s.includes('bf')) return 'BF';
  // 「削らない」「ラミネート」「ラブリエ」いずれか含めばラブリエ
  if (s.includes('ラブリエ') || s.includes('ラミネート') || s.includes('削らない')) return 'ラブリエ';
  if (s.includes('インプラント') || s.includes('ｲﾝﾌﾟﾗﾝﾄ')) return 'インプラント';
  if (s.includes('矯正')) return '矯正';
  // v705: sheet-sync 由来行の追加カテゴリ (保険初診 / ホワイトニング / 審美)
  if (s.includes('保険')) return '保険';
  if (s.includes('ホワイトニング') || s.includes('ﾎﾜｲﾄﾆﾝｸﾞ')) return 'WT';
  if (s.includes('審美')) return '審美';
  if (s.includes('補綴')) return '補綴';
  if (s.includes('転院')) return '転院';
  // v706: 治療のその他は基本ない (セレクトタイプ booking 行等で service 空の場合) → 空返し (render 側で '-' 表示)
  return '';
}

// 成約商材の選択肢 (v521 と同じ)
const CONTRACT_SERVICE_OPTIONS = ['', 'BF', '矯正(表)', '矯正(裏)', '矯正(ﾋﾟｰｽ)', 'ﾗﾌﾞﾘｴ', 'ｲﾝﾌﾟﾗﾝﾄ'];

// プロモコード → 表示ラベル短縮
function shortPromo(p) {
  if (!p) return '';
  if (p === 'セレクトタイプ') return 'セレクト';   // v716: 略記 (両タブ共通)
  return p.length > 14 ? p.slice(0, 14) + '…' : p;
}

// v521 の normFac (医院名正規化) を移植: DXHUB のフル名を短縮名に寄せる
function normFac(f) {
  if (!f) return '';
  const s = String(f);
  if (s.includes('BF銀座')) return 'BF銀座';
  if (s.includes('銀座'))   return 'BF銀座';
  if (s.includes('中日'))   return 'BF中日';
  if (s.includes('BF'))     return 'BF銀座';   // "BF◯◯" → BF銀座扱い
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

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const m = d.getMonth() + 1, day = d.getDate();
  return `${m}/${day}`;
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const y = String(d.getFullYear()).slice(2);
  const m = d.getMonth()+1, day = d.getDate();
  const hh = String(d.getHours()).padStart(2,'0'), mm = String(d.getMinutes()).padStart(2,'0');
  return `${y}/${m}/${day} ${hh}:${mm}`;
}
function fmtRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}秒前`;
  if (diffSec < 3600) return `${Math.floor(diffSec/60)}分前`;
  if (diffSec < 86400) return `${Math.floor(diffSec/3600)}時間前`;
  if (diffSec < 86400*30) return `${Math.floor(diffSec/86400)}日前`;
  return fmtDateTime(iso).split(' ')[0];
}
function fmtYen(n) {
  // v603 fix #9: 0 も明示的に "¥0" 表示 (空だと「保存されてない」と誤認するため)
  if (n == null || n === '') return '';
  const num = Number(n);
  if (isNaN(num)) return '';
  return '¥' + num.toLocaleString();
}
function parseAmount(s) {
  const v = String(s || '').replace(/[^\d-]/g, '');
  if (!v) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
// v603 fix #1: JST 基準の今日 (YYYY-MM-DD)。toISOString() は UTC なので使わない
function todayJst() {
  return new Date().toLocaleDateString('sv-SE');   // "sv-SE" = YYYY-MM-DD
}

// ==================== Toast ====================
function toast(msg, kind='info', ttl=3000) {
  const host = $('#toast-host');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  host.appendChild(el);
  // v730: タップで即消し (モバイル)
  const dismiss = () => { el.style.opacity = '0'; setTimeout(() => el.remove(), 200); };
  el.addEventListener('click', dismiss, { once: true });
  setTimeout(dismiss, ttl);
}

// v730: 編集中フィールド判定 (sheet-sync 中に focus 奪わない用)
function isEditingField() {
  const a = document.activeElement;
  if (!a) return false;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
}

// ==================== Save status ====================
let saveTimer = null;
function setSaveStatus(text, kind='') {
  const el = $('#save-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'save-status ' + kind;
  if (saveTimer) clearTimeout(saveTimer);
  if (kind === 'saved') saveTimer = setTimeout(() => { el.textContent=''; el.className='save-status'; }, 2500);
}

// ==================== Auth ====================
async function checkAuth() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.user || null;
}
// v614: 社員 ID (adachi 等) を入れたら @aladdin.local を自動付与。email 形式ならそのまま。
const STAFF_EMAIL_DOMAIN = 'aladdin.local';
function normalizeLoginId(input) {
  const s = String(input || '').trim();
  if (!s) return s;
  if (s.includes('@')) return s;                    // 既に email
  return `${s.toLowerCase()}@${STAFF_EMAIL_DOMAIN}`;
}
// email → 表示名 (metadata.display_name 優先、無ければ ID 部分)
function displayNameOf(user) {
  if (!user) return '';
  const meta = user.user_metadata || {};
  if (meta.display_name) return meta.display_name;
  const email = user.email || '';
  const local = email.split('@')[0];
  return local;
}
async function login(loginId, pw) {
  const email = normalizeLoginId(loginId);
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pw });
  if (error) throw error;
  return data.user;
}
async function changePassword(newPw) {
  const { error } = await sb.auth.updateUser({ password: newPw });
  if (error) throw error;
  return true;
}
async function logout() {
  await sb.auth.signOut();
  // v603 fix #13: ログアウト時 state をクリア (別ユーザ再ログイン時の一瞬フラッシュ防止)
  state.user = null;
  state.visits = [];
  state.patients = [];
  state.bookings = null;
  state.slots = null;
  _promoPopulatedForCount = -1;
  _bookingsDebounce = null;
  render();
}

// ==================== Data fetch ====================
async function fetchVisits() {
  state.loading = true;
  // v603 fix #1: JST 基準で今日を求める (toISOString だと UTC → 朝の時間帯に本日消失)
  const todayIso = todayJst();
  let all = [];
  const pageSize = 1000;
  let from = 0;
  let hitCap = false;
  for (let page = 0; page < 20; page++) {
    // v711 fix: view が deleted 列を持ってないと Supabase が 400 返す → try/catch で fallback
    // v714 fix: paging で同一行が複数ページに出る問題 (order 不安定) → visit_id を secondary sort に
    let { data, error } = await sb
      .from('v_visits_with_patient')
      .select('*')
      .or(`book_date.is.null,book_date.lte.${todayIso}`)
      .eq('deleted', false)
      .order('book_date', { ascending: false, nullsFirst: false })
      .order('visit_id', { ascending: true })   // v714: ページング安定化
      .range(from, from + pageSize - 1);
    if (error && String(error.code) === '42703') {
      const retry = await sb
        .from('v_visits_with_patient')
        .select('*')
        .or(`book_date.is.null,book_date.lte.${todayIso}`)
        .order('book_date', { ascending: false, nullsFirst: false })
        .order('visit_id', { ascending: true })
        .range(from, from + pageSize - 1);
      data = retry.data; error = retry.error;
    }
    if (error) {
      state.loading = false;
      console.error('fetchVisits', error);
      toast('データ取得に失敗: ' + error.message, 'err', 5000);
      return;
    }
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
    if (page === 19) hitCap = true;
  }
  state.loading = false;
  // v713: View に deleted 列が無い → 別 SELECT で deleted=true の id リストを取得し client 側で除外
  //   (Supabase default limit 1000 対策で range paging も入れる)
  const deletedIds = new Set();
  // v729: deleted 一覧の取得失敗を silent-swallow から toast + console.error に格上げ
  //   (RLS/権限変更で 集計が黙って壊れるのを防ぐ)
  let deletedFetchFailed = false;
  try {
    let dOffset = 0;
    while (dOffset < 20000) {
      const dRes = await sb.from('patient_visits').select('id').eq('deleted', true).range(dOffset, dOffset + 999);
      if (dRes.error) {
        deletedFetchFailed = true;
        console.error('[fetchVisits] deleted 一覧の取得に失敗', dRes.error);
        toast('deleted 一覧の取得に失敗: ' + (dRes.error.message || dRes.error.code || 'unknown'), 'err', 5000);
        break;
      }
      const rows = dRes.data || [];
      for (const r of rows) deletedIds.add(r.id);
      if (rows.length < 1000) break;
      dOffset += 1000;
    }
  } catch (e) {
    deletedFetchFailed = true;
    console.error('[fetchVisits] deleted 一覧取得中に例外', e);
    toast('deleted 一覧取得に例外: ' + (e && e.message ? e.message : e), 'err', 5000);
  }
  state.deletedFetchFailed = deletedFetchFailed;
  // v603 P4/P8: fetch 時に事前計算した検索キー・日付 epoch・正規化フィールドを付与
  const now = Date.now();
  // v712/v713: クライアント側の二重防御 — deleted / テスト / 名前空 を全て除外
  const testRe = /テスト|てすと|test/i;
  all = all.filter(v => {
    if (v.deleted === true) return false;              // v712: 直接 deleted 列があれば
    if (deletedIds.has(v.visit_id) || deletedIds.has(v.id)) return false;   // v713: 別テーブル参照で判定
    const nm = (v.patient_name || '') + (v.normalized_name || '');
    if (!nm.trim()) return false;
    if (testRe.test(nm)) return false;
    return true;
  });
  all.forEach(v => {
    v._effStatus = v.bf_status || v.status || '未対応';
    v._normFacility = normFac(v.facility);
    v._treatment = getTreatment(v.service, v.contract_service);
    v._searchHay = ((v.patient_name || '') + ' ' + (v.normalized_name || '') + ' ' + (v.phone || '')).toLowerCase();
    v._bookMs = v.book_date ? new Date(v.book_date + 'T00:00:00+09:00').getTime() : null;
  });
  // v710: 重複件数を precompute (同一 patient_id + book_date + 重複削除除く)
  const dupBuckets = new Map();
  for (const v of all) {
    if (v._effStatus === '重複削除') { v._dupCount = 0; continue; }
    const k = `${v.patient_id}|${v.book_date}`;
    dupBuckets.set(k, (dupBuckets.get(k) || 0) + 1);
  }
  for (const v of all) {
    v._dupCount = v._effStatus === '重複削除' ? 0 : (dupBuckets.get(`${v.patient_id}|${v.book_date}`) || 1);
  }
  state.visits = all;
  state.visitsFetchedAt = Date.now();
  if (typeof updateDupButton === 'function') updateDupButton();   // v710: 重複ボタンの件数ラベル更新
  // v603 fix #19: 20 page cap 到達時は明示的に warn
  if (hitCap) toast(`⚠ 20k 件の上限に達しました (${all.length} 件のみ表示)`, 'err', 6000);
}

async function fetchPatients() {
  // v603 fix #14 + P1: Supabase default 1000 上限のため range ページング。失敗時は toast。
  let all = [];
  const pageSize = 1000;
  let from = 0;
  for (let page = 0; page < 20; page++) {
    const { data, error } = await sb
      .from('patients')
      .select('id, name, normalized_name, phone_last4, primary_facility, last_activity')
      .eq('deleted', false)
      .order('last_activity', { ascending: false, nullsFirst: false })
      .range(from, from + pageSize - 1);
    if (error) {
      console.error('fetchPatients', error);
      toast('患者取得失敗: ' + error.message, 'err', 5000);
      return;
    }
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  state.patients = all;
}

// ==================== Save operations (安全設計) ====================
// 全 UPDATE は主キー id 指定 → name variant / date miss の可能性なし。
// 失敗時は必ずトーストで可視化。楽観的 UI 更新 + 失敗時 rollback。

async function saveVisitField(visitId, field, value, extra = {}) {
  const patch = { [field]: value, updated_by: state.user?.email || 'unknown', ...extra };
  setSaveStatus('保存中…', 'saving');
  const { data, error } = await sb
    .from('patient_visits')
    .update(patch)
    .eq('id', visitId)
    .select()
    .single();
  if (error) {
    setSaveStatus('保存失敗', 'failed');
    toast(`保存失敗 (${field}): ${error.message}`, 'err', 5000);
    return { ok: false, error };
  }
  const idx = state.visits.findIndex(v => v.visit_id === visitId);
  if (idx >= 0) {
    // v603 fix #12: Object.assign で undefined が入らないよう明示コピー
    const v = state.visits[idx];
    Object.keys(patch).forEach(k => {
      if (patch[k] !== undefined) v[k] = patch[k];
    });
    if (data && data.updated_at) v.updated_at = data.updated_at;
    // 事前計算フィールドの再算出 (status/facility/treatment が変わった時)
    if (patch.status !== undefined || patch.bf_status !== undefined) {
      v._effStatus = v.bf_status || v.status || '未対応';
    }
    if (patch.facility !== undefined) v._normFacility = normFac(v.facility);
    if (patch.contract_service !== undefined) v._treatment = getTreatment(v.service, v.contract_service);
  }
  setSaveStatus('保存完了 ✓', 'saved');
  return { ok: true, data };
}

// ==================== Filtering ====================
function computePeriodRange(f) {
  const now = new Date();
  const p = f.period;
  if (p === 'all') return { fromMs: null, toMs: null };
  if (p === 'thisMonth') {
    return {
      fromMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      toMs:   new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).getTime(),
    };
  }
  if (p === 'lastMonth') {
    return {
      fromMs: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(),
      toMs:   new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).getTime(),
    };
  }
  if (p === 'month') {
    const m = f.periodMonth;
    if (!m) return { fromMs: null, toMs: null };
    const [y, mo] = m.split('-').map(Number);
    return {
      fromMs: new Date(y, mo - 1, 1).getTime(),
      toMs:   new Date(y, mo, 0, 23, 59, 59).getTime(),
    };
  }
  if (p === 'range') {
    return {
      fromMs: f.periodFrom ? new Date(f.periodFrom + 'T00:00:00+09:00').getTime() : null,
      toMs:   f.periodTo   ? new Date(f.periodTo   + 'T23:59:59+09:00').getTime() : null,
    };
  }
  const n = Number(p);
  if (isNaN(n)) return { fromMs: null, toMs: null };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { fromMs: today.getTime() - n * 86400000, toMs: null };
}

function filteredVisits() {
  const f = state.filters;
  const q = f.search.trim().toLowerCase();
  const { fromMs, toMs } = computePeriodRange(f);
  // v603 P4: 事前計算フィールド (_effStatus, _normFacility, _treatment, _searchHay, _bookMs) を利用
  // v603 fix #4: status filter が空の時は 除外/キャンセル をデフォルト非表示
  return state.visits.filter(v => {
    if (f.facility && v._normFacility !== f.facility) return false;
    if (f.treatment && v._treatment !== f.treatment) return false;
    if (f.promo && (v.promo_code || '') !== f.promo) return false;
    // v707: status filter が空なら '重複削除' はデフォルト非表示 & カウント除外
    if (f.status) {
      if (v._effStatus !== f.status) return false;
    } else {
      if (STATUS_HIDDEN_BY_DEFAULT.has(v._effStatus)) return false;
    }
    // v710: 「重複」ボタン: 同日同患者に2行以上ある行だけ
    if (f.dupOnly && (v._dupCount || 0) < 2) return false;
    if ((fromMs || toMs) && v._bookMs) {
      if (fromMs && v._bookMs < fromMs) return false;
      if (toMs && v._bookMs > toMs) return false;
    }
    if (q && !v._searchHay.includes(q)) return false;
    return true;
  });
}

// ==================== Rendering ====================
function render() {
  const app = $('#app');
  // v724: version badge を APP_VERSION から常に反映 (HTML hardcode 廃止で 手動 bump 不要)
  document.querySelectorAll('[data-app-version]').forEach(el => { el.textContent = APP_VERSION; });
  if (!state.user) {
    renderLogin(app);
    // renderLogin 内でも template を差し込むので改めて populate
    document.querySelectorAll('[data-app-version]').forEach(el => { el.textContent = APP_VERSION; });
    return;
  }
  // Shell (only render once)
  if (!$('.hdr')) {
    app.innerHTML = '';
    const shell = $('#tpl-shell').content.cloneNode(true);
    app.appendChild(shell);
    bindShell();
  }
  $('#user-email').textContent = displayNameOf(state.user);
  // Active nav
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  // v611: header 右上の件数/更新時刻 chip は visits view のときのみ表示
  const hdrCount = $('#v-count');
  const hdrUpdated = $('#v-updated');
  const isVisits = state.view === 'visits';
  if (hdrCount) hdrCount.hidden = !isVisits;
  if (hdrUpdated) hdrUpdated.hidden = !isVisits;
  // View
  const main = $('#main');
  if (state.view === 'visits') renderVisitsView(main);
  else if (state.view === 'bookings') renderBookingsView(main);
  else if (state.view === 'analytics') renderAnalyticsView(main);
  else if (state.view === 'patients') renderPatientsView(main);
  else if (state.view === 'slots') renderSlotsView(main);
  else if (state.view === 'activity') renderActivityView(main);
}

function renderLogin(app) {
  app.innerHTML = '';
  const node = $('#tpl-login').content.cloneNode(true);
  app.appendChild(node);
  const emailInp = $('#lg-email');
  const pwInp = $('#lg-pw');
  const btn = $('#lg-btn');
  const err = $('#lg-err');
  async function doLogin() {
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'ログイン中…';
    try {
      state.user = await login(emailInp.value.trim(), pwInp.value);
      await bootAfterLogin();
    } catch(e) {
      err.textContent = 'ログイン失敗: ' + (e.message || e);
      btn.disabled = false; btn.textContent = 'ログイン';
    }
  }
  btn.addEventListener('click', doLogin);
  pwInp.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  emailInp.focus();
}

function bindShell() {
  $$('.nav-btn').forEach(b => {
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      // v730: タブ切替時にモバイル絞込パネルを閉じる (残留すると次画面で邪魔)
      document.body.classList.remove('filters-open');
      render();
    });
  });
  $('#logout-btn').addEventListener('click', logout);
  // v614: パスワード変更
  const pwBtn = $('#pw-change-btn');
  if (pwBtn) pwBtn.addEventListener('click', openPasswordModal);
  // v700: シート同期バッジ + 手動同期ボタン
  const ssBtn = $('#sheet-sync-btn');
  if (ssBtn) {
    ssBtn.addEventListener('click', () => runSheetSync(true));
    // 起動時に最終同期時刻を取得
    refreshSheetSyncStatus();
  }
  // v622: 最新版チェック (旧 refresh-btn の代替) — 手動チェック + データ再取得を兼ねる
  const verBtn = $('#ver-check-btn');
  if (verBtn) verBtn.addEventListener('click', async () => {
    verBtn.disabled = true; const orig = verBtn.textContent; verBtn.textContent = 'チェック中…';
    try {
      // 1) バージョンチェック — 新版があれば banner 出す
      const res = await fetch('./version.txt?t=' + Date.now(), { cache: 'no-store' });
      const remote = res.ok ? (await res.text()).trim() : '';
      // 2) データ再取得
      setSaveStatus('データ更新中…', 'saving');
      await Promise.all([fetchVisits(), fetchPatients()]);
      setSaveStatus('データ更新完了 ✓', 'saved');
      render();
      if (remote && remote !== APP_VERSION) {
        // v625 bug fix: 既に「後で」で dismiss していても新版があれば再度出す
        _updateBannerShown = false;
        showUpdateBanner(remote);
        _updateBannerShown = true;
      } else {
        toast(`最新版です (${APP_VERSION})`, 'ok', 2500);
      }
    } catch(e) {
      toast('確認に失敗: ' + (e.message || e), 'err');
    } finally {
      verBtn.disabled = false; verBtn.textContent = orig;
    }
  });
}

// v600 fix #6: search debounce timer
let _searchDebounce = null;
let _bookingsDebounce = null;

function renderVisitsView(main) {
  if (!main.querySelector('.visits-view')) {
    main.innerHTML = '';
    main.appendChild($('#tpl-visits').content.cloneNode(true));
    // Populate selects (once)
    const facSel = $('#v-facility');
    facSel.innerHTML = '<option value="">医院:全て</option>' +
      FACILITIES.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    const stSel = $('#v-status');
    stSel.innerHTML = '<option value="">ステータス:全て</option>' +
      STATUS_OPTIONS.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    // v730: フィルタ変更時は 500 件表示にリセット (フィルタ後 20 件なのに "残り 480 件" 誤表示防止)
    const _refilter = () => { _visitsShownLimit = 500; renderVisitsTable(); };
    // Bind filters
    $('#v-search').addEventListener('input', e => {
      // v600 fix #6: 3000 行に対する検索は debounce (200ms) で軽量化
      state.filters.search = e.target.value;
      if (_searchDebounce) clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(_refilter, 200);
    });
    $('#v-facility').addEventListener('change', e => { state.filters.facility = e.target.value; _refilter(); });
    $('#v-treatment').addEventListener('change', e => { state.filters.treatment = e.target.value; _refilter(); });
    $('#v-promo').addEventListener('change', e => { state.filters.promo = e.target.value; _refilter(); });
    $('#v-status').addEventListener('change', e => { state.filters.status = e.target.value; _refilter(); });
    $('#v-period').addEventListener('change', e => {
      state.filters.period = e.target.value;
      updatePeriodExtraInputs();
      updateQuickPeriodButtons();
      _refilter();
    });
    // v607: 今月 / 先月 クイックボタン
    document.querySelectorAll('.quick-period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.period;
        state.filters.period = p;
        const sel = $('#v-period');
        if (sel) sel.value = p;
        updatePeriodExtraInputs();
        updateQuickPeriodButtons();
        _refilter();
      });
    });
    // v710: 重複ボタン (トグル)
    const dupBtn = $('#v-dup-toggle');
    if (dupBtn) {
      dupBtn.addEventListener('click', () => {
        state.filters.dupOnly = !state.filters.dupOnly;
        updateDupButton();
        _refilter();
      });
    }
    // v618: モバイル用フィルタ折りたたみボタン
    const ftBtn = $('#v-filter-toggle');
    if (ftBtn) {
      ftBtn.addEventListener('click', () => {
        const expanded = document.body.classList.toggle('filters-open');
        ftBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        ftBtn.textContent = expanded ? '▾ 絞込' : '▸ 絞込';
      });
    }
    $('#v-month').addEventListener('change', e => { state.filters.periodMonth = e.target.value; _refilter(); });
    $('#v-from').addEventListener('change', e => { state.filters.periodFrom = e.target.value; _refilter(); });
    $('#v-to').addEventListener('change', e => { state.filters.periodTo = e.target.value; _refilter(); });
    // v609: CSV 出力 (現在のフィルタ結果のみ)
    $('#v-export-csv').addEventListener('click', () => {
      const rows = filteredVisits();
      if (!rows.length) { toast('出力する行がありません', 'err'); return; }
      exportVisitsCsv(rows);
    });
    $('#v-reset').addEventListener('click', () => {
      state.filters = { search: '', facility: '', treatment: '', promo: '', status: '', period: 'all',
                        periodMonth: '', periodFrom: '', periodTo: '', dupOnly: false };   // v710
      $('#v-search').value = ''; $('#v-facility').value = ''; $('#v-treatment').value = '';
      $('#v-promo').value = ''; $('#v-status').value = ''; $('#v-period').value = 'all';
      $('#v-month').value = ''; $('#v-from').value = ''; $('#v-to').value = '';
      updatePeriodExtraInputs();
      updateQuickPeriodButtons();
      updateDupButton();   // v710
      _refilter();
    });
    // Populate current filter values
    $('#v-search').value = state.filters.search;
    $('#v-facility').value = state.filters.facility;
    $('#v-treatment').value = state.filters.treatment;
    $('#v-status').value = state.filters.status;
    $('#v-period').value = state.filters.period;
  }
  // v604: populatePromoOptionsIfNeeded の cache 判定にバグ → 毎 render に戻す (実測 <5ms)
  populatePromoOptions();
  updateQuickPeriodButtons();  // v607
  updatePeriodExtraInputs();
  setupTbodyDelegation();  // v603 P3: event delegation を tbody に 1 回だけ bind
  renderVisitsTable();
}

let _promoPopulatedForCount = -1;
function populatePromoOptionsIfNeeded() {
  if (_promoPopulatedForCount === state.visits.length) return;
  populatePromoOptions();
  _promoPopulatedForCount = state.visits.length;
}

// v609: CSV 出力ヘルパ (現在のフィルタ結果のみ、表示列と同じ)
function _csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function exportVisitsCsv(rows) {
  const headers = ['来院日', '名前', '電話', 'メール', '治療', '医院', 'プロモ', 'ステータス',
    '次回予定', '成約商材', '成約月', '売上', 'メモ', '最終更新'];
  const lines = [headers.map(_csvEscape).join(',')];
  for (const v of rows) {
    // 電話番号は Excel で "090..." が先頭 0 落ちしないよう前置き ' で文字列固定
    const phone = v.phone ? "'" + String(v.phone) : '';
    lines.push([
      v.book_date || '',
      v.patient_name || '',
      phone,
      v.email || '',
      getTreatment(v.service, v.contract_service),
      normFac(v.facility) || '',
      v.promo_code || '',
      v.bf_status || v.status || '未対応',
      v.next_visit_date || '',
      v.contract_service || '',
      v.contract_date ? String(v.contract_date).slice(0, 7) : '',
      v.contract_amount != null ? v.contract_amount : '',
      (v.memo || '').replace(/\r?\n/g, ' '),
      v.updated_at ? new Date(v.updated_at).toLocaleString('ja-JP') : '',
    ].map(_csvEscape).join(','));
  }
  // Excel 対策で UTF-8 BOM を先頭に付与
  const csv = '﻿' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  a.href = url;
  a.download = `aladdin-visits-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  toast(`${rows.length} 件を CSV 出力しました`, 'ok');
}

function updateQuickPeriodButtons() {
  document.querySelectorAll('.quick-period-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.period === state.filters.period);
  });
}
// v710: 重複トグル ボタンの active state 反映 + 総重複数を label に
function updateDupButton() {
  const btn = $('#v-dup-toggle');
  if (!btn) return;
  const on = !!state.filters.dupOnly;
  btn.classList.toggle('active', on);
  // 重複が何件あるか (2+ dupCount) を計算して label に付ける
  const dupCount = state.visits.reduce((n, v) => n + ((v._dupCount || 0) >= 2 ? 1 : 0), 0);
  btn.textContent = dupCount > 0 ? `重複 ${dupCount}` : '重複';
}
function updatePeriodExtraInputs() {
  const p = state.filters.period;
  const monthInp = $('#v-month');
  const rangeWrap = $('#v-range-wrap');
  if (monthInp) {
    monthInp.hidden = (p !== 'month');
    // v603 fix #10: 月/期間 の値を state から復元 (タブ復帰後に消える対策)
    if (p === 'month' && state.filters.periodMonth) monthInp.value = state.filters.periodMonth;
  }
  if (rangeWrap) {
    rangeWrap.hidden = (p !== 'range');
    if (p === 'range') {
      const fromInp = $('#v-from'), toInp = $('#v-to');
      if (fromInp && state.filters.periodFrom) fromInp.value = state.filters.periodFrom;
      if (toInp && state.filters.periodTo) toInp.value = state.filters.periodTo;
    }
  }
}

function populatePromoOptions() {
  const promoSel = $('#v-promo');
  if (!promoSel) return;
  // 件数集計 → 件数降順
  const counts = new Map();
  for (const v of state.visits) {
    const p = v.promo_code || '';
    if (!p) continue;
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const current = state.filters.promo;
  promoSel.innerHTML = '<option value="">プロモ:全て</option>' +
    sorted.map(([p, n]) => `<option value="${esc(p)}" ${p === current ? 'selected' : ''}>${esc(p)} (${n})</option>`).join('');
}

// v603 fix #11 / P2: 500 行 → 「もっと見る」でページ拡張
let _visitsShownLimit = 500;
function renderVisitsTable() {
  // v628 bug fix: search debounce (200ms) が別 view に遷移した後に発火して null crash する対策
  //   #v-tbody / #v-empty / #v-count / #v-updated は visits view でしか存在しない
  if (state.view !== 'visits' || !$('#v-tbody')) return;
  const rows = filteredVisits();
  // v707: 分母は '重複削除' を除いた実来院ベース数。
  // v709 fix: ただしユーザが明示的に「ステータス:重複削除」を選んだ時は全件を分母にする (分子 ⊄ 分母 の破綻回避)
  const showingHidden = state.filters.status && STATUS_HIDDEN_BY_DEFAULT.has(state.filters.status);
  const totalDenom = showingHidden
    ? state.visits.length
    : state.visits.reduce((n, v) => n + (STATUS_HIDDEN_BY_DEFAULT.has(v._effStatus) ? 0 : 1), 0);
  $('#v-count').innerHTML = `<strong>${rows.length}</strong> / ${totalDenom} 件`;
  // v709 BUG#4 修正: フィルタ再描画時も「実データ取得時刻」を出す (renderVisitsTable 内で now() すると誤認)
  $('#v-updated').textContent = state.visitsFetchedAt
    ? `更新: ${new Date(state.visitsFetchedAt).toLocaleTimeString()}`
    : '更新: —';
  const tbody = $('#v-tbody');
  const empty = $('#v-empty');
  if (!rows.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  // v730 fix: 編集中の row を再描画から除外 (outerHTML では input.value 消える)
  //   → focused row 全体を保持し、他の行だけ差し替え
  const active = document.activeElement;
  const focusedRow = active && active.closest && active.closest('tr[data-visit-id]');
  const focusedId = focusedRow && focusedRow.dataset.visitId;
  const shown = rows.slice(0, _visitsShownLimit);
  const html = shown.map(rowHtml).join('');
  if (focusedId) {
    // 編集中の行の DOM ノードを退避 → tbody 差し替え → 元位置に差し込み
    const savedNode = focusedRow;
    tbody.innerHTML = html;
    const placeholder = tbody.querySelector(`tr[data-visit-id="${CSS.escape(focusedId)}"]`);
    if (placeholder) placeholder.replaceWith(savedNode);
    // フォーカス復元 (念のため)
    if (savedNode.contains(active)) { try { active.focus(); } catch(_){} }
  } else {
    tbody.innerHTML = html;
  }
  // v603 fix #11: 「もっと見る」ボタン
  if (rows.length > _visitsShownLimit) {
    tbody.insertAdjacentHTML('beforeend',
      `<tr><td colspan="12" style="text-align:center;padding:14px">
        <button id="v-more" class="link-btn" style="font-size:12px">
          もっと見る (残り ${rows.length - _visitsShownLimit} 件)
        </button>
      </td></tr>`);
    const moreBtn = $('#v-more');
    if (moreBtn) moreBtn.addEventListener('click', () => {
      _visitsShownLimit += 500;
      renderVisitsTable();
    });
  }
}

function rowHtml(v) {
  const eff = v.bf_status || v.status || '未対応';
  const bookDisplay = v.book_date ? fmtDate(v.book_date) : (v.apply_date ? '(' + fmtDate(v.apply_date) + ')' : '-');
  const statusOptsHtml = STATUS_OPTIONS
    .map(s => `<option value="${esc(s)}" ${s === eff ? 'selected' : ''}>${esc(s)}</option>`)
    .join('');
  const treatment = getTreatment(v.service, v.contract_service);
  const promo = v.promo_code || '';
  const isSelectType = promo === 'セレクトタイプ';
  const promoChipCls = !promo ? 'promo-chip empty'
    : isSelectType ? 'promo-chip select-type' : 'promo-chip';
  const csOptsHtml = CONTRACT_SERVICE_OPTIONS
    .map(o => `<option value="${esc(o)}" ${o === (v.contract_service || '') ? 'selected' : ''}>${o ? esc(o) : '-'}</option>`)
    .join('');
  const contractMonth = v.contract_date ? String(v.contract_date).slice(0, 7) : '';
  const memo = v.memo || '';
  return `<tr data-visit-id="${esc(v.visit_id)}">
    <td class="c-book">${esc(bookDisplay)}</td>
    <td class="c-name" title="${esc(v.normalized_name || '')}">${esc(v.patient_name || '(名前なし)')}${(v._dupCount || 0) >= 2 ? `<span class="dup-badge" title="同日同患者に ${v._dupCount} 行あります">×${v._dupCount}</span>` : ''}</td>
    <td class="c-treatment">${treatment ? `<span class="treatment-chip" data-t="${esc(treatment)}">${esc(treatment)}</span>` : '<span class="tx-empty">-</span>'}</td>
    <td class="c-facility" title="${esc(v.facility || '')}">${esc(normFac(v.facility) || '-')}</td>
    <td class="c-promo"><span class="${promoChipCls}" title="${esc(promo)}">${promo ? esc(shortPromo(promo)) : '-'}</span></td>
    <td class="c-status">
      <select class="status-sel" data-value="${esc(eff)}" data-visit-id="${esc(v.visit_id)}">
        ${statusOptsHtml}
      </select>
    </td>
    <td class="c-next">
      <input type="date" class="field-input date-input" data-field="next_visit_date"
             data-visit-id="${esc(v.visit_id)}" value="${esc(v.next_visit_date || '')}">
    </td>
    <td class="c-cs">
      <select class="field-input cs-sel" data-field="contract_service" data-visit-id="${esc(v.visit_id)}">
        ${csOptsHtml}
      </select>
    </td>
    <td class="c-cmonth">
      <input type="month" class="field-input month-input" data-field="contract_date"
             data-visit-id="${esc(v.visit_id)}" value="${esc(contractMonth)}">
    </td>
    <td class="c-amount">
      <input type="text" class="amount-input" data-visit-id="${esc(v.visit_id)}"
             value="${esc(fmtYen(v.contract_amount))}" placeholder="¥0">
    </td>
    <td class="c-memo">
      <div class="memo-cell ${memo ? 'has-value' : 'empty'}" data-visit-id="${esc(v.visit_id)}" title="${esc(memo || '')}">
        ${memo ? esc(memo) : '+ メモ'}
      </div>
    </td>
    <td class="c-updated">${esc(fmtRelative(v.updated_at))}</td>
  </tr>`;
}

// v603 P3: bindRow を廃止 → tbody 全体に delegated handler (500 rows × 6 listener = 3000 →  6)
//   (setupTbodyDelegation は init 時に 1 回だけ呼ぶ)
function findVisitById(id) {
  return state.visits.find(v => v.visit_id === id) || null;
}
function setupTbodyDelegation() {
  const tbody = $('#v-tbody');
  if (!tbody || tbody._delegated) return;
  tbody._delegated = true;
  const origValues = new WeakMap();
  // status change
  tbody.addEventListener('change', async (e) => {
    const t = e.target;
    if (!t.matches) return;
    const tr = t.closest('tr[data-visit-id]');
    if (!tr) return;
    const visitId = tr.dataset.visitId;
    const v = findVisitById(visitId);
    if (!v) return;
    // Status select
    if (t.classList.contains('status-sel')) {
      const newValue = t.value;
      const orig = t.dataset.value;
      // v709 BUG#3 修正: 「重複削除」は非表示化 (実質ソフトデリート) → 誤タップ防止に確認
      if (newValue === '重複削除' && orig !== '重複削除') {
        if (!confirm('この行を「重複削除」にすると一覧から非表示になります。よろしいですか？\n(復元: ステータス:重複削除 でフィルタ)')) {
          t.value = orig;
          return;
        }
      }
      t.classList.remove('saved', 'failed');
      t.classList.add('saving');
      t.dataset.value = newValue;
      // v603 fix #2: 非 BF 系 status の時、bf_status を null 明示クリア (残留防止)
      const isBFStatus = ['予約連絡待ち', '後追いLINE済み', '予約変更', '検討中', '離脱',
        'ローン審査中', 'ローン審査落', '成約', 'キャンセル', '未対応',
        '矯正決定(BF保留)', 'ラブリエ決定(BF保留)', 'インプラント決定(BF保留)',
        '印象待ち(治療無)', '印象待ち(治療有)', '治療中',
        'セット日確定待ち', 'セット待ち', 'セット完了'].includes(newValue);
      const patch = { status: newValue, bf_status: isBFStatus ? newValue : null };
      const res = await sb.from('patient_visits')
        .update({ ...patch, updated_by: state.user?.email || 'unknown' })
        .eq('id', visitId).select().single();
      t.classList.remove('saving');
      if (res.error) {
        // v603 fix #3: 失敗時 select を元に戻す
        t.value = orig;
        t.dataset.value = orig;
        t.classList.add('failed');
        toast('ステータス保存失敗: ' + res.error.message, 'err', 5000);
      } else {
        t.classList.add('saved');
        v.status = newValue;
        v.bf_status = patch.bf_status;
        v._effStatus = v.bf_status || v.status || '未対応';
        if (res.data && res.data.updated_at) v.updated_at = res.data.updated_at;
        setTimeout(() => t.classList.remove('saved'), 1500);
        setSaveStatus('保存完了 ✓', 'saved');
      }
      return;
    }
    // field-input change (date/month/select)
    if (t.classList.contains('field-input')) {
      const field = t.dataset.field;
      if (!field) return;
      const orig = origValues.get(t) ?? t.defaultValue;
      let value = t.value;
      if (field === 'contract_date') value = value ? value + '-01' : null;
      else if (field === 'contract_service') value = value || null;
      else if (field === 'next_visit_date') value = value || null;
      t.classList.remove('saved', 'failed');
      t.classList.add('saving');
      const res = await saveVisitField(visitId, field, value);
      t.classList.remove('saving');
      if (res.ok) {
        t.classList.add('saved');
        setTimeout(() => t.classList.remove('saved'), 1500);
        origValues.set(t, t.value);
      } else {
        t.classList.add('failed');
        t.value = orig;
      }
      return;
    }
  });
  // amount input (blur)
  tbody.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t.classList && (t.classList.contains('amount-input') || t.classList.contains('field-input'))) {
      origValues.set(t, t.value);
    }
  });
  tbody.addEventListener('focusout', async (e) => {
    const t = e.target;
    if (!t.classList || !t.classList.contains('amount-input')) return;
    const tr = t.closest('tr[data-visit-id]');
    if (!tr) return;
    const visitId = tr.dataset.visitId;
    const raw = t.value.trim();
    const origRaw = origValues.get(t) || '';
    // v603 fix #20: 数値比較で無駄 UPDATE 回避 (¥1,000 と 1000 は同値)
    if (parseAmount(raw) === parseAmount(origRaw)) return;
    const num = parseAmount(raw);
    t.classList.remove('saved', 'failed');
    t.classList.add('saving');
    const res = await saveVisitField(visitId, 'contract_amount', num);
    t.classList.remove('saving');
    if (res.ok) {
      t.value = fmtYen(num);
      t.classList.add('saved');
      setTimeout(() => t.classList.remove('saved'), 1500);
    } else {
      t.classList.add('failed');
      t.value = origRaw;
    }
  });
  // memo cell click
  tbody.addEventListener('click', (e) => {
    const memo = e.target.closest('.memo-cell');
    if (!memo) return;
    const tr = memo.closest('tr[data-visit-id]');
    if (!tr) return;
    const v = findVisitById(tr.dataset.visitId);
    if (v) openMemoModal(v);
  });
}

function openMemoModal(v) {
  // v603 fix #5: 連打で複数モーダル重なる問題 → 既存があれば無視
  if (document.querySelector('.modal-backdrop')) return;
  state.memoTarget = { visit_id: v.visit_id, name: v.patient_name, current: v.memo || '' };
  const backdrop = document.body.appendChild($('#tpl-memo').content.cloneNode(true).firstElementChild);
  const title = backdrop.querySelector('#mm-title');
  const text = backdrop.querySelector('#mm-text');
  const hint = backdrop.querySelector('#mm-hint');
  const saveBtn = backdrop.querySelector('#mm-save');
  title.textContent = `📝 ${v.patient_name} のメモ`;
  text.value = v.memo || '';
  hint.textContent = v.updated_at ? `最終更新: ${fmtDateTime(v.updated_at)}` : '';
  text.focus();
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const doSave = async () => {
    saveBtn.disabled = true; saveBtn.textContent = '保存中…';
    const res = await saveVisitField(v.visit_id, 'memo', text.value || null);
    if (res.ok) {
      const tr = $(`tr[data-visit-id="${CSS.escape(v.visit_id)}"]`);
      if (tr) {
        const mc = tr.querySelector('.memo-cell');
        const m = text.value || '';
        mc.classList.toggle('has-value', !!m);
        mc.classList.toggle('empty', !m);
        mc.textContent = m || '+ メモ';   /* v613: 全文表示 (CSS の line-clamp で省略) */
        mc.setAttribute('title', m || '');
      }
      toast('メモを保存しました', 'ok');
      close();
    } else {
      saveBtn.disabled = false; saveBtn.textContent = '保存';
    }
  };
  // v603 fix #15/#16: ESC で閉じる, Ctrl/Cmd+Enter で保存
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doSave(); }
  };
  document.addEventListener('keydown', onKey);
  // v603 fix #15: backdrop 直接クリックで閉じる
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  saveBtn.addEventListener('click', doSave);
}

// v601: 予約一覧 — Sheets を直接 fetch して read-only 表示
function _parseBkCsvLine(line) {
  const r = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) { r.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  r.push(cur.trim());
  return r;
}
async function fetchBkSheet(spec) {
  const url = `https://docs.google.com/spreadsheets/d/${BK_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${spec.encoded}`;
  const res = await fetch(url + '&_=' + Date.now());
  if (!res.ok) throw new Error(spec.label + ': ' + res.status);
  const csv = await res.text();
  const lines = csv.split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = _parseBkCsvLine(lines[i]);
    if (!c[2]) continue;
    if (spec.tool === 'DXHUB') {
      rows.push({
        applyDate: c[0] || '', bookDate: c[1] || '', name: c[2] || '',
        service: c[3] || '', facility: c[4] || '', email: c[5] || '',
        phone: (c[6] || '').replace(/[-\s]/g,''), source: c[7] || '',
        tool: 'DXHUB', sheet: spec.label,
      });
    } else {
      rows.push({
        applyDate: c[0] || '', bookDate: c[1] || '', name: c[2] || '',
        service: '矯正無料相談', facility: spec.facility, email: c[4] || '',
        phone: (c[3] || '').replace(/[-\s]/g,''), source: 'セレクトタイプ',
        tool: 'セレクト', sheet: spec.label,
      });
    }
  }
  return rows;
}
async function fetchBookings() {
  try {
    const results = await Promise.all(BK_SHEETS.map(fetchBkSheet));
    const all = results.flat();
    // v717 fix: DXHUB (2026/8/16 9:30) と セレクト (2026年9月8日(火) 18時30分) の
    //   bookDate 文字列 sort は 年 > / (Unicode) で セレクトが常に上位に来て、
    //   上位行が全部「矯正」に見える bug の原因になっていた。
    //   → parseBkDate で ISO 化してから比較。
    all.sort((a, b) => {
      const ad = parseBkDate(a.bookDate) || parseBkDate(a.applyDate) || '';
      const bd = parseBkDate(b.bookDate) || parseBkDate(b.applyDate) || '';
      return bd.localeCompare(ad);
    });
    state.bookings = { rows: all, fetchedAt: new Date().toISOString() };
  } catch(e) {
    console.error('fetchBookings', e);
    toast('スプレッドシート取得失敗: ' + e.message, 'err', 5000);
    state.bookings = { rows: [], fetchedAt: null, error: e.message };
  }
}

function renderBookingsView(main) {
  if (!main.querySelector('.bookings-view')) {
    main.innerHTML = '';
    main.appendChild($('#tpl-bookings').content.cloneNode(true));
    $('#b-facility').innerHTML = '<option value="">医院:全て</option>' +
      FACILITIES.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    // v603 P8: 予約一覧の検索も debounce (200ms)
    $('#b-search').addEventListener('input', e => {
      state.bookingFilters.search = e.target.value;
      if (_bookingsDebounce) clearTimeout(_bookingsDebounce);
      _bookingsDebounce = setTimeout(() => renderBookingsTable(), 200);
    });
    $('#b-facility').addEventListener('change', e => { state.bookingFilters.facility = e.target.value; renderBookingsTable(); });
    $('#b-tool').addEventListener('change', e => { state.bookingFilters.tool = e.target.value; renderBookingsTable(); });
    $('#b-refresh').addEventListener('click', async () => {
      $('#b-tbody').innerHTML = '<tr><td colspan="9" class="empty-msg">読み込み中…</td></tr>';
      await fetchBookings();
      renderBookingsTable();
    });
  }
  if (!state.bookings) {
    $('#b-tbody').innerHTML = '<tr><td colspan="9" class="empty-msg">読み込み中…</td></tr>';
    fetchBookings().then(renderBookingsTable);
  } else {
    renderBookingsTable();
  }
}

function renderBookingsTable() {
  // v603 fix #8: view 切替中に呼ばれた時のガード
  if (state.view !== 'bookings') return;
  const st = state.bookings || { rows: [] };
  const f = state.bookingFilters;
  const q = f.search.trim().toLowerCase();
  const rows = (st.rows || []).filter(r => {
    if (f.facility && normFac(r.facility) !== f.facility) return false;
    if (f.tool && r.tool !== f.tool) return false;
    if (q && !(r.name || '').toLowerCase().includes(q)) return false;
    return true;
  });
  $('#b-count').innerHTML = `<strong>${rows.length}</strong> / ${(st.rows||[]).length} 件`;
  $('#b-updated').textContent = st.fetchedAt ? `更新: ${new Date(st.fetchedAt).toLocaleTimeString()}` : '更新: —';
  const tbody = $('#b-tbody');
  const empty = $('#b-empty');
  if (!rows.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  const shown = rows.slice(0, 500);
  tbody.innerHTML = shown.map(r => {
    const treatment = getTreatment(r.service, '');
    // v716: promo は来院タブと同じロジックに統一 (セレクトタイプ chip も同じ表示)
    const displayPromo = r.tool === 'セレクト' ? 'セレクトタイプ' : (r.source || '');
    const isSel = displayPromo === 'セレクトタイプ';
    const promoCls = !displayPromo ? 'promo-chip empty' : isSel ? 'promo-chip select-type' : 'promo-chip';
    return `<tr>
    <td class="c-book">${esc(bkFmtDate(r.bookDate))}</td>
    <td class="c-name">${esc(r.name || '')}</td>
    <td class="c-facility">${esc(normFac(r.facility) || '-')}</td>
    <td class="c-treatment">${treatment ? `<span class="treatment-chip" data-t="${esc(treatment)}">${esc(treatment)}</span>` : '<span class="tx-empty">-</span>'}</td>
    <td class="c-promo"><span class="${promoCls}" title="${esc(displayPromo)}">${displayPromo ? esc(shortPromo(displayPromo)) : '-'}</span></td>
    <td style="font-size:12px">${esc(r.service || '-')}</td>
    <td style="font-size:11px;color:var(--ink-mute);font-family:var(--font-mono)">${esc(r.email || '-')}</td>
    <td style="font-family:var(--font-mono);font-size:11px">${esc(r.phone || '-')}</td>
    <td class="c-book">${esc(bkFmtDate(r.applyDate))}</td>
  </tr>`;
  }).join('');
  if (rows.length > 500) {
    tbody.insertAdjacentHTML('beforeend',
      `<tr><td colspan="9" class="empty-msg">…他 ${rows.length - 500} 件 (フィルタで絞ってください)</td></tr>`);
  }
}

// v717: bookDate/applyDate を ISO "YYYY-MM-DD" に統一 (sort/比較用)
function parseBkDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  let m = s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  return '';
}

// v715/v718: 予約シートの日付表記統一 (DXHUB "2026/8/16 9:30" / セレクト "2026年9月8日(火) 18時30分" / ISO どれでも)
// v718: 予約日 と 申込日 の見た目統一 (M/D、leading 0 を必ず削る)
function bkFmtDate(raw) {
  if (!raw) return '-';
  const s = String(raw).trim();
  let m = s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (m) return `${Number(m[2])}/${Number(m[3])}`;
  return s.slice(0, 10);
}

// ==================== v720: Analytics view (分析) 改良版 ====================
// 予約→来院率 は 予約由来 (source_tool = DXHUB/セレクト) のみで計算 (walkin除外)
// 医院別 初診数 は 実来院者を 治療分類マトリクスで
// 保険/WT/転院/審美 は walkin ベースなので 来院率は出さず、初診数のみ表示
const A2_NON_VISIT = new Set(['未対応', 'キャンセル', '予約変更', '離脱', '除外', '重複削除', '予約連絡待ち', '後追いLINE済み']);
const A2_CONTRACT = new Set(['成約',
  '矯正決定(BF保留)', 'ラブリエ決定(BF保留)', 'インプラント決定(BF保留)',
  '印象待ち(治療有)', '治療中',
  'セット日確定待ち', 'セット待ち', 'セット完了']);
// 予約由来判定: source_tool が DXHUB/セレクト のみ (v729: promo_code フォールバック撤去
//   — sheet-sync Phase 8 が sheet-direct walk-in に promo_code を付ける挙動と衝突し
//   広告経由 walk-in を『予約由来』誤カウントしていた)
const A2_BOOKING_TOOLS = new Set(['DXHUB', 'セレクト']);
function a2IsBooked(v) {
  return A2_BOOKING_TOOLS.has(v.source_tool);
}
function a2IsVisited(v) { return !A2_NON_VISIT.has(v._effStatus); }
function a2IsContracted(v) { return A2_CONTRACT.has(v._effStatus); }
const A2_TREAT_ORDER = ['矯正', 'BF', 'インプラント', 'ラブリエ', '保険', 'WT', '審美', '補綴', '転院', '(未分類)'];
const A2_BOOKING_TREATS = new Set(['矯正', 'BF', 'インプラント', 'ラブリエ']);

// v729: セレクトタブ由来の promo 表示を worker/legacy 双方で統一
//   — sheet-tabs.js は tool='セレクト' 行に promo_code を付けないため DB では null
//   — legacy migrate 済み行は 'セレクトタイプ' が入っている
//   → 表示側で source_tool='セレクト' なら常に promo='セレクト' に寄せる
function a2NormPromo(v) {
  if (v.source_tool === 'セレクト') return 'セレクト';
  const p = v.promo_code;
  if (!p) return '';
  return p === 'セレクトタイプ' ? 'セレクト' : p;
}
function a2Bucket(v, key) {
  if (key === 'facility') return v._normFacility || '(不明)';
  if (key === 'treatment') return v._treatment || '(未分類)';
  if (key === 'promo') {
    const p = a2NormPromo(v);
    return p || '(なし)';
  }
  return '?';
}

// v720: 予約母数 = 予約由来 のみ の 予約→来院率 集計
// v729: 売上は実来院ベースで統一 (a2FacilityMatrix と揃える)、arpc 計算漏れも補修
function a2AggregateBooked(visits, key) {
  const buckets = new Map();
  for (const v of visits) {
    if (!a2IsBooked(v)) continue;
    const k = a2Bucket(v, key);
    if (!buckets.has(k)) buckets.set(k, { key: k, bookedVisited: 0, booking: 0, visited: 0, contract: 0, revenue: 0 });
    const b = buckets.get(k);
    b.booking += 1;
    const isVis = a2IsVisited(v);
    if (isVis) { b.visited += 1; b.bookedVisited += 1; }
    if (a2IsContracted(v)) b.contract += 1;
    // v729: 売上は実来院者のみ加算 (未対応/キャンセル行の contract_amount ゴミを排除)
    if (isVis && v.contract_amount) b.revenue += Number(v.contract_amount) || 0;
  }
  const arr = [...buckets.values()];
  for (const b of arr) {
    b.visitRate = b.booking ? (b.visited / b.booking) : 0;
    b.contractRate = b.visited ? (b.contract / b.visited) : 0;
    b.arpc = b.contract ? (b.revenue / b.contract) : 0;   // v729: プロモ別 客単価 欠落 fix
  }
  arr.sort((a, b) => b.booking - a.booking);
  return arr;
}

// v723: 全治療の集計 (来院ベース + 予約→来院率は予約系のみ)
// v729: 予約→来院率 の分子/分母のスコープ非対称を解消
//   — visitRate は 予約由来 かつ 来院 のみ (bookedVisited) を分子に。
//   売上も 実来院ベース で統一 (未対応キャンセル行の contract_amount ゴミを排除)。
function a2AggregateByTreatment(visits) {
  const buckets = new Map();
  for (const v of visits) {
    const t = v._treatment || '(未分類)';
    if (!buckets.has(t)) buckets.set(t, { key: t, bookedVisited: 0, booking: 0, visited: 0, contract: 0, revenue: 0, isBookedTreat: A2_BOOKING_TREATS.has(t) });
    const b = buckets.get(t);
    const isBk = a2IsBooked(v);
    const isVis = a2IsVisited(v);
    if (isBk) b.booking += 1;
    if (isVis) b.visited += 1;
    if (isBk && isVis) b.bookedVisited += 1;   // v729: 予約→来院率 の正しい分子
    if (a2IsContracted(v)) b.contract += 1;
    if (isVis && v.contract_amount) b.revenue += Number(v.contract_amount) || 0;
  }
  const arr = [...buckets.values()];
  for (const b of arr) {
    b.visitRate = (b.isBookedTreat && b.booking) ? (b.bookedVisited / b.booking) : null;
    b.contractRate = b.visited ? (b.contract / b.visited) : 0;
    b.arpc = b.contract ? (b.revenue / b.contract) : 0;   // 客単価
  }
  // 予約系を上、非予約系(walkin)を下
  arr.sort((a, b) => {
    if (a.isBookedTreat !== b.isBookedTreat) return a.isBookedTreat ? -1 : 1;
    return b.visited - a.visited;
  });
  return arr;
}

// v720: 医院別 × 治療分類 の 実来院数マトリクス
function a2FacilityMatrix(visits) {
  const byFac = new Map();
  for (const v of visits) {
    if (!a2IsVisited(v)) continue;   // 実来院者のみ
    const fac = v._normFacility || '(不明)';
    const treat = v._treatment || '(未分類)';
    if (!byFac.has(fac)) byFac.set(fac, { facility: fac, cells: {}, total: 0, revenue: 0 });
    const row = byFac.get(fac);
    row.cells[treat] = (row.cells[treat] || 0) + 1;
    row.total += 1;
    if (v.contract_amount) row.revenue += Number(v.contract_amount) || 0;
  }
  const arr = [...byFac.values()];
  arr.sort((a, b) => b.total - a.total);
  return arr;
}

function a2FormatYen(n) {
  return '¥' + (Number(n) || 0).toLocaleString('ja-JP');
}
function a2Pct(p) {
  if (!isFinite(p)) return '—';
  return (p * 100).toFixed(1) + '%';
}

// v729: 期間フィルタは 来院タブ (filteredVisits: `if ((fromMs||toMs) && v._bookMs)`) と
//   同じセマンティクスに揃える — book_date=null は期間絞込を通す (両タブで件数が一致)。
//   lastMonth は上限 (現月頭) があるため null を通さず現在の挙動を維持。
function a2FilterByPeriod(visits) {
  const p = state.a2Period || 'all';
  if (p === 'all') return visits;
  const now = new Date();
  let from = null;
  if (p === 'thisMonth') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (p === 'lastMonth') {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 1);
    return visits.filter(v => !v._bookMs || (v._bookMs >= from.getTime() && v._bookMs < to.getTime()));
  } else if (p === '3m') {
    from = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  } else if (p === '6m') {
    from = new Date(now.getFullYear(), now.getMonth() - 6, 1);
  }
  if (!from) return visits;
  const fromMs = from.getTime();
  return visits.filter(v => !v._bookMs || v._bookMs >= fromMs);
}

function a2RenderTable(title, rows) {
  const totalBooking = rows.reduce((s, r) => s + r.booking, 0);
  const totalVisited = rows.reduce((s, r) => s + r.visited, 0);
  // v729: 治療別合計行の相談率が >100% になる不具合修正
  //   — 分母(booking) は 予約由来のみ、分子は 予約由来かつ来院 の bookedVisited を使う。
  //   walk-in 治療 (保険/WT/転院/審美/補綴) の visited は分子に混ぜない。
  const totalBookedVisited = rows.reduce((s, r) => s + (r.bookedVisited || 0), 0);
  const totalContract = rows.reduce((s, r) => s + r.contract, 0);
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const totalVisitRate = totalBooking ? totalBookedVisited / totalBooking : 0;
  const totalContractRate = totalVisited ? totalContract / totalVisited : 0;
  const totalArpc = totalContract ? (totalRevenue / totalContract) : 0;
  return `<section class="a2-section">
    <h3 class="a2-title">${esc(title)}</h3>
    <div class="a2-table-wrap">
    <table class="a2-table">
      <thead><tr>
        <th style="text-align:left">分類</th>
        <th style="text-align:right">予約</th>
        <th style="text-align:right">相談</th>
        <th style="text-align:right">相談率</th>
        <th style="text-align:right">成約</th>
        <th style="text-align:right">成約率</th>
        <th style="text-align:right">売上</th>
        <th style="text-align:right">客単価</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const showVR = (r.visitRate != null);
          return `<tr>
          <td>${esc(r.key)}${r.isBookedTreat === false ? ' <span class="a2-badge-walkin">walk-in</span>' : ''}</td>
          <td class="a2-num">${r.booking || '—'}</td>
          <td class="a2-num">${r.visited}</td>
          <td class="a2-num">${showVR ? `<span class="a2-pct">${a2Pct(r.visitRate)}</span>` : '<span class="a2-empty">—</span>'}</td>
          <td class="a2-num">${r.contract}</td>
          <td class="a2-num"><span class="a2-pct">${a2Pct(r.contractRate)}</span></td>
          <td class="a2-num a2-yen">${a2FormatYen(r.revenue)}</td>
          <td class="a2-num a2-yen">${r.contract ? a2FormatYen(r.arpc || 0) : '—'}</td>
        </tr>`;
        }).join('')}
        <tr class="a2-total">
          <td><strong>合計</strong></td>
          <td class="a2-num">${totalBooking}</td>
          <td class="a2-num">${totalVisited}</td>
          <td class="a2-num"><strong>${a2Pct(totalVisitRate)}</strong></td>
          <td class="a2-num">${totalContract}</td>
          <td class="a2-num"><strong>${a2Pct(totalContractRate)}</strong></td>
          <td class="a2-num a2-yen"><strong>${a2FormatYen(totalRevenue)}</strong></td>
          <td class="a2-num a2-yen"><strong>${totalContract ? a2FormatYen(totalArpc) : '—'}</strong></td>
        </tr>
      </tbody>
    </table>
    </div>
  </section>`;
}

function renderAnalyticsView(main) {
  if (!main.querySelector('.analytics-view')) {
    main.innerHTML = '';
    main.appendChild($('#tpl-analytics').content.cloneNode(true));
    $('#a2-period').addEventListener('change', e => {
      state.a2Period = e.target.value;
      a2UpdateQuickButtons();
      a2PopulateFilters();
      renderAnalyticsTable();
    });
    document.querySelectorAll('.analytics-view .quick-period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.a2Period = btn.dataset.a2Period;
        const sel = $('#a2-period');
        if (sel) sel.value = state.a2Period;
        a2UpdateQuickButtons();
        a2PopulateFilters();
        renderAnalyticsTable();
      });
    });
    // v721: 3 軸絞込フィルタ
    ['facility', 'treatment', 'promo'].forEach(key => {
      $(`#a2-${key}`).addEventListener('change', e => {
        state.a2Filters[key] = e.target.value;
        renderAnalyticsTable();
      });
    });
    $('#a2-reset').addEventListener('click', () => {
      state.a2Filters = { facility: '', treatment: '', promo: '' };
      state.a2Period = 'all';
      $('#a2-facility').value = ''; $('#a2-treatment').value = ''; $('#a2-promo').value = '';
      $('#a2-period').value = 'all';
      a2UpdateQuickButtons();
      // v729: option リストも全期間ベースに戻す (今月ゼロだった医院が再選択可能に)
      a2PopulateFilters();
      renderAnalyticsTable();
    });
  }
  a2PopulateFilters();
  renderAnalyticsTable();
}
// v721: フィルタ select の option を state.visits から動的生成
// v729: 期間切替で選択中の値が候補集合に無くなった場合は state と select.value を同期クリア
//   (幽霊フィルタで「全て 選択 → 0件・チップだけ残る」不整合を解消)
function a2PopulateFilters() {
  const facSel = $('#a2-facility');
  const treatSel = $('#a2-treatment');
  const promoSel = $('#a2-promo');
  if (!facSel) return;
  const period = a2FilterByPeriod(state.visits || []);
  const facs = new Set(), treats = new Set(), promos = new Set();
  for (const v of period) {
    if (v._normFacility) facs.add(v._normFacility);
    if (v._treatment) treats.add(v._treatment);
    const p = a2NormPromo(v);
    if (p) promos.add(p);
  }
  // v729: state に残った orphan 値を候補ベースで検証してクリア
  if (state.a2Filters.facility && !facs.has(state.a2Filters.facility)) state.a2Filters.facility = '';
  if (state.a2Filters.treatment && !treats.has(state.a2Filters.treatment)) state.a2Filters.treatment = '';
  if (state.a2Filters.promo && !promos.has(state.a2Filters.promo)) state.a2Filters.promo = '';
  const buildOpts = (curr, all, prefix) => {
    return `<option value="">${prefix}:全て</option>` +
      [...all].sort().map(x => `<option value="${esc(x)}" ${x === curr ? 'selected' : ''}>${esc(x)}</option>`).join('');
  };
  facSel.innerHTML = buildOpts(state.a2Filters.facility, facs, '医院');
  treatSel.innerHTML = buildOpts(state.a2Filters.treatment, treats, '治療');
  promoSel.innerHTML = buildOpts(state.a2Filters.promo, promos, 'プロモ');
  // v729: innerHTML 差し替え後、DOM 側 value も state に合わせる (先頭 '' フォールバック防止)
  facSel.value = state.a2Filters.facility || '';
  treatSel.value = state.a2Filters.treatment || '';
  promoSel.value = state.a2Filters.promo || '';
}
// v721: 絞込フィルタ適用
function a2ApplyFilters(visits) {
  const f = state.a2Filters;
  return visits.filter(v => {
    if (f.facility && (v._normFacility || '') !== f.facility) return false;
    if (f.treatment && (v._treatment || '') !== f.treatment) return false;
    if (f.promo) {
      const p = a2NormPromo(v);
      if (p !== f.promo) return false;
    }
    return true;
  });
}
function a2UpdateQuickButtons() {
  document.querySelectorAll('.analytics-view .quick-period-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.a2Period === state.a2Period);
  });
}
// v720/v723: 医院別 治療内訳マトリクス render (suffix で絞込表示)
function a2RenderFacilityMatrix(rows, suffix = '') {
  const treats = A2_TREAT_ORDER.filter(t => rows.some(r => r.cells[t]));
  const colTotals = { total: 0, revenue: 0 };
  for (const t of treats) colTotals[t] = 0;
  for (const r of rows) {
    for (const t of treats) colTotals[t] += (r.cells[t] || 0);
    colTotals.total += r.total;
    colTotals.revenue += r.revenue;
  }
  return `<section class="a2-section">
    <h3 class="a2-title">医院別 相談数${esc(suffix)}</h3>
    <div class="a2-table-wrap"><table class="a2-table">
      <thead><tr>
        <th style="text-align:left">医院</th>
        ${treats.map(t => `<th style="text-align:right">${esc(t)}</th>`).join('')}
        <th style="text-align:right">合計</th>
        <th style="text-align:right">売上</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `<tr>
          <td><strong>${esc(r.facility)}</strong></td>
          ${treats.map(t => `<td class="a2-num">${r.cells[t] || 0}</td>`).join('')}
          <td class="a2-num"><strong>${r.total}</strong></td>
          <td class="a2-num a2-yen">${a2FormatYen(r.revenue)}</td>
        </tr>`).join('')}
        <tr class="a2-total">
          <td><strong>合計</strong></td>
          ${treats.map(t => `<td class="a2-num">${colTotals[t]}</td>`).join('')}
          <td class="a2-num"><strong>${colTotals.total}</strong></td>
          <td class="a2-num a2-yen"><strong>${a2FormatYen(colTotals.revenue)}</strong></td>
        </tr>
      </tbody>
    </table></div>
  </section>`;
}

function renderAnalyticsTable() {
  const body = $('#a2-body');
  if (!body) return;
  if (!state.visits || state.visits.length === 0) {
    body.innerHTML = '<div class="empty-msg">来院データがロードされていません。来院タブを一度開いてください。</div>';
    return;
  }
  // v729: 分析タブ集計から '重複削除' 行を除外 (来院タブと定義を揃える。
  //   従来は a2IsBooked が status を見ないため 重複削除 でも booking にカウントされていた)
  const visitsRaw = state.visits.filter(v => !STATUS_HIDDEN_BY_DEFAULT.has(v._effStatus));
  const visits = a2ApplyFilters(a2FilterByPeriod(visitsRaw));

  // ---- 全体サマリー + 未処理アラート ----
  let booking=0, visited=0, contract=0, revenue=0, visitedAll=0, pendingOverdue=0;
  const todayMs = Date.now();
  for (const v of visits) {
    if (a2IsBooked(v)) booking++;
    const isVis = a2IsVisited(v);
    if (isVis) { visitedAll++; if (a2IsBooked(v)) visited++; }
    if (a2IsContracted(v)) contract++;
    // v729: 売上は 実来院ベース で統一 (a2FacilityMatrix / 治療別 / プロモ別 と揃える)
    if (isVis && v.contract_amount) revenue += Number(v.contract_amount) || 0;
    // v723: 未処理 = 未対応 かつ 予約日が過ぎている (来院確認漏れの可能性)
    if (v._effStatus === '未対応' && v._bookMs && v._bookMs < todayMs - 86400000) pendingOverdue++;
  }
  const visitRate = booking ? (visited / booking) : 0;
  const contractRate = visitedAll ? (contract / visitedAll) : 0;
  const arpc = contract ? (revenue / contract) : 0;
  // 絞込条件表示
  const f = state.a2Filters || {};
  const filterChips = [
    (state.a2Period && state.a2Period !== 'all') ? `期間:${state.a2Period === 'thisMonth' ? '今月' : state.a2Period === 'lastMonth' ? '先月' : state.a2Period}` : '',
    f.facility ? `医院:${f.facility}` : '',
    f.treatment ? `治療:${f.treatment}` : '',
    f.promo ? `プロモ:${f.promo}` : '',
  ].filter(Boolean);
  const filterLine = filterChips.length ? `<div class="a2-filter-line">絞込: ${filterChips.map(c => `<span class="a2-chip">${esc(c)}</span>`).join('')}</div>` : '';
  // v727: ±10% 表記削除、シンプル化
  const summary = `${filterLine}<section class="a2-summary">
    <div class="a2-card"><div class="a2-card-lbl">予約</div><div class="a2-card-num">${booking.toLocaleString()}</div></div>
    <div class="a2-card"><div class="a2-card-lbl">相談</div><div class="a2-card-num">${visitedAll.toLocaleString()}</div><div class="a2-card-sub">予約由来 ${visited.toLocaleString()} → ${a2Pct(visitRate)}</div></div>
    <div class="a2-card"><div class="a2-card-lbl">成約</div><div class="a2-card-num">${contract.toLocaleString()}</div><div class="a2-card-sub">相談比 ${a2Pct(contractRate)}</div></div>
    <div class="a2-card"><div class="a2-card-lbl">売上</div><div class="a2-card-num a2-yen">${a2FormatYen(revenue)}</div><div class="a2-card-sub">客単価 ${contract ? a2FormatYen(arpc) : '—'}</div></div>
    <div class="a2-card a2-card-alert"><div class="a2-card-lbl">⚠ 未処理 (予約日過ぎ)</div><div class="a2-card-num">${pendingOverdue.toLocaleString()}</div><div class="a2-card-sub">来院タブ → 未対応 で確認</div></div>
  </section>`;

  // 表タイトル用の絞込サフィックス
  const suffix = filterChips.length ? ` — ${filterChips.join(' / ')}` : '';
  const facMatrix = a2FacilityMatrix(visits);
  const byTreat = a2AggregateByTreatment(visits);          // v723: 全治療 (walkin 含む) — 保険等も見える
  const byPromo = a2AggregateBooked(visits, 'promo');       // プロモ別 は予約由来のみ

  body.innerHTML = summary
    + a2RenderFacilityMatrix(facMatrix, suffix)
    + a2RenderTable('治療別' + suffix, byTreat)
    + a2RenderTable('プロモ別' + suffix, byPromo);
}

async function fetchSlots() {
  const bust = '?t=' + Date.now();
  const [sc, apo] = await Promise.all([
    fetch(SLOT_JSON.shareconnect + bust).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(SLOT_JSON.apotool + bust).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  state.slots = { shareconnect: sc, apotool: apo };
}

function renderSlotsView(main) {
  main.innerHTML = '';
  main.appendChild($('#tpl-slots').content.cloneNode(true));
  $('#slots-refresh').addEventListener('click', async () => {
    $('#slots-body').innerHTML = '<div class="loader" style="min-height:120px"><div class="spinner"></div></div>';
    await fetchSlots();
    renderSlotsBody();
  });
  if (!state.slots) {
    fetchSlots().then(renderSlotsBody);
  } else {
    renderSlotsBody();
  }
}

function renderSlotsBody() {
  // v603 fix #8: view 切替中に呼ばれた時のガード
  if (state.view !== 'slots') return;
  const body = $('#slots-body');
  if (!body) return;
  const { shareconnect, apotool } = state.slots || {};
  const parts = [];
  if (shareconnect) parts.push(renderSlotSource('shareconnect', shareconnect));
  if (apotool)      parts.push(renderSlotSource('apotool',      apotool));
  if (!parts.length) {
    body.innerHTML = '<div class="empty-msg">予約枠データが取得できませんでした (data/reservation-status.json / apotool-status.json を確認)</div>';
    return;
  }
  body.innerHTML = parts.join('');
  // Update 最終確認 (from shareconnect, fallback apotool)
  const latest = (shareconnect?.lastUpdated) || (apotool?.lastUpdated) || '';
  $('#slots-updated').textContent = latest ? `最終確認: ${new Date(latest).toLocaleString('ja-JP')}` : '最終確認: —';
}

function renderSlotSource(label, json) {
  if (!json) return '';
  const clinics = json.clinics || [];
  const totalOpen = clinics.filter(c => c.available).length;
  const allOpenBadge = totalOpen > 0
    ? `<span class="badge-ok">✓ ${totalOpen}/${clinics.length} 医院 枠あり</span>`
    : `<span class="badge-none">✗ 全医院 枠なし</span>`;
  const rangeText = json.checkRangeFrom && json.checkRangeTo
    ? `${json.checkRangeFrom} 〜 ${json.checkRangeTo}` : '';
  const title = label === 'shareconnect'
    ? '📆 shareconnect (矯正相談)' : '🅰️ Apotool (矯正相談)';
  const cards = clinics.map(c => renderSlotCard(c)).join('');
  return `<section class="slot-section">
    <div class="slots-source">
      <h3>${esc(title)}</h3>
      ${allOpenBadge}
      <span class="meta">${esc(rangeText)}</span>
    </div>
    <div class="slots-grid">${cards}</div>
  </section>`;
}

function renderSlotCard(c) {
  const cls = c.available ? 'has-slots' : 'empty';
  const mark = c.available
    ? '<span class="slot-mark ok">✓ 枠あり</span>'
    : '<span class="slot-mark none">✗ 枠なし</span>';
  const meta = c.earliestDate && c.latestDate
    ? `最早: ${c.earliestDate.substring(5)} / 最終: ${c.latestDate.substring(5)}`
    : (c.latestDate ? `最終: ${c.latestDate.substring(5)}` : '-');
  return `<div class="slot-card ${cls}">
    <div class="slot-clinic"><span>${esc(c.name)}</span>${mark}</div>
    <div class="slot-count">
      <span class="num">${c.totalSlots ?? 0}</span><span class="unit">枠</span>
      <span class="days">/ ${c.availableDays ?? 0} 日分</span>
    </div>
    <div class="slot-meta">${esc(meta)}</div>
  </div>`;
}

// v603 fix #18: 患者 view の template を初回のみ挿入
// v625 bug fix: guard を .view から .patients-view にスコープ限定
//   (他 view も .view クラスを持つため、来院 → 患者 切替時に
//    テンプレ挿入がスキップされ、#p-search/#p-count/#p-tbody が null で crash していた)
let _patientSearchQ = '';
function renderPatientsView(main) {
  if (!main.querySelector('.patients-view')) {
    main.innerHTML = '';
    main.appendChild($('#tpl-patients').content.cloneNode(true));
    $('#p-search').value = _patientSearchQ;
    $('#p-search').addEventListener('input', e => {
      _patientSearchQ = e.target.value;
      renderPatientsTable();
    });
  }
  renderPatientsTable();
}
function renderPatientsTable() {
  const rows = state.patients;
  const q = _patientSearchQ.trim().toLowerCase();
  const qNorm = q.replace(/\s/g, '');
  // v603 fix #12: name と normalized_name 両方で検索
  const filtered = q ? rows.filter(p =>
    (p.normalized_name || '').includes(qNorm) ||
    (p.name || '').toLowerCase().includes(q)) : rows;
  $('#p-count').innerHTML = `<strong>${filtered.length}</strong> 患者`;
  $('#p-tbody').innerHTML = filtered.slice(0, 500).map(p => `<tr>
    <td class="c-name">${esc(p.name)}</td>
    <td>${esc(p.phone_last4 || '-')}</td>
    <td class="c-facility">${esc(p.primary_facility || '-')}</td>
    <td>-</td>
    <td class="c-updated">${esc(fmtRelative(p.last_activity))}</td>
  </tr>`).join('');
}

// ==================== v700: 初診管理シート 同期 ====================
async function refreshSheetSyncStatus() {
  const label = $('#ss-label');
  const btn = $('#sheet-sync-btn');
  if (!label) return;
  try {
    // Supabase v_latest_sync を直接 SELECT
    const { data, error } = await sb.from('v_latest_sync').select('*').limit(1).maybeSingle();
    if (error) throw error;
    if (!data) { label.textContent = 'シート同期: 未実行'; return; }
    const secs = Math.floor(Number(data.seconds_ago || 0));
    const rel = secs < 60 ? `${secs}秒前` : secs < 3600 ? `${Math.floor(secs/60)}分前` : `${Math.floor(secs/3600)}時間前`;
    label.textContent = `シート同期: ${rel}`;
    if (btn) btn.classList.toggle('error', (data.rows_error || 0) > 0);
    btn.title = `最終同期: ${new Date(data.run_at).toLocaleString('ja-JP')}\n` +
                `新規: ${data.rows_inserted || 0} / スキップ: ${data.rows_skipped || 0} / エラー: ${data.rows_error || 0}\n` +
                `クリックで今すぐ取り込み`;
  } catch(e) {
    label.textContent = 'シート同期: —';
  }
}

async function runSheetSync(showToast) {
  const btn = $('#sheet-sync-btn');
  const label = $('#ss-label');
  if (!btn || btn.classList.contains('syncing')) return;
  // v730: 入力中の自動 sync は fetchVisits で focus / 値を奪う → skip
  if (!showToast && isEditingField()) return;
  btn.classList.add('syncing');
  if (label) label.textContent = 'シート同期中…';
  try {
    const res = await fetch(`${SHEET_SYNC_WORKER}/sync?token=${encodeURIComponent(SHEET_SYNC_TOKEN)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    if (showToast) {
      toast(`シート同期完了: 新規 ${r.rowsInserted} 件 / スキップ ${r.rowsSkipped} 件`, r.rowsError ? 'err' : 'ok', 4000);
    }
    // 新規行があれば visits を再取得
    if (r.rowsInserted > 0) {
      await fetchVisits();
      if (state.view === 'visits') renderVisitsTable();
    }
  } catch(e) {
    if (showToast) toast('シート同期失敗: ' + (e.message || e), 'err', 5000);
    btn.classList.add('error');
  } finally {
    btn.classList.remove('syncing');
    refreshSheetSyncStatus();
  }
}

// v703: Aladdin から 10 分ごとに sync 発火 (Worker 側の cron が Free プラン枠切れのため)
//   sync は冪等 (sync_source unique) なので複数タブ同時発火も安全
//   さらに 5 分ごとに status 表示だけ更新
setInterval(() => { if (state.user) runSheetSync(false); }, 10 * 60 * 1000);
setInterval(() => { if (state.user) refreshSheetSyncStatus(); }, 5 * 60 * 1000);

// ==================== v614: パスワード変更モーダル ====================
function openPasswordModal() {
  if (document.querySelector('.modal-backdrop')) return;
  const backdrop = document.body.appendChild($('#tpl-pw').content.cloneNode(true).firstElementChild);
  const newInp = backdrop.querySelector('#pw-new');
  const new2Inp = backdrop.querySelector('#pw-new2');
  const err = backdrop.querySelector('#pw-err');
  const saveBtn = backdrop.querySelector('#pw-save');
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const doSave = async () => {
    err.textContent = '';
    const p1 = newInp.value, p2 = new2Inp.value;
    if (!p1 || p1.length < 8) { err.textContent = '8 文字以上を入力してください'; return; }
    if (p1 !== p2) { err.textContent = '確認用パスワードが一致しません'; return; }
    saveBtn.disabled = true; saveBtn.textContent = '変更中…';
    try {
      await changePassword(p1);
      toast('パスワードを変更しました', 'ok');
      close();
    } catch(e) {
      err.textContent = '変更失敗: ' + (e.message || e);
      saveBtn.disabled = false; saveBtn.textContent = '変更する';
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doSave(); }
  };
  document.addEventListener('keydown', onKey);
  backdrop.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  saveBtn.addEventListener('click', doSave);
  newInp.focus();
}

// ==================== v614: アクティビティビュー ====================
// updated_by と updated_at をベースに「誰がいつどの患者を触ったか」を集計。
// フィールドレベルの diff は取れないが、行レベルの活動追跡としては十分。
const activityState = {
  scope: 'today',
  date: '',
  user: '',
};
function renderActivityView(main) {
  main.innerHTML = '';
  const node = $('#tpl-activity').content.cloneNode(true);
  main.appendChild(node);

  const scopeSel = $('#a-scope');
  const dateInp = $('#a-date');
  const userSel = $('#a-user');
  scopeSel.value = activityState.scope;
  dateInp.hidden = (activityState.scope !== 'date');
  if (activityState.date) dateInp.value = activityState.date;

  // ユーザー選択肢: 現在の visits データ内で見つかった updated_by を全部リストアップ
  const users = new Set();
  for (const v of state.visits) {
    if (v.updated_by) users.add(v.updated_by);
  }
  const sortedUsers = Array.from(users).sort();
  for (const u of sortedUsers) {
    const opt = document.createElement('option');
    opt.value = u;
    opt.textContent = shortenUserLabel(u);
    userSel.appendChild(opt);
  }
  userSel.value = activityState.user;

  scopeSel.addEventListener('change', () => {
    activityState.scope = scopeSel.value;
    dateInp.hidden = (scopeSel.value !== 'date');
    renderActivityTable();
  });
  dateInp.addEventListener('change', () => { activityState.date = dateInp.value; renderActivityTable(); });
  userSel.addEventListener('change', () => { activityState.user = userSel.value; renderActivityTable(); });
  $('#a-refresh').addEventListener('click', async () => {
    setSaveStatus('更新中…', 'saving');
    await fetchVisits();
    setSaveStatus('更新完了 ✓', 'saved');
    // v628 bug fix: fetch 完了までにユーザが別 view に移動していたら再描画しない
    //   (main に閉じ込めた ref で他 view を上書きしてしまうバグ)
    if (state.view !== 'activity') return;
    renderActivityView(main);
  });

  renderActivityTable();
}

function shortenUserLabel(u) {
  if (!u) return '(不明)';
  const local = String(u).split('@')[0];
  // adachi → 足立 のマッピング (create-staff-users.js の STAFF と一致)
  const map = { adachi: '足立', uemura: '上村', yasui: '安井', kitajima: '北島', maruta: '丸田', moriwaki: '森脇', fukuda: '福田' };
  return map[local] ? `${map[local]} (${local})` : local;
}

function computeActivityRange() {
  const { scope, date } = activityState;
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  if (scope === 'today') return { from: startOfDay(now), to: new Date() };
  if (scope === 'yesterday') {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    return { from: startOfDay(y), to: new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59, 999) };
  }
  if (scope === '7' || scope === '30') {
    const days = parseInt(scope, 10);
    const from = new Date(now); from.setDate(from.getDate() - days);
    return { from, to: new Date() };
  }
  if (scope === 'date' && date) {
    const [Y, M, D] = date.split('-').map(Number);
    const from = new Date(Y, M - 1, D, 0, 0, 0, 0);
    const to = new Date(Y, M - 1, D, 23, 59, 59, 999);
    return { from, to };
  }
  return { from: startOfDay(now), to: new Date() };
}

function renderActivityTable() {
  const { from, to } = computeActivityRange();
  const fromMs = from.getTime(), toMs = to.getTime();
  const userFilter = activityState.user;
  const rows = state.visits.filter(v => {
    if (!v.updated_at || !v.updated_by) return false;
    const t = new Date(v.updated_at).getTime();
    if (isNaN(t)) return false;
    if (t < fromMs || t > toMs) return false;
    if (userFilter && v.updated_by !== userFilter) return false;
    return true;
  }).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  // 社員別サマリ
  const perUser = new Map();
  for (const v of rows) {
    const k = v.updated_by;
    perUser.set(k, (perUser.get(k) || 0) + 1);
  }
  const sumParts = Array.from(perUser.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([u, n]) => `<span class="activity-chip">${esc(shortenUserLabel(u))}: <strong>${n}</strong> 件</span>`);
  $('#a-summary').innerHTML = sumParts.length ? sumParts.join('') : '<span class="empty-msg">この期間の変更なし</span>';
  $('#a-count').innerHTML = `<strong>${rows.length}</strong> 件`;

  const tbody = $('#a-tbody');
  tbody.innerHTML = '';
  const empty = $('#a-empty');
  empty.hidden = (rows.length > 0);
  if (!rows.length) return;

  // 500 件までに抑える (パフォーマンス)
  const shown = rows.slice(0, 500);
  const frag = document.createDocumentFragment();
  for (const v of shown) {
    const tr = document.createElement('tr');
    const memo = v.memo || '';
    tr.innerHTML = `
      <td style="font-family:var(--font-mono);font-size:11px;white-space:nowrap">${esc(fmtDateTime(v.updated_at))}</td>
      <td style="font-size:12px">${esc(shortenUserLabel(v.updated_by))}</td>
      <td style="font-weight:600">${esc(v.patient_name || '-')}</td>
      <td style="font-size:11px">${esc(normFac(v.facility) || '-')}</td>
      <td style="font-size:11px"><span class="status-tag">${esc(v.bf_status || v.status || '')}</span></td>
      <td style="font-size:11px;color:var(--ink-soft)">${esc(memo)}</td>
      <td style="font-family:var(--font-mono);font-size:11px;text-align:right">${v.contract_amount != null ? '¥' + Number(v.contract_amount).toLocaleString() : ''}</td>`;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  if (rows.length > 500) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="7" style="text-align:center;color:var(--ink-mute);font-size:11px">…他 ${rows.length - 500} 件 (期間を絞ってください)</td>`;
    tbody.appendChild(tr);
  }
}

// ==================== Boot ====================
// v603 fix #7: bootAfterLogin 二重発火防止
let _bootingInProgress = false;
async function bootAfterLogin() {
  if (_bootingInProgress) return;
  _bootingInProgress = true;
  try {
    render();
    setSaveStatus('データ取得中…', 'saving');
    await Promise.all([fetchVisits(), fetchPatients()]);
    setSaveStatus('データ取得完了 ✓', 'saved');
    render();
  } finally {
    _bootingInProgress = false;
  }
}

async function boot() {
  try {
    state.user = await checkAuth();
    if (state.user) {
      await bootAfterLogin();
    } else {
      render(); // login screen
    }
  } catch(e) {
    console.error('boot error', e);
    document.getElementById('app').innerHTML = '<div class="loader"><div style="color:var(--warn)">初期化エラー: ' + esc(e.message) + '</div></div>';
  }
}

// Auth state listener
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') { state.user = null; render(); }
  if (event === 'SIGNED_IN' && session?.user) {
    state.user = session.user;
    // If we just logged in (no visits yet), fetch
    if (!state.visits.length) bootAfterLogin();
  }
});

// v607: 更新チェッカ ─ version.txt を polling し、APP_VERSION と違えばバナー表示
let _updateBannerShown = false;
async function checkForUpdate() {
  try {
    const res = await fetch('./version.txt?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const remote = (await res.text()).trim();
    if (!remote || remote === APP_VERSION) return;
    if (_updateBannerShown) return;
    _updateBannerShown = true;
    showUpdateBanner(remote);
  } catch(_) { /* ネット断・404 は無視 */ }
}
function showUpdateBanner(newVer) {
  // v628 bug fix: 既存 banner を先に削除 (id 重複 & リスナ 2 重登録防止)
  //   自動チェックで banner が出てる状態で 🔍 更新確認 押すと banner が 2 個並んで
  //   新しい方の「更新する/後で」が動かなくなっていた
  const existing = document.getElementById('update-banner');
  if (existing) existing.remove();
  const bar = document.createElement('div');
  bar.id = 'update-banner';
  bar.setAttribute('role', 'alert');
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:1000;background:linear-gradient(135deg,#1d5f56,#0f4842);color:#fff;padding:10px 20px;display:flex;align-items:center;gap:14px;box-shadow:0 2px 10px rgba(0,0,0,.25);font-family:inherit;font-size:13px;animation:slideDown 0.3s ease-out';
  bar.innerHTML = `
    <span style="flex:1">
      🎉 <strong>新しいバージョン ${esc(newVer)}</strong> があります (現在: ${esc(APP_VERSION)})
      <span style="opacity:.85;margin-left:6px;font-size:11px">・更新すると最新機能が使えます</span>
    </span>
    <button id="update-now-btn" style="padding:6px 16px;background:#fff;color:#0f4842;border:none;border-radius:5px;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit">🔄 更新する</button>
    <button id="update-later-btn" style="padding:6px 12px;background:transparent;color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:5px;font-size:11px;cursor:pointer;font-family:inherit">後で</button>
  `;
  document.body.appendChild(bar);
  // アニメーション CSS
  if (!document.getElementById('update-banner-style')) {
    const style = document.createElement('style');
    style.id = 'update-banner-style';
    style.textContent = '@keyframes slideDown { from { transform: translateY(-100%); } to { transform: translateY(0); } }';
    document.head.appendChild(style);
  }
  document.getElementById('update-now-btn').addEventListener('click', () => {
    // v722: URL 末尾に ?bust=timestamp を付けてブラウザキャッシュを強制回避
    //   (location.reload() だけでは Chrome が index.html をキャッシュから返す事があった)
    location.href = location.pathname + '?bust=' + Date.now();
  });
  document.getElementById('update-later-btn').addEventListener('click', () => {
    bar.style.transition = 'transform 0.2s'; bar.style.transform = 'translateY(-100%)';
    setTimeout(() => bar.remove(), 200);
    // v625 bug fix: 「後で」dismiss したら次の自動チェックで再表示できるよう flag リセット
    _updateBannerShown = false;
  });
}
// 初回チェック (5 秒後) + 5 分ごと + タブ復帰時
setTimeout(checkForUpdate, 5000);
setInterval(checkForUpdate, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkForUpdate();
});

// Start
boot();
})();
