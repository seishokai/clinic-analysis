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
const APP_VERSION = 'v614';

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
  '除外',
];
const STATUS_HIDDEN_BY_DEFAULT = new Set(['除外', 'キャンセル']);

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
  if (s.includes('インプラント')) return 'インプラント';
  if (s.includes('矯正')) return '矯正';
  return 'その他';
}

// 成約商材の選択肢 (v521 と同じ)
const CONTRACT_SERVICE_OPTIONS = ['', 'BF', '矯正(表)', '矯正(裏)', '矯正(ﾋﾟｰｽ)', 'ﾗﾌﾞﾘｴ', 'ｲﾝﾌﾟﾗﾝﾄ'];

// プロモコード → 表示ラベル短縮
function shortPromo(p) {
  if (!p) return '';
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
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 200); }, ttl);
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
    const { data, error } = await sb
      .from('v_visits_with_patient')
      .select('*')
      .or(`book_date.is.null,book_date.lte.${todayIso}`)
      .order('book_date', { ascending: false, nullsFirst: false })
      .range(from, from + pageSize - 1);
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
  // v603 P4/P8: fetch 時に事前計算した検索キー・日付 epoch・正規化フィールドを付与
  //   filter/render で毎回計算するのを回避 (3150 rows × filter で ~30ms → ~3ms)
  const now = Date.now();
  all.forEach(v => {
    v._effStatus = v.bf_status || v.status || '未対応';
    v._normFacility = normFac(v.facility);
    v._treatment = getTreatment(v.service, v.contract_service);
    v._searchHay = ((v.patient_name || '') + ' ' + (v.normalized_name || '') + ' ' + (v.phone || '')).toLowerCase();
    v._bookMs = v.book_date ? new Date(v.book_date + 'T00:00:00+09:00').getTime() : null;
  });
  state.visits = all;
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
    // v604: STATUS_HIDDEN_BY_DEFAULT 撤回 — キャンセル/除外 も見たい (ユーザー要望)
    if (f.status && v._effStatus !== f.status) return false;
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
  if (!state.user) {
    renderLogin(app);
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
      render();
    });
  });
  $('#logout-btn').addEventListener('click', logout);
  // v614: パスワード変更
  const pwBtn = $('#pw-change-btn');
  if (pwBtn) pwBtn.addEventListener('click', openPasswordModal);
  $('#refresh-btn').addEventListener('click', async () => {
    setSaveStatus('更新中…', 'saving');
    await Promise.all([fetchVisits(), fetchPatients()]);
    setSaveStatus('更新完了 ✓', 'saved');
    render();
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
    // Bind filters
    $('#v-search').addEventListener('input', e => {
      // v600 fix #6: 3000 行に対する検索は debounce (200ms) で軽量化
      state.filters.search = e.target.value;
      if (_searchDebounce) clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(() => renderVisitsTable(), 200);
    });
    $('#v-facility').addEventListener('change', e => { state.filters.facility = e.target.value; renderVisitsTable(); });
    $('#v-treatment').addEventListener('change', e => { state.filters.treatment = e.target.value; renderVisitsTable(); });
    $('#v-promo').addEventListener('change', e => { state.filters.promo = e.target.value; renderVisitsTable(); });
    $('#v-status').addEventListener('change', e => { state.filters.status = e.target.value; renderVisitsTable(); });
    $('#v-period').addEventListener('change', e => {
      state.filters.period = e.target.value;
      updatePeriodExtraInputs();
      updateQuickPeriodButtons();
      renderVisitsTable();
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
        renderVisitsTable();
      });
    });
    $('#v-month').addEventListener('change', e => { state.filters.periodMonth = e.target.value; renderVisitsTable(); });
    $('#v-from').addEventListener('change', e => { state.filters.periodFrom = e.target.value; renderVisitsTable(); });
    $('#v-to').addEventListener('change', e => { state.filters.periodTo = e.target.value; renderVisitsTable(); });
    // v609: CSV 出力 (現在のフィルタ結果のみ)
    $('#v-export-csv').addEventListener('click', () => {
      const rows = filteredVisits();
      if (!rows.length) { toast('出力する行がありません', 'err'); return; }
      exportVisitsCsv(rows);
    });
    $('#v-reset').addEventListener('click', () => {
      state.filters = { search: '', facility: '', treatment: '', promo: '', status: '', period: 'all',
                        periodMonth: '', periodFrom: '', periodTo: '' };
      $('#v-search').value = ''; $('#v-facility').value = ''; $('#v-treatment').value = '';
      $('#v-promo').value = ''; $('#v-status').value = ''; $('#v-period').value = 'all';
      $('#v-month').value = ''; $('#v-from').value = ''; $('#v-to').value = '';
      updatePeriodExtraInputs();
      renderVisitsTable();
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
  const rows = filteredVisits();
  $('#v-count').innerHTML = `<strong>${rows.length}</strong> / ${state.visits.length} 件`;
  $('#v-updated').textContent = `更新: ${new Date().toLocaleTimeString()}`;
  const tbody = $('#v-tbody');
  const empty = $('#v-empty');
  if (!rows.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  // v603 fix #6: 編集中の row (focused input を持つ tr) は再描画から除外
  //   → filter 変更中でも入力途中の値が消えない
  const focusedRow = document.activeElement && document.activeElement.closest && document.activeElement.closest('tr[data-visit-id]');
  const focusedId = focusedRow && focusedRow.dataset.visitId;
  const shown = rows.slice(0, _visitsShownLimit);
  // v603 P2: DocumentFragment + template で高速化
  const html = shown.map(rowHtml).join('');
  if (focusedId) {
    // 編集中の行を保持しつつ他を差し替え
    const focusedHtml = focusedRow.outerHTML;
    tbody.innerHTML = html;
    const newRow = tbody.querySelector(`tr[data-visit-id="${CSS.escape(focusedId)}"]`);
    if (newRow) newRow.outerHTML = focusedHtml;
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
    <td class="c-name" title="${esc(v.normalized_name || '')}">${esc(v.patient_name || '(名前なし)')}</td>
    <td class="c-treatment"><span class="treatment-chip" data-t="${esc(treatment)}">${esc(treatment)}</span></td>
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
    // v600 fix: 来院管理と同じソート = book_date DESC
    all.sort((a, b) => {
      const ad = a.bookDate || a.applyDate || '';
      const bd = b.bookDate || b.applyDate || '';
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
      $('#b-tbody').innerHTML = '<tr><td colspan="8" class="empty-msg">読み込み中…</td></tr>';
      await fetchBookings();
      renderBookingsTable();
    });
  }
  if (!state.bookings) {
    $('#b-tbody').innerHTML = '<tr><td colspan="8" class="empty-msg">読み込み中…</td></tr>';
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
  tbody.innerHTML = shown.map(r => `<tr>
    <td class="c-book">${esc(r.bookDate ? r.bookDate.substring(5,10).replace('-','/').replace(/^0/,'') : '-')}</td>
    <td class="c-name">${esc(r.name || '')}</td>
    <td class="c-facility">${esc(normFac(r.facility) || '-')}</td>
    <td class="c-promo"><span class="promo-chip ${r.tool==='セレクト'?'select-type':''}" title="${esc(r.source||'')}">${esc(shortPromo(r.source||'') || '-')}</span></td>
    <td>${esc(r.service || '-')}</td>
    <td style="font-size:11px;color:var(--ink-mute);font-family:var(--font-mono)">${esc(r.email || '-')}</td>
    <td style="font-family:var(--font-mono);font-size:11px">${esc(r.phone || '-')}</td>
    <td class="c-book">${esc(r.applyDate ? r.applyDate.substring(0,10) : '-')}</td>
  </tr>`).join('');
  if (rows.length > 500) {
    tbody.insertAdjacentHTML('beforeend',
      `<tr><td colspan="8" class="empty-msg">…他 ${rows.length - 500} 件 (フィルタで絞ってください)</td></tr>`);
  }
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
let _patientSearchQ = '';
function renderPatientsView(main) {
  if (!main.querySelector('.view')) {
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
    renderActivityView(main);   // 再描画
  });

  renderActivityTable();
}

function shortenUserLabel(u) {
  if (!u) return '(不明)';
  const local = String(u).split('@')[0];
  // adachi → 足立 のマッピング (create-staff-users.js の STAFF と一致)
  const map = { adachi: '足立', uemura: '上村', yasui: '安井', kitajima: '北島' };
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
    // キャッシュを回避しつつリロード
    location.reload();
  });
  document.getElementById('update-later-btn').addEventListener('click', () => {
    bar.style.transition = 'transform 0.2s'; bar.style.transform = 'translateY(-100%)';
    setTimeout(() => bar.remove(), 200);
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
