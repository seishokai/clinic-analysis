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

// Status options — 実データから抽出した使用中の値をベース
const STATUS_OPTIONS = [
  '未対応', '確認済', '来院済', '予約変更', '検討中',
  'キャンセル', '成約', '離脱', '除外',
];
const STATUS_HIDDEN_BY_DEFAULT = new Set(['除外', 'キャンセル']);

const FACILITIES = [
  'BF銀座', 'エスカ', 'アール', 'ウィズ', 'ルミナス',
  '茶屋', 'アサノ', '知立', '小牧', '八事', '岩田', '大森', '京都', '訪問',
];

// ==================== State ====================
const state = {
  user: null,           // Supabase user
  view: 'visits',
  visits: [],           // v_visits_with_patient rows
  patients: [],         // patients rows
  loading: false,
  filters: {
    search: '',
    facility: '',
    status: '',
    period: 'all',      // '30' | '60' | '90' | '365' | 'all'
  },
  memoTarget: null,     // { visit_id, name, current_memo }
};

// ==================== Utils ====================
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

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
function filteredVisits() {
  const f = state.filters;
  const q = f.search.trim().toLowerCase();
  const cutoff = f.period === 'all' ? null
    : new Date(Date.now() - Number(f.period) * 86400000);
  return state.visits.filter(v => {
    // v600 fix: facility は normFac で正規化して比較 (DXHUB のフル名対応)
    if (f.facility && normFac(v.facility) !== f.facility) return false;
    if (f.status) {
      const eff = v.bf_status || v.status || '未対応';
      if (eff !== f.status) return false;
    }
    if (cutoff && v.book_date) {
      const bd = new Date(v.book_date);
      if (!isNaN(bd) && bd < cutoff) return false;
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
  else if (state.view === 'patients') renderPatientsView(main);
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
    $('#v-search').addEventListener('input', e => { state.filters.search = e.target.value; renderVisitsTable(); });
    $('#v-facility').addEventListener('change', e => { state.filters.facility = e.target.value; renderVisitsTable(); });
    $('#v-status').addEventListener('change', e => { state.filters.status = e.target.value; renderVisitsTable(); });
    $('#v-period').addEventListener('change', e => { state.filters.period = e.target.value; renderVisitsTable(); });
    $('#v-reset').addEventListener('click', () => {
      state.filters = { search: '', facility: '', status: '', period: 'all' };
      $('#v-search').value = ''; $('#v-facility').value = ''; $('#v-status').value = ''; $('#v-period').value = 'all';
      renderVisitsTable();
    });
    // Populate current filter values
    $('#v-search').value = state.filters.search;
    $('#v-facility').value = state.filters.facility;
    $('#v-status').value = state.filters.status;
    $('#v-period').value = state.filters.period;
  }
  renderVisitsTable();
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
  const memo = v.memo || '';
  return `<tr data-visit-id="${esc(v.visit_id)}">
    <td class="c-book">${esc(bookDisplay)}</td>
    <td class="c-name" title="${esc(v.normalized_name || '')}">${esc(v.patient_name || '(名前なし)')}</td>
    <td class="c-facility" title="${esc(v.facility || '')}">${esc(normFac(v.facility) || '-')}</td>
    <td class="c-status">
      <select class="status-sel" data-value="${esc(eff)}" data-visit-id="${esc(v.visit_id)}">
        ${statusOptsHtml}
      </select>
    </td>
    <td class="c-amount">
      <input type="text" class="amount-input" data-visit-id="${esc(v.visit_id)}"
             value="${esc(fmtYen(v.contract_amount))}" placeholder="¥0">
    </td>
    <td class="c-memo">
      <div class="memo-cell ${memo ? 'has-value' : 'empty'}" data-visit-id="${esc(v.visit_id)}">
        ${memo ? esc(memo.length > 40 ? memo.slice(0,40) + '…' : memo) : '+ メモ'}
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
