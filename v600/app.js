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

// ==================== Config ====================
const SUPABASE_URL = 'https://ndlfqrvoejwgqfdtghmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5kbGZxcnZvZWp3Z3FmZHRnaG1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1ODIxNjcsImV4cCI6MjA5MTE1ODE2N30.pE-l-4NgQTpEb9DvjeRptargvrsYH9YKyRLt06flPik';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// Status options — v521 の BF ライフサイクル全 status を含める。
//   使用頻度順 → 一般 → BF 特有 → 終端
const STATUS_OPTIONS = [
  '未対応', '確認済', '来院済', '予約変更', '検討中',
  '予約連絡待ち', '後追いLINE済み', '離脱',
  '成約', 'ローン審査中', 'ローン審査落',
  '矯正決定(BF保留)', 'ラブリエ決定(BF保留)', 'インプラント決定(BF保留)',
  '印象待ち(治療無)', '印象待ち(治療有)', '治療中',
  'セット日確定待ち', 'セット待ち', 'セット完了',
  'キャンセル', '除外',
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
  if (n == null || n === '') return '';
  const num = Number(n);
  if (isNaN(num) || num === 0) return '';
  return '¥' + num.toLocaleString();
}
function parseAmount(s) {
  const v = String(s || '').replace(/[^\d-]/g, '');
  if (!v) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
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
async function login(email, pw) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pw });
  if (error) throw error;
  return data.user;
}
async function logout() {
  await sb.auth.signOut();
  state.user = null;
  render();
}

// ==================== Data fetch ====================
async function fetchVisits() {
  state.loading = true;
  // v600 fix #1: Supabase JS の default max 1000 を超えるため range ページング必須
  // v600 fix #2: 未来の予約 (book_date > today) は来院タブに出さない (v521 同挙動)
  const todayIso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let all = [];
  const pageSize = 1000;
  let from = 0;
  for (let page = 0; page < 20; page++) { // safety cap 20 pages = 20k rows
    const { data, error } = await sb
      .from('v_visits_with_patient')
      .select('*')
      .or(`book_date.is.null,book_date.lte.${todayIso}`)   // 未来来院除外
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
  }
  state.loading = false;
  state.visits = all;
}

async function fetchPatients() {
  const { data, error } = await sb
    .from('patients')
    .select('id, name, normalized_name, phone_last4, primary_facility, last_activity')
    .eq('deleted', false)
    .order('last_activity', { ascending: false, nullsFirst: false })
    .limit(5000);
  if (error) { console.error(error); return; }
  state.patients = data || [];
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
  // ローカル state に反映 (差分更新、丸ごと置換しない)
  const idx = state.visits.findIndex(v => v.visit_id === visitId);
  if (idx >= 0) {
    Object.assign(state.visits[idx], patch, { updated_at: data.updated_at });
  }
  setSaveStatus('保存完了 ✓', 'saved');
  return { ok: true, data };
}

// ==================== Filtering ====================
function computePeriodRange(f) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const p = f.period;
  if (p === 'all') return { from: null, to: null };
  if (p === 'thisMonth') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    return { from, to };
  }
  if (p === 'lastMonth') {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    return { from, to };
  }
  if (p === 'month') {
    const m = f.periodMonth; // "YYYY-MM"
    if (!m) return { from: null, to: null };
    const [y, mo] = m.split('-').map(Number);
    return {
      from: new Date(y, mo - 1, 1),
      to: new Date(y, mo, 0, 23, 59, 59),
    };
  }
  if (p === 'range') {
    return {
      from: f.periodFrom ? new Date(f.periodFrom + 'T00:00:00') : null,
      to:   f.periodTo   ? new Date(f.periodTo   + 'T23:59:59') : null,
    };
  }
  // 直近 N 日
  const n = Number(p);
  if (isNaN(n)) return { from: null, to: null };
  return { from: new Date(today.getTime() - n * 86400000), to: null };
}

function filteredVisits() {
  const f = state.filters;
  const q = f.search.trim().toLowerCase();
  const { from, to } = computePeriodRange(f);
  return state.visits.filter(v => {
    // v600 fix: facility は normFac で正規化して比較 (DXHUB のフル名対応)
    if (f.facility && normFac(v.facility) !== f.facility) return false;
    if (f.treatment && getTreatment(v.service, v.contract_service) !== f.treatment) return false;
    if (f.promo && (v.promo_code || '') !== f.promo) return false;
    if (f.status) {
      const eff = v.bf_status || v.status || '未対応';
      if (eff !== f.status) return false;
    }
    if ((from || to) && v.book_date) {
      const bd = new Date(v.book_date);
      if (!isNaN(bd)) {
        if (from && bd < from) return false;
        if (to && bd > to) return false;
      }
    }
    if (q) {
      const hay = (v.patient_name || '') + ' ' + (v.normalized_name || '') + ' ' + (v.phone || '');
      if (!hay.toLowerCase().includes(q)) return false;
    }
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
  $('#user-email').textContent = state.user.email || '';
  // Active nav
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  // View
  const main = $('#main');
  if (state.view === 'visits') renderVisitsView(main);
  else if (state.view === 'bookings') renderBookingsView(main);
  else if (state.view === 'patients') renderPatientsView(main);
  else if (state.view === 'slots') renderSlotsView(main);
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
  $('#refresh-btn').addEventListener('click', async () => {
    setSaveStatus('更新中…', 'saving');
    await Promise.all([fetchVisits(), fetchPatients()]);
    setSaveStatus('更新完了 ✓', 'saved');
    render();
  });
}

// v600 fix #6: search debounce timer
let _searchDebounce = null;

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
      renderVisitsTable();
    });
    $('#v-month').addEventListener('change', e => { state.filters.periodMonth = e.target.value; renderVisitsTable(); });
    $('#v-from').addEventListener('change', e => { state.filters.periodFrom = e.target.value; renderVisitsTable(); });
    $('#v-to').addEventListener('change', e => { state.filters.periodTo = e.target.value; renderVisitsTable(); });
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
  // v600 fix #5b: promo dropdown は毎回 populate (state.visits が更新されるたび)
  //   → 初回 render 時 state.visits が空でも、fetch 完了後の 2 回目 render で正しく populate される
  populatePromoOptions();
  updatePeriodExtraInputs();
  renderVisitsTable();
}

function updatePeriodExtraInputs() {
  const p = state.filters.period;
  const monthInp = $('#v-month');
  const rangeWrap = $('#v-range-wrap');
  if (monthInp) monthInp.hidden = (p !== 'month');
  if (rangeWrap) rangeWrap.hidden = (p !== 'range');
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
  // Render (max 500 rows for perf; add pagination later)
  const shown = rows.slice(0, 500);
  tbody.innerHTML = shown.map(rowHtml).join('');
  // Bind events (event delegation would be cleaner but this is fine for MVP)
  shown.forEach(v => bindRow(v));
  if (rows.length > 500) {
    tbody.insertAdjacentHTML('beforeend',
      `<tr><td colspan="7" class="empty-msg">…他 ${rows.length - 500} 件 (フィルタで絞り込んでください)</td></tr>`);
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
      <div class="memo-cell ${memo ? 'has-value' : 'empty'}" data-visit-id="${esc(v.visit_id)}">
        ${memo ? esc(memo.length > 30 ? memo.slice(0,30) + '…' : memo) : '+ メモ'}
      </div>
    </td>
    <td class="c-updated">${esc(fmtRelative(v.updated_at))}</td>
  </tr>`;
}

function bindRow(v) {
  const tr = $(`tr[data-visit-id="${CSS.escape(v.visit_id)}"]`);
  if (!tr) return;

  // Status change
  const sel = tr.querySelector('.status-sel');
  sel.addEventListener('change', async () => {
    const newValue = sel.value;
    sel.classList.remove('saved', 'failed');
    sel.classList.add('saving');
    sel.dataset.value = newValue;
    // BF 系の status は bf_status、それ以外は status に保存
    //   MVP では両方に書く (どちらでも参照可能)
    const patch = { status: newValue };
    // If it looks like a BF-specific status keep as bf_status too
    if (['予約連絡待ち', '後追いLINE済み', '予約変更', '検討中', '離脱',
         'ローン審査中', 'ローン審査落', '成約', 'キャンセル', '未対応'].includes(newValue)) {
      patch.bf_status = newValue;
    }
    const res = await sb.from('patient_visits')
      .update({ ...patch, updated_by: state.user?.email || 'unknown' })
      .eq('id', v.visit_id).select().single();
    sel.classList.remove('saving');
    if (res.error) {
      sel.classList.add('failed');
      toast('ステータス保存失敗: ' + res.error.message, 'err', 5000);
    } else {
      sel.classList.add('saved');
      // Update local state
      const idx = state.visits.findIndex(x => x.visit_id === v.visit_id);
      if (idx >= 0) {
        Object.assign(state.visits[idx], patch, { updated_at: res.data.updated_at });
      }
      setTimeout(() => sel.classList.remove('saved'), 1500);
      setSaveStatus('保存完了 ✓', 'saved');
    }
  });

  // Amount input (blur to save)
  const amt = tr.querySelector('.amount-input');
  let amtOrigValue = amt.value;
  amt.addEventListener('focus', () => { amtOrigValue = amt.value; });
  amt.addEventListener('blur', async () => {
    const raw = amt.value.trim();
    if (raw === amtOrigValue) return; // no change
    const num = parseAmount(raw);
    amt.classList.remove('saved', 'failed');
    amt.classList.add('saving');
    const res = await saveVisitField(v.visit_id, 'contract_amount', num);
    amt.classList.remove('saving');
    if (res.ok) {
      amt.value = fmtYen(num);
      amt.classList.add('saved');
      setTimeout(() => amt.classList.remove('saved'), 1500);
    } else {
      amt.classList.add('failed');
      amt.value = amtOrigValue;
    }
  });

  // Memo click → modal
  const memoEl = tr.querySelector('.memo-cell');
  memoEl.addEventListener('click', () => openMemoModal(v));

  // v600 fix #3: 次回予定 / 成約商材 / 成約月 の即時保存
  tr.querySelectorAll('.field-input').forEach(inp => {
    let orig = inp.value;
    inp.addEventListener('focus', () => { orig = inp.value; });
    inp.addEventListener('change', async () => {
      const field = inp.dataset.field;
      if (!field) return;
      let value = inp.value;
      if (field === 'contract_date') {
        // <input type=month> は "YYYY-MM" 値。DB DATE 型に合わせて "YYYY-MM-01"
        value = value ? value + '-01' : null;
      } else if (field === 'contract_service') {
        value = value || null;
      } else if (field === 'next_visit_date') {
        value = value || null; // YYYY-MM-DD or null
      }
      inp.classList.remove('saved', 'failed');
      inp.classList.add('saving');
      const res = await saveVisitField(v.visit_id, field, value);
      inp.classList.remove('saving');
      if (res.ok) {
        inp.classList.add('saved');
        setTimeout(() => inp.classList.remove('saved'), 1500);
        orig = inp.value;
      } else {
        inp.classList.add('failed');
        inp.value = orig;
      }
    });
  });
}

function openMemoModal(v) {
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
  const close = () => backdrop.remove();
  backdrop.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; saveBtn.textContent = '保存中…';
    const res = await saveVisitField(v.visit_id, 'memo', text.value || null);
    if (res.ok) {
      // Update DOM row
      const tr = $(`tr[data-visit-id="${CSS.escape(v.visit_id)}"]`);
      if (tr) {
        const mc = tr.querySelector('.memo-cell');
        const m = text.value || '';
        mc.classList.toggle('has-value', !!m);
        mc.classList.toggle('empty', !m);
        mc.textContent = m ? (m.length > 40 ? m.slice(0,40) + '…' : m) : '+ メモ';
      }
      toast('メモを保存しました', 'ok');
      close();
    } else {
      saveBtn.disabled = false; saveBtn.textContent = '保存';
    }
  });
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
    $('#b-search').addEventListener('input', e => { state.bookingFilters.search = e.target.value; renderBookingsTable(); });
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

function renderPatientsView(main) {
  main.innerHTML = '';
  main.appendChild($('#tpl-patients').content.cloneNode(true));
  const tbody = $('#p-tbody');
  const rows = state.patients;
  $('#p-count').innerHTML = `<strong>${rows.length}</strong> 患者`;
  tbody.innerHTML = rows.slice(0, 500).map(p => `<tr>
    <td class="c-name">${esc(p.name)}</td>
    <td>${esc(p.phone_last4 || '-')}</td>
    <td class="c-facility">${esc(p.primary_facility || '-')}</td>
    <td>-</td>
    <td class="c-updated">${esc(fmtRelative(p.last_activity))}</td>
  </tr>`).join('');
  $('#p-search').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    const filtered = q ? rows.filter(p => (p.normalized_name || '').includes(q.replace(/\s/g,''))) : rows;
    $('#p-count').innerHTML = `<strong>${filtered.length}</strong> 患者`;
    tbody.innerHTML = filtered.slice(0, 500).map(p => `<tr>
      <td class="c-name">${esc(p.name)}</td>
      <td>${esc(p.phone_last4 || '-')}</td>
      <td class="c-facility">${esc(p.primary_facility || '-')}</td>
      <td>-</td>
      <td class="c-updated">${esc(fmtRelative(p.last_activity))}</td>
    </tr>`).join('');
  });
}

// ==================== Boot ====================
async function bootAfterLogin() {
  render(); // shell + placeholder
  setSaveStatus('データ取得中…', 'saving');
  await Promise.all([fetchVisits(), fetchPatients()]);
  setSaveStatus('データ取得完了 ✓', 'saved');
  render();
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

// Start
boot();
})();
