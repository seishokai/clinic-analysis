// === HTML escaping utility (XSS対策) ===
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
const esc = escapeHtml; // 短縮エイリアス (innerHTML展開・属性値両対応)

// === Supabase ===
const SUPABASE_URL = 'https://ndlfqrvoejwgqfdtghmg.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5kbGZxcnZvZWp3Z3FmZHRnaG1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1ODIxNjcsImV4cCI6MjA5MTE1ODE2N30.pE-l-4NgQTpEb9DvjeRptargvrsYH9YKyRLt06flPik';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// === 新規: auth-admin Worker (代理店アカウント1クリック発行用) ===
// 既存の seishokai-ai-proxy とは別の Worker。未デプロイ時は旧UIにフォールバック。
const AUTH_ADMIN_URL = 'https://seishokai-auth-admin.tkm-koike.workers.dev';

async function getCurrentAuthJwt() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    return session?.access_token || null;
  } catch (_) { return null; }
}

// Worker が到達可能かチェック (DNS未設定・未デプロイなら false)
async function isAuthAdminWorkerAvailable() {
  try {
    const r = await fetch(AUTH_ADMIN_URL + '/auth-admin/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    // 401 (auth missing) が返れば Worker 稼働中。404/network err なら未デプロイ扱い。
    return r.status === 401 || r.status === 400;
  } catch (_) { return false; }
}

// =========================================
// A3: 保存リトライキュー
// =========================================
const SAVE_QUEUE_KEY = 'save-queue-v1';
let saveQueueTimer = null;
function enqueueSave(op) {
  const q = JSON.parse(localStorage.getItem(SAVE_QUEUE_KEY) || '[]');
  q.push({ ...op, id: Date.now() + Math.random(), attempts: 0, lastAttempt: 0 });
  localStorage.setItem(SAVE_QUEUE_KEY, JSON.stringify(q));
  updateQueueBadge();
  // #13 キュー非空時のみ定期処理を起動
  startQueueProcessor();
}
// #13: キューが空のときは setInterval を動かさない
let _qInterval = null;
function startQueueProcessor() {
  if (_qInterval) return;
  _qInterval = setInterval(() => {
    if (getQueue().length === 0) { clearInterval(_qInterval); _qInterval = null; return; }
    processQueue(false);
  }, 10000);
}
function getQueue() { return JSON.parse(localStorage.getItem(SAVE_QUEUE_KEY) || '[]'); }
function setQueue(q) { localStorage.setItem(SAVE_QUEUE_KEY, JSON.stringify(q)); updateQueueBadge(); }
function updateQueueBadge() {
  const q = getQueue();
  let el = document.getElementById('rt-queue-badge');
  if (!q.length) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'rt-queue-badge';
    el.style.cssText = 'position:fixed;right:16px;bottom:16px;background:#f59e0b;color:#fff;padding:8px 14px;border-radius:20px;font-size:12px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:999;cursor:pointer;font-family:inherit';
    el.title = 'クリックで今すぐ再送信';
    el.addEventListener('click', () => processQueue(true));
    document.body.appendChild(el);
  }
  el.textContent = `⏳ 保留中 ${q.length}件`;
}
async function processQueue(force) {
  const q = getQueue();
  if (!q.length) return;
  const now = Date.now();
  const remaining = [];
  for (const op of q) {
    const backoff = Math.min(300000, 3000 * Math.pow(2, op.attempts)); // 3s→6→12→...→5分
    if (!force && now - op.lastAttempt < backoff) { remaining.push(op); continue; }
    try {
      let error = null;
      if (op.type === 'upsert') {
        const r = await sb.from(op.table).upsert(op.payload, op.options || {});
        error = r.error;
      } else if (op.type === 'insert') {
        const r = await sb.from(op.table).insert(op.payload);
        error = r.error;
      } else if (op.type === 'update') {
        let query = sb.from(op.table).update(op.payload);
        Object.entries(op.match || {}).forEach(([k,v]) => { query = query.eq(k, v); });
        const r = await query;
        error = r.error;
      } else if (op.type === 'delete') {
        let query = sb.from(op.table).delete();
        Object.entries(op.match || {}).forEach(([k,v]) => { query = query.eq(k, v); });
        const r = await query;
        error = r.error;
      }
      if (error) throw error;
      // 成功
    } catch(e) {
      op.attempts = (op.attempts || 0) + 1;
      op.lastAttempt = now;
      op.lastError = e.message || String(e);
      if (op.attempts < 10) remaining.push(op);
      else console.error('Save queue: abandoned after 10 attempts', op);
    }
  }
  setQueue(remaining);
}
// safeSave: DB保存を試み、失敗したらキューに溜める
async function safeSave(op) {
  try {
    let result;
    if (op.type === 'upsert') result = await sb.from(op.table).upsert(op.payload, op.options || {});
    else if (op.type === 'insert') result = await sb.from(op.table).insert(op.payload);
    else if (op.type === 'update') {
      let q = sb.from(op.table).update(op.payload);
      Object.entries(op.match || {}).forEach(([k,v]) => { q = q.eq(k, v); });
      result = await q;
    }
    else if (op.type === 'delete') {
      let q = sb.from(op.table).delete();
      Object.entries(op.match || {}).forEach(([k,v]) => { q = q.eq(k, v); });
      result = await q;
    }
    if (result && result.error) throw result.error;
    return { ok: true, data: result?.data };
  } catch(e) {
    console.warn('safeSave failed, queueing', op, e);
    enqueueSave(op);
    return { ok: false, error: e };
  }
}
// #13 リトライ定期実行: キュー非空のときのみ起動する方式 (上の startQueueProcessor)
// 起動時/オンライン復帰時にキューがあれば再稼働させる
window.addEventListener('online', () => { processQueue(true); if (getQueue().length) startQueueProcessor(); });
window.addEventListener('load', () => {
  updateQueueBadge();
  if (getQueue().length) {
    setTimeout(() => { processQueue(false); if (getQueue().length) startQueueProcessor(); }, 2000);
  }
});

// =========================================
// A2: 楽観的ロック (updated_at チェック)
// =========================================
// 行の updated_at を保持するキャッシュ
const optimisticVersions = {}; // key: "table:id" → updated_at 文字列
function setVersion(table, id, ts) { optimisticVersions[`${table}:${id}`] = ts; }
function getVersion(table, id) { return optimisticVersions[`${table}:${id}`]; }

// 条件付きUPDATE: updated_atが一致するときだけ更新する
async function conditionalUpdate(table, matchKey, seenUpdatedAt, changes) {
  let query = sb.from(table).update(changes);
  Object.entries(matchKey).forEach(([k,v]) => { query = query.eq(k, v); });
  if (seenUpdatedAt) query = query.eq('updated_at', seenUpdatedAt);
  const { data, error } = await query.select();
  if (error) return { ok: false, error };
  if (!data || !data.length) return { ok: false, conflict: true };
  // 新しい updated_at をキャッシュ更新
  if (data[0].updated_at) {
    const id = matchKey.id || (matchKey.name + '|' + matchKey.apply_date);
    setVersion(table, id, data[0].updated_at);
  }
  return { ok: true, data: data[0] };
}

// 競合通知
let conflictToastShown = false;
function showConflictDialog(msg, onReload) {
  if (conflictToastShown) return;
  conflictToastShown = true;
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9998;display:flex;align-items:center;justify-content:center;font-family:inherit';
  ov.innerHTML = `
    <div style="background:#fff;padding:20px 24px;border-radius:8px;max-width:420px;border:2px solid #f59e0b;box-shadow:0 12px 40px rgba(0,0,0,.2)">
      <div style="font-size:14px;font-weight:700;margin-bottom:8px;color:#b45309">⚠ 他のユーザーが先に編集しました</div>
      <div style="font-size:12px;color:#555;margin-bottom:14px;line-height:1.6">${msg}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="conflict-cancel" style="padding:6px 14px;background:#fff;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-family:inherit">キャンセル</button>
        <button id="conflict-reload" style="padding:6px 14px;background:#f59e0b;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-family:inherit">最新を読込</button>
      </div>
    </div>
  `;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); conflictToastShown = false; };
  ov.querySelector('#conflict-cancel').addEventListener('click', close);
  ov.querySelector('#conflict-reload').addEventListener('click', () => { close(); onReload && onReload(); });
}

// =========================================
// A1: リアルタイム同期
// =========================================
let realtimeChannels = [];
function setupRealtime() {
  // 既存チャンネル解除
  realtimeChannels.forEach(ch => { try { sb.removeChannel(ch); } catch(_){} });
  realtimeChannels = [];

  const tables = ['booking_status','manual_bookings','self_recordings','bf_history','accounts','promo_rates','para_records'];
  tables.forEach(tbl => {
    const ch = sb.channel('rt-' + tbl)
      .on('postgres_changes', { event: '*', schema: 'public', table: tbl }, (payload) => {
        handleRealtimeChange(tbl, payload);
      }).subscribe();
    realtimeChannels.push(ch);
  });
  console.debug('[Realtime] Subscribed:', tables);
}

// 再描画デバウンス
const rtDebounce = {};
function debouncedRefresh(key, fn, delay = 800) {
  if (rtDebounce[key]) clearTimeout(rtDebounce[key]);
  rtDebounce[key] = setTimeout(() => { rtDebounce[key] = null; try { fn(); } catch(e) { console.warn(e); } }, delay);
}

function handleRealtimeChange(table, payload) {
  const row = payload.new || payload.old || {};
  // updated_at をキャッシュ更新 (A2)
  if (row.id && row.updated_at) setVersion(table, row.id, row.updated_at);
  if (row.name && row.apply_date && row.updated_at) setVersion(table, row.name + '|' + row.apply_date, row.updated_at);

  if (table === 'booking_status' || table === 'manual_bookings') {
    // 予約系: 該当行を bookingsData に反映
    if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
      const key = row.name + '|' + row.apply_date;
      const d = (bookingsData || []).find(b => b.name === row.name && b.applyDate === row.apply_date);
      if (d) {
        if (row.status !== undefined) d.status = row.status;
        if (row.contract_amount !== undefined) d.contractAmount = row.contract_amount;
        if (row.incentive_amount !== undefined) d.incentiveAmount = row.incentive_amount;
        if (row.contract_service !== undefined) d.contractService = row.contract_service;
        if (row.payment_month !== undefined) d.paymentMonth = row.payment_month;
        if (row.incentive_month !== undefined) d.incentiveMonth = row.incentive_month;
        if (row.incentive_paid !== undefined) d.incentivePaid = row.incentive_paid;
        if (row.paid_at !== undefined) d.paidAt = row.paid_at;
        if (row.paid_by !== undefined) d.paidBy = row.paid_by;
        if (row.book_date !== undefined && row.book_date) d.bookDate = row.book_date;
        if (row.memo !== undefined) d._memo = row.memo;
        if (row.bf_memo !== undefined && !d._memo) d._memo = row.bf_memo;
      }
      // BFキャッシュも更新
      if (row.bf_status !== undefined || row.bf_next_date !== undefined || row.bf_cs_facility !== undefined || row.bf_cs_doctor !== undefined || row.bf_memo !== undefined || row.bf_set_facility !== undefined || row.bf_travel_cost !== undefined) {
        if (!bfLifecycleCache[key]) bfLifecycleCache[key] = { name: row.name, apply_date: row.apply_date };
        Object.keys(row).forEach(k => { if (k.startsWith('bf_')) bfLifecycleCache[key][k] = row[k]; });
      }
    }
    // 画面更新 (デバウンス)
    if (currentView === 'bookings') {
      debouncedRefresh('bookings', () => {
        if (typeof renderBookings === 'function') renderBookings();
        // BF進捗タブが表示中ならファネル+一覧だけ更新 (フィルター維持)
        const lc = document.getElementById('bf-lifecycle');
        if (lc && !lc.hidden && typeof updateBFFunnelAndTable === 'function') {
          updateBFFunnelAndTable(getBFRows());
        }
      });
    }
  } else if (table === 'self_recordings') {
    debouncedRefresh('recordings', () => {
      if (typeof renderRecordings === 'function' && currentView === 'tc') renderRecordings();
    });
  } else if (table === 'bf_history') {
    // 履歴キャッシュに追記
    const key = row.booking_name + '|' + row.booking_apply_date;
    if (!bfHistoryCache[key]) bfHistoryCache[key] = [];
    if (payload.eventType === 'INSERT') bfHistoryCache[key].unshift(row);
    else if (payload.eventType === 'DELETE' && payload.old?.id) {
      bfHistoryCache[key] = bfHistoryCache[key].filter(h => h.id !== payload.old.id);
    }
    debouncedRefresh('bfhistory', () => {
      const lc = document.getElementById('bf-lifecycle');
      if (lc && !lc.hidden) drawBFLifecycleTable(getBFRows());
    });
  } else if (table === 'accounts') {
    debouncedRefresh('accounts', () => { if (typeof renderAccounts === 'function') renderAccounts(); });
  } else if (table === 'promo_rates') {
    debouncedRefresh('promo', () => { if (typeof renderPromoRates === 'function') renderPromoRates(); });
  } else if (table === 'para_records') {
    debouncedRefresh('para', () => { if (typeof renderPara === 'function') renderPara(); });
  }

  // 他ユーザー編集通知（控えめに）
  showRealtimeIndicator();
}

function getBFRows() {
  const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
  const raw = (bookingsData || []).filter(d => {
    const svc = (d.service || '').toLowerCase();
    if (!(svc.includes('bf') || svc.includes('ブラック'))) return false;
    if (d.status === '除外') return false;
    const bd = parseDate(d.bookDate);
    if (bd && bd > todayEnd) return false;
    return true;
  });
  return dedupBFRows(raw);
}

let rtIndicatorTimer = null;
function showRealtimeIndicator() {
  let el = document.getElementById('rt-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rt-indicator';
    el.style.cssText = 'position:fixed;right:16px;top:16px;background:#10b981;color:#fff;padding:5px 12px;border-radius:14px;font-size:10px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.15);z-index:999;opacity:0;transition:opacity .3s;font-family:inherit;pointer-events:none';
    el.textContent = '🔄 同期';
    document.body.appendChild(el);
  }
  el.style.opacity = '1';
  if (rtIndicatorTimer) clearTimeout(rtIndicatorTimer);
  rtIndicatorTimer = setTimeout(() => { el.style.opacity = '0'; }, 1500);
}

// === Toast ===
function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => t.className = 'toast', 2000);
}

// === Multi-select dropdown helper (スプレッドシート風フィルター) ===
// opts = { label, options: [string]|[{value,label}], selected: Set, onChange, placement? }
// returns { buttonElement, updateLabel, openPopup, closePopup, setOptions }
function createMultiSelectDropdown(opts) {
  const label = opts.label || '';
  let options = (opts.options || []).map(o => typeof o === 'string' ? { value: o, label: o } : o);
  const selected = opts.selected instanceof Set ? opts.selected : new Set(opts.selected || []);
  opts.selected = selected;
  const onChange = opts.onChange || (() => {});

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'form-select multi-select-btn';
  btn.style.cssText = 'font-size:12px;padding:5px 22px 5px 8px;width:auto;text-align:left;cursor:pointer;background:#fff;border:1px solid var(--border);border-radius:4px;white-space:nowrap;position:relative;min-height:28px;line-height:1.3';

  const caret = document.createElement('span');
  caret.textContent = '▾';
  caret.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:10px;color:#666;pointer-events:none';
  btn.appendChild(caret);

  const textSpan = document.createElement('span');
  textSpan.className = 'multi-select-text';
  btn.insertBefore(textSpan, caret);

  function updateLabel() {
    let txt;
    const n = selected.size;
    if (n === 0) {
      txt = `${label}: 全て`;
      btn.style.background = '#fff';
      btn.style.color = '';
      btn.style.borderColor = 'var(--border)';
      btn.style.fontWeight = '';
    } else if (n === 1) {
      const v = [...selected][0];
      const found = options.find(o => o.value === v);
      txt = `${label}: ${found ? found.label : v}`;
      btn.style.background = '#1d4ed8';
      btn.style.color = '#fff';
      btn.style.borderColor = '#1d4ed8';
      btn.style.fontWeight = '700';
    } else {
      txt = `${label}: ${n}件選択中`;
      btn.style.background = '#1d4ed8';
      btn.style.color = '#fff';
      btn.style.borderColor = '#1d4ed8';
      btn.style.fontWeight = '700';
    }
    textSpan.textContent = txt;
    caret.style.color = n > 0 ? '#fff' : '#666';
  }

  let popup = null;
  function closePopup() {
    if (popup) {
      popup.remove();
      popup = null;
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
    }
  }
  function onDocClick(e) {
    if (popup && !popup.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closePopup();
  }
  function onKey(e) {
    if (e.key === 'Escape') closePopup();
  }

  function renderPopup(items) {
    const list = popup.querySelector('.mspopup-list');
    list.innerHTML = '';
    items.forEach(o => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:12px;cursor:pointer;white-space:nowrap;user-select:none';
      row.onmouseenter = () => row.style.background = '#f3f4f6';
      row.onmouseleave = () => row.style.background = '';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(o.value);
      cb.style.margin = '0';
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(o.value); else selected.delete(o.value);
        updateLabel();
        onChange();
      });
      const span = document.createElement('span');
      span.textContent = o.label;
      row.appendChild(cb);
      row.appendChild(span);
      list.appendChild(row);
    });
  }

  function openPopup() {
    if (popup) { closePopup(); return; }
    popup = document.createElement('div');
    popup.className = 'multi-select-popup';
    popup.style.cssText = 'position:absolute;z-index:10000;background:#fff;border:1px solid #cbd5e1;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.15);min-width:180px;max-width:280px;padding:6px 0;font-size:12px';
    popup.innerHTML = `
      <div style="padding:4px 8px">
        <input type="text" class="mspopup-search" placeholder="🔍 検索" style="width:100%;box-sizing:border-box;padding:4px 6px;font-size:12px;border:1px solid #d1d5db;border-radius:4px">
      </div>
      <div style="display:flex;gap:4px;padding:2px 8px 4px">
        <button type="button" class="mspopup-all" style="flex:1;padding:3px 6px;font-size:11px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:4px;cursor:pointer">全選択</button>
        <button type="button" class="mspopup-none" style="flex:1;padding:3px 6px;font-size:11px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:4px;cursor:pointer">全解除</button>
      </div>
      <div style="border-top:1px solid #e5e7eb;margin:2px 0"></div>
      <div class="mspopup-list" style="max-height:320px;overflow-y:auto"></div>
    `;
    document.body.appendChild(popup);
    // 位置調整
    const r = btn.getBoundingClientRect();
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    const scrollX = window.scrollX || document.documentElement.scrollLeft;
    popup.style.top = (r.bottom + scrollY + 2) + 'px';
    let left = r.left + scrollX;
    // 画面内に収める
    const pw = popup.offsetWidth;
    const vw = window.innerWidth;
    if (left + pw > vw - 8) left = Math.max(8, vw - pw - 8);
    popup.style.left = left + 'px';

    renderPopup(options);

    const search = popup.querySelector('.mspopup-search');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      const filt = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
      renderPopup(filt);
    });
    popup.querySelector('.mspopup-all').addEventListener('click', () => {
      const q = search.value.trim().toLowerCase();
      const filt = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
      filt.forEach(o => selected.add(o.value));
      renderPopup(filt);
      updateLabel();
      onChange();
    });
    popup.querySelector('.mspopup-none').addEventListener('click', () => {
      const q = search.value.trim().toLowerCase();
      const filt = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
      filt.forEach(o => selected.delete(o.value));
      renderPopup(filt);
      updateLabel();
      onChange();
    });

    setTimeout(() => {
      document.addEventListener('mousedown', onDocClick, true);
      document.addEventListener('keydown', onKey, true);
      search.focus();
    }, 0);
  }

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPopup();
  });

  function setOptions(newOptions) {
    options = (newOptions || []).map(o => typeof o === 'string' ? { value: o, label: o } : o);
    // selected から存在しない値を削除しない (初期化時に意図的セット可)
    updateLabel();
    if (popup) {
      const search = popup.querySelector('.mspopup-search');
      const q = search ? search.value.trim().toLowerCase() : '';
      const filt = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
      renderPopup(filt);
    }
  }

  updateLabel();
  return { buttonElement: btn, updateLabel, openPopup, closePopup, setOptions, selected };
}

// === Facility Name Normalizer ===
function normFac(f) {
  if (!f) return '-';
  if (f.includes('銀座')) return 'BF銀座';
  // 小牧を先にチェック（ワイズ歯科矯正歯科＋KIDS イオン小牧店）
  if (f.includes('小牧') || f.includes('KIDS') || f.includes('イオン')) return '小牧';
  // ウィズ（名古屋ウィズ歯科・矯正歯科 / WITH DENTAL CLINIC）
  if (f.includes('ウィズ') || f.includes('WITH') || f.includes('ウイズ')) return 'ウィズ';
  // ワイズ = 小牧（ワイズ歯科矯正歯科）
  if (f.includes('ワイズ')) return '小牧';
  if (f.includes('エスカ')) return 'エスカ';
  if (f.includes('アール') || f.includes('名駅アール')) return 'アール';
  if (f.includes('ルミナス')) return 'ルミナス';
  if (f.includes('茶屋')) return '茶屋';
  if (f.includes('知立') || f.includes('アピタ')) return '知立';
  if (f.includes('八事') || f.includes('やごと')) return '八事';
  if (f.includes('岩田')) return '岩田';
  if (f.includes('大森')) return '大森';
  if (f.includes('京都') || f.includes('河原町')) return '京都';
  return f.length > 8 ? f.slice(0,8)+'…' : f;
}
function normSvc(s) {
  if (!s) return '-';
  if (s.includes('ラミネート')||s.includes('ブラックフィルム')) return 'BF';
  if (s.includes('矯正')) return '矯正';
  if (s.includes('セラミック')) return 'セラミック';
  if (s.includes('インプラント')) return 'インプラント';
  return s.replace(/相談|無料|　/g,'').slice(0,6);
}

// === Global Date Formatters ===
function fmtApplyDate(d) {
  if (!d) return '-';
  const m = d.match(/\d{4}\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return parseInt(m[1]) + '/' + parseInt(m[2]);
  return d.slice(0, 5);
}
function fmtBookDate(d) {
  if (!d) return '-';
  const m1 = d.match(/\d{4}\D+(\d{1,2})\D+(\d{1,2})\s+(\d{1,2}:\d{2})/);
  if (m1) return parseInt(m1[1]) + '/' + parseInt(m1[2]) + ' ' + m1[3];
  const m2 = d.match(/(\d{1,2})\D+(\d{1,2})\s+(\d{1,2}:\d{2})/);
  if (m2) return parseInt(m2[1]) + '/' + parseInt(m2[2]) + ' ' + m2[3];
  const m3 = d.match(/(\d{1,2})\D*月\D*(\d{1,2})\D*日.*?(\d{1,2})\D*時\D*(\d{2})\D*分/);
  if (m3) return parseInt(m3[1]) + '/' + parseInt(m3[2]) + ' ' + m3[3] + ':' + m3[4];
  const m4 = d.match(/(\d{1,2})\D*月\D*(\d{1,2})/);
  if (m4) return parseInt(m4[1]) + '/' + parseInt(m4[2]);
  const m5 = d.match(/(\d{1,2})[\/](\d{1,2})/);
  if (m5) return parseInt(m5[1]) + '/' + parseInt(m5[2]);
  return d.slice(0, 8);
}

// === Unified Date Parser ===
function parseDate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  return new Date(parseInt(m[1]), parseInt(m[2])-1, parseInt(m[3]));
}
// v273: 短縮形式 "M/D" にも対応する parseDate (parseDate より緩い判定)
function parseDateLoose(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr);
  let m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2])-1, parseInt(m[3]));
  m = s.match(/^\s*(\d{1,2})\D+(\d{1,2})/);
  if (m) {
    const mo = parseInt(m[1])-1, da = parseInt(m[2]);
    if (mo >= 0 && mo <= 11 && da >= 1 && da <= 31) {
      return new Date(new Date().getFullYear(), mo, da);
    }
  }
  return null;
}
function getYM(d) {
  const src = d.bookDate || d.applyDate;
  if (!src) return '';
  const m = src.match(/(\d{4})\D+(\d{1,2})/);
  return m ? m[1] + '-' + String(parseInt(m[2])).padStart(2,'0') : '';
}
function getApplyYM(d) {
  if (!d.applyDate) return '';
  const m = d.applyDate.match(/(\d{4})\D+(\d{1,2})/);
  return m ? m[1] + '-' + String(parseInt(m[2])).padStart(2,'0') : '';
}
function getApplyDateStr(d) {
  if (!d.applyDate) return '';
  const m = d.applyDate.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${m[1]}-${String(parseInt(m[2])).padStart(2,'0')}-${String(parseInt(m[3])).padStart(2,'0')}` : '';
}

// === Config ===
// マスターPW/プロモPWはDB移行済 (accounts.account_type) - ハードコード削除済
const PROMO_PASSWORDS = {}; // 互換用の空オブジェクト (古いコードが参照しないよう)
let userRole = 'admin'; // 'admin' or 'promo' (旧互換)
let promoFilter = ''; // プロモ別ログイン時のフィルター

// Phase 6: 新ロールシステム (admin / staff_promo / agency)
// userRole は旧 UI ロジックが多数参照するためそのまま残し、
// currentRole は新しい権限判定専用。ログイン時に accounts.role から取得。
let currentRole = null;
let currentAllowedPromos = [];
// Phase 8: タブ別閲覧権限 (admin は無視、それ以外は DB の visible_tabs に従う)
let currentVisibleTabs = null;
const DEFAULT_VISIBLE_TABS = { bookings: true, kaiin: false, tc: false, sales: false, adbudget: false, admin: false };
const FACILITIES = ['全体','エスカ','アール','ウィズ','ルミナス','茶屋','アサノ','知立','小牧','八事','岩田','大森','京都','銀座','訪問'];

// === State ===
let clinics = [];
let currentView = 'bookings';
let currentSubView = {};
let salesFacility = '全体';
let salesYear = '2025';
let patientsFacility = '全体';
let reviewsFacility = '全体';

// === Storage helpers ===
function loadData(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } }
function saveData(key, data) { localStorage.setItem(key, JSON.stringify(data)); }

// === Init ===
document.addEventListener('DOMContentLoaded', () => {
  // URL ?view=tc で TC専用ログイン
  const params = new URLSearchParams(location.search);
  // 録音専用画面
  if (params.get('view') === 'rec') {
    initStandaloneRecorder();
    return;
  }
  // パートナー専用ログイン画面 (?view=partner)
  if (params.get('view') === 'partner') {
    initPartnerLogin();
    return;
  }
  // パラ管理 外注用ログイン (?view=para)
  if (params.get('view') === 'para') {
    initParaExternal();
    return;
  }
  if (params.get('view') === 'tc') {
    const proceed = () => {
      sessionStorage.setItem('authenticated', 'true');
      sessionStorage.setItem('role', 'tc');
      userRole = 'tc';
      promoFilter = '';
      setupEventListeners();
      showApp();
    };
    if (sessionStorage.getItem('tcPassed') === 'true') { proceed(); return; }
    // 数字パスワードゲート (5858)
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;font-family:inherit';
    ov.innerHTML = `
      <div style="font-size:13px;font-weight:700;letter-spacing:2px;color:#111">SEISHOKAI / TC</div>
      <div style="font-size:11px;color:#999;letter-spacing:1.5px;text-transform:uppercase">Enter Passcode</div>
      <input id="tc-pass-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off"
        style="width:160px;text-align:center;font-size:28px;letter-spacing:12px;padding:12px;border:2px solid #111;border-radius:8px;outline:none;font-family:inherit">
      <div id="tc-pass-err" style="font-size:11px;color:#c00;min-height:14px"></div>
      <button id="tc-pass-btn" style="border:2px solid #111;background:#111;color:#fff;padding:8px 28px;font-size:13px;font-weight:700;border-radius:6px;cursor:pointer;font-family:inherit">OK</button>
    `;
    document.body.appendChild(ov);
    const input = ov.querySelector('#tc-pass-input');
    const err = ov.querySelector('#tc-pass-err');
    const btn = ov.querySelector('#tc-pass-btn');
    input.focus();
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, ''); err.textContent = ''; });
    const submit = () => {
      if (input.value === '5858') {
        sessionStorage.setItem('tcPassed', 'true');
        ov.remove();
        proceed();
      } else {
        err.textContent = 'パスコードが違います';
        input.value = '';
        input.focus();
      }
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    return;
  }
  // ?login / ?staff 系 URL なら、ページ表示前にセッションを完全クリア (自動ログイン防止)
  const _isRestrictedUrl = (() => {
    try {
      const p = new URLSearchParams(location.search);
      return p.has('login') || p.has('staff') || p.has('agency') || p.get('view') === 'login';
    } catch(_) { return false; }
  })();
  if (_isRestrictedUrl) {
    try {
      Object.keys(sessionStorage).forEach(k => sessionStorage.removeItem(k));
      Object.keys(localStorage).forEach(k => {
        if (k.includes('supabase') || k.startsWith('sb-')) localStorage.removeItem(k);
      });
    } catch(_) {}
    try { if (sb && sb.auth) sb.auth.signOut().catch(()=>{}); } catch(_){}
  }

  // v267 セッションタイムアウト: 期限切れなら自動ログインを阻止
  if (_isSessionExpired()) {
    try {
      Object.keys(sessionStorage).forEach(k => sessionStorage.removeItem(k));
      Object.keys(localStorage).forEach(k => {
        if (k.includes('supabase') || k.startsWith('sb-')) localStorage.removeItem(k);
      });
      localStorage.removeItem(ACTIVITY_KEY);
    } catch(_) {}
    try { if (sb && sb.auth) sb.auth.signOut().catch(()=>{}); } catch(_){}
  }

  // Supabase Auth セッション復元 (Phase 6: 一本化済み)
  // 既存認証済みなら UI は下の同期ブロックで即時復元し、Supabase 側は裏で同期のみ
  // 未認証なら Supabase セッションから復元 → あれば showApp へ
  (async () => {
    if (sessionStorage.getItem('authenticated') === 'true') {
      restoreSupabaseAuthIfAny().catch(() => {});
    } else {
      const restored = await restoreSupabaseAuthIfAny();
      if (restored) {
        setupEventListeners();
        showApp();
      }
    }
  })();
  if (sessionStorage.getItem('authenticated') === 'true' && !_isRestrictedUrl) {
    userRole = sessionStorage.getItem('role') || 'admin';
    promoFilter = sessionStorage.getItem('promoFilter') || '';
    currentRole = sessionStorage.getItem('currentRole') || (userRole === 'admin' ? 'admin' : 'agency');
    try { currentAllowedPromos = JSON.parse(sessionStorage.getItem('currentAllowedPromos') || '[]'); } catch(_) { currentAllowedPromos = []; }
    try { window.currentCanViewPII = sessionStorage.getItem('currentCanViewPII') === '1'; } catch(_) { window.currentCanViewPII = false; }
    try { currentVisibleTabs = JSON.parse(sessionStorage.getItem('currentVisibleTabs') || 'null'); } catch(_) { currentVisibleTabs = null; }
    showApp();
  }
  setupEventListeners();
});

// === v267 セッションタイムアウト (TODO #19) ===
// 30分間無操作で自動ログアウト。再訪時もタイムスタンプが古ければ自動ログインを阻止。
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const ACTIVITY_KEY = 'last-activity';
let _sessionTimeoutInterval = null;
let _lastActivityWrite = 0;

function _markActivity() {
  const now = Date.now();
  // 5秒スロットル: localStorage 書き込みを抑制
  if (now - _lastActivityWrite < 5000) return;
  _lastActivityWrite = now;
  try { localStorage.setItem(ACTIVITY_KEY, String(now)); } catch(_){}
}

function _isSessionExpired() {
  try {
    const last = parseInt(localStorage.getItem(ACTIVITY_KEY) || '0', 10);
    if (!last) {
      // last-activity 未設定:
      //   - 完全新規 (Supabase token も無い) → false (ログイン画面を出す)
      //   - 移行ケース (token だけ残ってる) → true (強制再ログイン)
      const hasSupabaseToken = Object.keys(localStorage).some(k =>
        k.includes('supabase') || k.startsWith('sb-')
      );
      return hasSupabaseToken;
    }
    return (Date.now() - last) > SESSION_TIMEOUT_MS;
  } catch(_) { return false; }
}

function _onUserActivity() { _markActivity(); }

function setupSessionTimeout() {
  // 認証成功直後に 1 回呼ぶ。重複登録を防ぐ
  _clearSessionTimeout();
  _lastActivityWrite = 0;
  _markActivity();
  ['mousemove','keydown','touchstart','click','scroll'].forEach(evt =>
    document.addEventListener(evt, _onUserActivity, { passive: true })
  );
  _sessionTimeoutInterval = setInterval(() => {
    if (_isSessionExpired()) {
      _clearSessionTimeout();
      console.warn('Session timed out (30min idle)');
      logout().then(() => {
        try { alert('30分間操作がなかったため、自動的にログアウトしました。再度ログインしてください。'); } catch(_){}
      });
    }
  }, 30 * 1000);
}

function _clearSessionTimeout() {
  if (_sessionTimeoutInterval) {
    clearInterval(_sessionTimeoutInterval);
    _sessionTimeoutInterval = null;
  }
  ['mousemove','keydown','touchstart','click','scroll'].forEach(evt =>
    document.removeEventListener(evt, _onUserActivity)
  );
}

// === Auth ===
async function logout() {
  // Supabase Auth signOut (authMode に関わらず実行: クッキー/トークンの取り残し防止)
  try { if (sb && sb.auth) await sb.auth.signOut(); } catch (_) { /* ignore */ }
  // setInterval リーク対策
  if (_qInterval) { clearInterval(_qInterval); _qInterval = null; }
  // v267 セッションタイムアウト解除
  _clearSessionTimeout();
  try { localStorage.removeItem(ACTIVITY_KEY); } catch(_){}
  sessionStorage.clear();
  userRole = 'admin';
  promoFilter = '';
  currentRole = null;
  currentAllowedPromos = [];
  currentVisibleTabs = null;
  document.getElementById('app').hidden = true;
  document.getElementById('login-screen').hidden = false;
  document.getElementById('login-screen').style.display = '';
  // v265 ログイン画面表示中はプルリフレッシュインジケーター完全非表示 (CSS :has() フォールバック)
  const _pri = document.getElementById('pull-refresh-indicator');
  if (_pri) { _pri.classList.remove('show', 'loading'); _pri.style.transform = ''; _pri.style.display = 'none'; }
  const em = document.getElementById('login-email'); if (em) em.value = '';
  document.getElementById('password').value = '';
  document.getElementById('login-error').hidden = true;
  // ナビ・ヘッダーリセット
  document.querySelectorAll('.desktop-nav .nav-btn').forEach(b => b.style.display = '');
  document.querySelectorAll('.bottom-nav-btn').forEach(b => b.style.display = '');
  const hdr = document.querySelector('.header');
  hdr.classList.remove('role-promo', 'role-custom');
  const userBadge = hdr.querySelector('.header-user');
  if (userBadge) userBadge.remove();
}

// === Phase 6: ロール別権限ヘルパー ===
// currentRole は accounts.role ('admin' | 'staff_promo' | 'agency') を格納。
// 既存の userRole ('admin' | 'promo' | 'sales' | 'tc' | 'custom') とは別軸で
// 「新しい10名体制」の権限チェックに使う。
function isAdminRole()       { return currentRole === 'admin'; }
function isStaffPromoRole()  { return currentRole === 'staff_promo'; }
function isAgencyRole()      { return currentRole === 'agency'; }
function canEditContent()    { return currentRole === 'admin' || currentRole === 'staff_promo'; }
function canEditAmount()     { return currentRole === 'admin'; }
function canDeleteRecord()   { return currentRole === 'admin'; }

// 権限フィルタ: プロモ source が現在のユーザーに見えるか判定
// admin: 全部OK / staff_promo & agency: allowed_promos 配列とマッチ
// 旧 promo (account_type='promo') は promoFilter を単体比較
function _matchesAllowedPromo(source) {
  if (currentRole === 'admin') return true;
  if (!source) return true; // 流入元未設定は全員表示 (運用上共有が必要なため)
  // 新方式: currentAllowedPromos 配列
  if (Array.isArray(currentAllowedPromos) && currentAllowedPromos.length) {
    // ワイルドカード '%' = 全許可
    if (currentAllowedPromos.includes('%')) return true;
    // prefix_% パターン (例: hikaru_%) と完全一致を両対応
    const s = String(source).trim().toLowerCase();
    return currentAllowedPromos.some(p => {
      if (!p) return false;
      const pat = String(p).trim().toLowerCase();
      if (pat === '%' ) return true;
      if (pat.endsWith('_%')) {
        return s.startsWith(pat.slice(0, -1)); // "hikaru_" で始まるか
      }
      return s === pat;
    });
  }
  // 旧方式フォールバック
  if (userRole === 'promo' && promoFilter) {
    return String(source).trim() === String(promoFilter).trim();
  }
  return true;
}
// 個人情報マスク (staff_promo/agency 向け)
// 名前: 先頭2文字 + ※※...
// 電話/メール: 全て ※
function _isPII_MaskNeeded() {
  if (currentRole === 'admin') return false;
  // can_view_pii フラグで個別許可 (電話追跡担当など)
  if (window.currentCanViewPII === true) return false;
  return true;
}
function maskName(name) {
  if (!name) return name;
  if (!_isPII_MaskNeeded()) return name;
  const s = String(name);
  if (s.length <= 2) return s; // 2文字以下はそのまま
  const keep = s.slice(0, 2);
  const rest = Math.max(1, s.length - 2);
  return keep + '※'.repeat(rest);
}
function maskPhone(phone) {
  if (!phone) return phone;
  if (!_isPII_MaskNeeded()) return phone;
  return '※※※※※※※※';
}
function maskEmail(email) {
  if (!email) return email;
  if (!_isPII_MaskNeeded()) return email;
  return '※※※※※※※※';
}

// メモを1行化して正規化 (改行→空白・連続空白→1個・前後トリム)
function _flattenMemoForDisplay(s, maxLen) {
  if (!s) return '';
  const flat = String(s).replace(/\r\n/g, ' ').replace(/[\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!maxLen || flat.length <= maxLen) return flat;
  return flat.slice(0, maxLen) + '…';
}

// 共通: 現在のユーザーに見えるbookingsデータだけを返す
function getFilteredBookingsData() {
  if (!_hasPromoRestriction()) return bookingsData;
  return (bookingsData || []).filter(d => _matchesAllowedPromo(d.source));
}
function _hasPromoRestriction() {
  if (currentRole === 'admin') return false;
  if (Array.isArray(currentAllowedPromos) && currentAllowedPromos.length) {
    return !currentAllowedPromos.includes('%');
  }
  return userRole === 'promo' && !!promoFilter;
}

// ログイン時/セッション復元時にサーバから最新権限を取得
async function loadCurrentUserPermissions() {
  try {
    const { data, error } = await sb.rpc('get_my_account');
    if (error || !data) return false;
    currentRole = data.role || data.account_type || 'agency';
    currentAllowedPromos = Array.isArray(data.allowed_promos) ? data.allowed_promos : [];
    currentVisibleTabs = (data.visible_tabs && typeof data.visible_tabs === 'object') ? data.visible_tabs : null;
    sessionStorage.setItem('currentRole', currentRole);
    sessionStorage.setItem('currentAllowedPromos', JSON.stringify(currentAllowedPromos));
    sessionStorage.setItem('currentVisibleTabs', JSON.stringify(currentVisibleTabs));
    return true;
  } catch (e) {
    console.warn('loadCurrentUserPermissions failed', e);
    return false;
  }
}

// ロールに応じてナビゲーション/編集 UI を制御
// Phase 8: admin 以外は DB の accounts.visible_tabs に従ってタブを表示/非表示
function applyRoleUI() {
  const admin = isAdminRole();
  // 新 UI ガード: body に data 属性を付けて CSS 側で制御可能にする
  document.body.dataset.role = currentRole || '';
  // すべてのナビを一度リセット (以前 hide されたままにならないよう必ず display='' を先に設定)
  document.querySelectorAll('.desktop-nav .nav-btn, .bottom-nav-btn').forEach(b => {
    b.style.display = '';
  });
  // admin は visible_tabs を無視して全タブ表示 (絶対条件)
  if (admin) return;

  // visible_tabs が取れていない場合はロール既定にフォールバック (既存互換)
  const vt = (currentVisibleTabs && typeof currentVisibleTabs === 'object')
    ? currentVisibleTabs
    : (isAgencyRole()
        ? { bookings: true, kaiin: false, tc: false, sales: false, adbudget: false, admin: false }
        : { bookings: true, kaiin: true,  tc: false, sales: false, adbudget: false, admin: false });

  document.querySelectorAll('.desktop-nav .nav-btn, .bottom-nav-btn').forEach(b => {
    const v = b.dataset.view;
    if (!v) return;
    // visible_tabs に明示的に false がある場合は確実に非表示
    if (vt[v] === false) { b.style.display = 'none'; return; }
    // true でも false でもないキー (未定義) は、危険タブを安全側で非表示
    if (vt[v] !== true && ['tc','sales','adbudget','admin'].includes(v)) {
      b.style.display = 'none';
    }
  });
}
// === Supabase Auth ログイン (Phase 6: 一本化済み) ===
// (並走期間は終了し旧ログインは撤去済み。migrations/auth_phase1.sql 参照)
function _applyAccountProfileToSession(profile) {
  sessionStorage.setItem('authenticated', 'true');
  // Phase 6: 新ロール (admin / staff_promo / agency)
  currentRole = profile.role || profile.account_type || 'agency';
  currentAllowedPromos = Array.isArray(profile.allowed_promos) ? profile.allowed_promos : [];
  currentVisibleTabs = (profile.visible_tabs && typeof profile.visible_tabs === 'object') ? profile.visible_tabs : null;
  sessionStorage.setItem('currentRole', currentRole);
  sessionStorage.setItem('currentAllowedPromos', JSON.stringify(currentAllowedPromos));
  sessionStorage.setItem('currentVisibleTabs', JSON.stringify(currentVisibleTabs));
  // PII閲覧許可フラグ (電話追跡担当など)
  window.currentCanViewPII = (profile.can_view_pii === true);
  sessionStorage.setItem('currentCanViewPII', window.currentCanViewPII ? '1' : '0');
  const type = profile.account_type || 'custom';
  sessionStorage.setItem('role', type);
  sessionStorage.setItem('authMode', 'supabase'); // 識別用 (旧ログインと区別)
  if (type === 'promo') {
    const pf = (profile.promos && profile.promos[0]) || '';
    sessionStorage.setItem('promoFilter', pf);
    userRole = 'promo'; promoFilter = pf;
  } else if (type === 'admin' || type === 'sales' || type === 'tc') {
    userRole = type; promoFilter = '';
  } else {
    // custom
    sessionStorage.setItem('customPerms', JSON.stringify(profile.permissions || []));
    sessionStorage.setItem('customPromos', JSON.stringify(profile.promos || []));
    sessionStorage.setItem('customServices', JSON.stringify(profile.services || []));
    sessionStorage.setItem('customFacilities', JSON.stringify(profile.facilities || []));
    sessionStorage.setItem('customEditRole', profile.role || 'view');
    sessionStorage.setItem('customAgency', profile.agency || '');
    sessionStorage.setItem('customName', profile.name || '');
    userRole = 'custom';
  }
}

async function attemptLoginViaSupabaseAuth(email, password) {
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message || 'ログインに失敗しました' };
    const { data: profile, error: pErr } = await sb.rpc('get_my_account');
    if (pErr || !profile) {
      try { await sb.auth.signOut(); } catch(_) {}
      return { ok: false, error: 'プロファイルが見つかりません (accounts 未リンク)' };
    }
    _applyAccountProfileToSession(profile);
    try { sb.rpc('log_auth_event', { event_name: 'login_success', detail_json: { method: 'supabase_auth', account_id: profile.id } }).then(()=>{}).catch(()=>{}); } catch(_){}
    return { ok: true, profile };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '予期せぬエラー' };
  }
}

// ?login / ?staff / ?agency URL 経由では admin ログインを禁止
function _isRestrictedLoginUrl() {
  try {
    const p = new URLSearchParams(location.search);
    return p.has('login') || p.has('staff') || p.has('agency') || p.get('view') === 'login';
  } catch (_) { return false; }
}

async function restoreSupabaseAuthIfAny() {
  try {
    if (!sb || !sb.auth) return false;
    // ?login / ?staff / ?agency URL では常にログイン画面を表示 (自動ログインしない)
    // キャッシュに残っているセッションは明示的にサインアウトして完全クリア
    if (_isRestrictedLoginUrl()) {
      try { await sb.auth.signOut(); } catch(_){}
      try {
        Object.keys(sessionStorage).forEach(k => sessionStorage.removeItem(k));
        Object.keys(localStorage).forEach(k => {
          if (k.includes('supabase') || k.startsWith('sb-')) localStorage.removeItem(k);
        });
      } catch(_){}
      return false;
    }
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return false;
    const { data: profile, error } = await sb.rpc('get_my_account');
    if (error || !profile) return false;
    _applyAccountProfileToSession(profile);
    return true;
  } catch (e) {
    console.warn('restoreSupabaseAuthIfAny failed', e);
    return false;
  }
}

function setupEventListeners() {
  async function attemptLogin() {
    const emailEl = document.getElementById('login-email');
    const email = emailEl ? emailEl.value.trim() : '';
    const pw = document.getElementById('password').value;
    const errEl = document.getElementById('login-error');
    const loginBtn = document.getElementById('login-btn');
    if (!email || !pw) {
      if (errEl) { errEl.textContent = 'メールとパスワードを入力してください'; errEl.hidden = false; }
      return;
    }
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    loginBtn.textContent = 'ログイン中...';
    loginBtn.disabled = true;

    try {
      const res = await attemptLoginViaSupabaseAuth(email, pw);
      if (!res.ok) {
        if (errEl) { errEl.textContent = res.error || 'ログインに失敗しました'; errEl.hidden = false; }
        try { sb.rpc('log_auth_event', { event_name: 'login_failed', detail_json: { method: 'email' } }).then(()=>{}).catch(()=>{}); } catch(_){}
        loginBtn.disabled = false;
        loginBtn.textContent = 'ログイン';
        return;
      }
      // ?login URL で admin ログインを拒否
      if (_isRestrictedLoginUrl() && currentRole === 'admin') {
        try { await sb.auth.signOut(); } catch(_){}
        try { Object.keys(sessionStorage).forEach(k => sessionStorage.removeItem(k)); } catch(_){}
        if (errEl) { errEl.textContent = '管理者はこのURLからログインできません。通常のトップページをご利用ください。'; errEl.hidden = false; }
        loginBtn.disabled = false;
        loginBtn.textContent = 'ログイン';
        return;
      }
      sessionStorage.setItem('authenticated', 'true');
      // v271: 外部ページからの遷移なら main アプリを描画せず即リダイレクト (フラッシュ防止)
      try {
        const afterLoginUrl = sessionStorage.getItem('after-login-url');
        if (afterLoginUrl && /^\/[\w\-/]/.test(afterLoginUrl) && !afterLoginUrl.startsWith('//')) {
          sessionStorage.removeItem('after-login-url');
          location.href = afterLoginUrl;
          return;
        }
      } catch(_){}
      showApp();
    } catch (e) {
      if (errEl) { errEl.textContent = (e && e.message) || 'ログインに失敗しました'; errEl.hidden = false; }
      loginBtn.disabled = false;
      loginBtn.textContent = 'ログイン';
    } finally {
      document.getElementById('password').value = '';
    }
  }
  document.getElementById('login-btn').addEventListener('click', attemptLogin);
  document.getElementById('password').addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });
  document.getElementById('login-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('password')?.focus(); });
  // #20 パスワード表示トグル (input.type を切替: Firefox/Android 対応)
  document.getElementById('pw-toggle').addEventListener('change', e => {
    const pw = document.getElementById('password');
    if (pw) pw.type = e.target.checked ? 'text' : 'password';
  });
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('logout-btn-mobile').addEventListener('click', logout);

  // 🔄 データ更新ボタン
  document.getElementById('refresh-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '⏳ 更新中...';
    try {
      // 並列で全データ再取得
      await Promise.all([
        typeof loadBookings === 'function' ? loadBookings() : null,
        typeof loadBFLifecycleData === 'function' ? loadBFLifecycleData() : null,
        typeof loadPromoRates === 'function' ? loadPromoRates() : null,
      ].filter(Boolean));
      // リアルタイムチャンネルも再接続
      try { setupRealtime(); } catch(_){}
      // 保存キューがあれば即処理
      try { processQueue(true); } catch(_){}
      // 現在表示中のビューを再描画
      if (currentView === 'bookings') {
        if (typeof renderBookings === 'function') renderBookings();
        const lc = document.getElementById('bf-lifecycle');
        if (lc && !lc.hidden && typeof updateBFFunnelAndTable === 'function') updateBFFunnelAndTable(getBFRows());
      } else if (currentView === 'tc') {
        if (typeof renderRecordings === 'function') renderRecordings();
        if (typeof loadClinics === 'function') loadClinics();
      } else if (currentView === 'sales' && typeof renderSales === 'function') {
        renderSales();
      } else if (currentView === 'admin') {
        if (typeof renderAccounts === 'function') renderAccounts();
        if (typeof renderPromoRates === 'function') renderPromoRates();
      } else if (currentView === 'adbudget' && typeof renderAdBudgets === 'function') {
        renderAdBudgets();
      }
      btn.textContent = '✓ 最新';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
    } catch(e) {
      console.error(e);
      btn.textContent = '⚠ エラー';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    }
  });

  // Main nav
  document.querySelectorAll('.desktop-nav .nav-btn').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  document.querySelectorAll('.bottom-nav-btn').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

  // Sub nav
  document.querySelectorAll('.sub-nav-btn:not(.bf-sub-btn)').forEach(b => {
    b.addEventListener('click', () => {
      const parent = b.closest('.sub-nav');
      parent.querySelectorAll('.sub-nav-btn').forEach(s => s.classList.remove('active'));
      b.classList.add('active');
      const sub = b.dataset.sub;
      const view = b.closest('.view') || b.closest('main');
      // Find the parent main view
      let mainView = parent.nextElementSibling;
      let el = parent;
      while (el && el.tagName !== 'MAIN') el = el.parentElement;
      if (el) {
        el.querySelectorAll('[id^="sub-"]').forEach(s => s.hidden = s.id !== `sub-${sub}`);
        // ビュー単位のサブタブ位置を記憶
        try { sessionStorage.setItem('lastSub:' + el.id, sub); } catch(_){}
      }
      // タブ切替時にデータ更新
      if (sub === 'bk-home') {
        if (typeof renderHomeDashboard === 'function') renderHomeDashboard();
      }
      if (sub === 'bk-phone') {
        if (typeof renderPhoneCheck === 'function') renderPhoneCheck();
      }
      if (sub === 'bk-search' && bookingsData.length > 0) {
        const psFac = document.getElementById('ps-facility');
        if (psFac && psFac.options.length <= 1) {
          const facs = [...new Set(getFilteredBookingsData().map(d => normFac(d.facility)).filter(f => f && f !== '-'))].sort();
          psFac.innerHTML = '<option value="">全て</option>' + facs.map(f => `<option>${f}</option>`).join('');
        }
      }
      if (sub === 'bk-analysis' && bookingsData.length > 0) renderAnalysis();
      if (sub === 'bk-apply' && bookingsData.length > 0) renderApplyAnalysis('today');
      if (sub === 'bk-bf') {
        if (!bfUnlocked) { unlockBF(); } else { renderBF('all'); }
        // デフォルトで「セット進捗」を表示
        setTimeout(() => {
          document.querySelectorAll('.bf-sub-btn').forEach(b => { b.style.borderBottomColor = 'transparent'; b.style.color = 'var(--text-sub)'; b.style.fontWeight = '400'; });
          const lcBtn = document.querySelector('.bf-sub-btn[data-bfsub="bf-lifecycle"]');
          if (lcBtn) { lcBtn.style.borderBottomColor = 'var(--accent)'; lcBtn.style.color = 'var(--text)'; lcBtn.style.fontWeight = '600'; }
          ['bf-progress','bf-patients','bf-contracts','bf-bookings','bf-lifecycle'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.hidden = id !== 'bf-lifecycle';
          });
          if (typeof renderBFLifecycle === 'function') renderBFLifecycle();
        }, 50);
      }
      if (sub === 'bk-fac') { const facBtn = document.querySelector('.bk-fac-tab.active'); if (facBtn) renderFacTab(facBtn.dataset.fac); }
      if (sub === 'recordings') renderRecordings();
      if (sub === 'adm-history') { renderChangeLog(); renderBackupsList(); }
      if (sub === 'para-manage') { if (typeof renderPara === 'function') renderPara(); }
      if (sub === 'adm-auth-migration') { if (typeof renderAuthMigration === 'function') renderAuthMigration(); }
      // 来院タブのサブ
      if (sub && sub.startsWith('kaiin-')) {
        if (sub === 'kaiin-all') {
          if (typeof renderKaiinAll === 'function') renderKaiinAll('kaiin-all-content');
        } else {
          const map = {'kaiin-bf':'BF','kaiin-kyosei':'矯正','kaiin-implant':'インプラント','kaiin-labrie':'ラブリエ','kaiin-hotetsu':'自費補綴','kaiin-konchi':'自費根治','kaiin-whitening':'ホワイトニング','kaiin-lipart':'リップアート','kaiin-jewelry':'ティースジュエリー','kaiin-other':'その他'};
          const t = map[sub];
          if (t) renderKaiinTab(t, sub.replace('kaiin-','kaiin-') + '-content');
        }
      }
    });
  });

  // Modal
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.querySelector('.modal-overlay').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  // #9 Esc で表示中の任意モーダル (.modal:not([hidden])) を全て閉じる
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.modal:not([hidden])').forEach(m => { m.hidden = true; });
    document.body.style.overflow = '';
  });

  // === v264 キーボードショートカット ===
  // Ctrl/Cmd+K: 検索 / Alt+1〜6 (Ctrl+1〜6 はブラウザに奪われる場合あり): タブ切替 / ?: ヘルプ
  setupKeyboardShortcuts();

  // === v264 スワイプアクション (モバイル) ===
  // 左→確認済 / 右→メモ
  setupBookingSwipeActions();

  // Sales
  document.getElementById('sales-save').addEventListener('click', saveSalesEntry);

  // Patients
  document.getElementById('pt-save').addEventListener('click', savePatient);

  // Sales year filter
  document.getElementById('sales-year').addEventListener('change', e => { salesYear = e.target.value; renderSales(); });

  // TC global filters
  const tcYearEl = document.getElementById('tc-year');
  const tcFacEl = document.getElementById('tc-facility');
  // Populate facility dropdown
  FACILITIES.forEach(f => { if (f !== '全体') { const o = document.createElement('option'); o.value = f; o.textContent = f; tcFacEl.appendChild(o); } });
  tcYearEl.addEventListener('change', () => { renderRates(); renderPatients(); });
  tcFacEl.addEventListener('change', () => { renderRates(); renderPatients(); });

  // Reviews
  document.getElementById('rev-save').addEventListener('click', saveReviewEntry);
  document.getElementById('comment-save').addEventListener('click', saveComment);
  document.getElementById('rev-month').value = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

  // Row edit modal save & hide
  document.getElementById('re-save').addEventListener('click', saveRowEdit);
  document.getElementById('re-hide').addEventListener('click', () => {
    if (!_rowEditTarget) return;
    if (!confirm(_rowEditTarget.name + ' を非表示にしますか？\n（統計からも除外されます。データは残ります）')) return;
    document.getElementById('re-status').value = '除外';
    saveRowEdit();
  });

  // Memo modal save
  document.getElementById('memo-modal-save').addEventListener('click', saveMemoModal);

  // Facility tabs
  document.querySelectorAll('.bk-fac-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      // 手動でサブタブ切替
      const mainEl = btn.closest('main');
      if (mainEl) {
        mainEl.querySelectorAll('[id^="sub-"]').forEach(s => s.hidden = s.id !== 'sub-bk-fac');
        mainEl.querySelectorAll('.sub-nav-btn').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
      }
      if (bookingsData.length > 0) renderFacTab(btn.dataset.fac);
    });
  });
  document.getElementById('fac-new-save').addEventListener('click', saveFacNewPatient);
  // 一括貼付けモーダル
  document.getElementById('fac-bulk-btn')?.addEventListener('click', () => {
    document.getElementById('fac-bulk-tab-name').textContent = currentFacTab || '医院';
    document.getElementById('fac-bulk-text').value = '';
    document.getElementById('fac-bulk-result').innerHTML = '';
    document.getElementById('fac-bulk-modal').hidden = false;
  });
  document.getElementById('fac-bulk-preview')?.addEventListener('click', () => runBulkInsert(true));
  document.getElementById('fac-bulk-run')?.addEventListener('click', () => runBulkInsert(false));
  document.getElementById('fac-new-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveFacNewPatient(); });
  // 医院タブフィルター
  ['fac-period','fac-month','fac-status-filter'].forEach(id => { document.getElementById(id)?.addEventListener('change', () => renderFacTab(currentFacTab)); });
  let facSearchTimer;
  document.getElementById('fac-search')?.addEventListener('input', () => { clearTimeout(facSearchTimer); facSearchTimer = setTimeout(() => renderFacTab(currentFacTab), 300); });
  document.getElementById('fac-filter-reset')?.addEventListener('click', () => { ['fac-period','fac-month','fac-status-filter'].forEach(id => { const e=document.getElementById(id); if(e) e.value=''; }); document.getElementById('fac-search').value=''; renderFacTab(currentFacTab); });

  // Mail paste register
  document.getElementById('mail-parse-btn').addEventListener('click', parseMailAndRegister);

  // Patient search & register
  document.getElementById('ps-search-btn').addEventListener('click', searchPatients);
  document.getElementById('ps-clear-btn').addEventListener('click', () => {
    ['ps-name','ps-phone','ps-email'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('ps-facility').value = '';
    document.getElementById('ps-tbody').innerHTML = '';
    document.getElementById('ps-result-count').textContent = '';
  });
  document.getElementById('np-save').addEventListener('click', registerNewPatient);
  // Enter key for search
  ['ps-name','ps-phone','ps-email'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') searchPatients(); });
  });

  // BF booking list filters
  let _bfAllData = [];
  function ensureBFData() {
    if (_bfAllData.length === 0 && bookingsData.length > 0) {
      const bkExtraBF = loadData('bk-extra', {});
      _bfAllData = bookingsData.filter(d => {
        if (d.status === '除外') return false;
        if (_hasPromoRestriction() && !_matchesAllowedPromo(d.source)) return false;
        if (normSvc(d.service) === 'BF') return true;
        const key = d.name + '|' + d.applyDate;
        const extra = bkExtraBF[key];
        if (extra && extra.contractService === 'BF') return true;
        if (d.contractService === 'BF') return true;
        return false;
      });
    }
  }
  document.getElementById('bf-bk-progress')?.addEventListener('click', () => { document.getElementById('bf-bk-status').value = '要対応'; ensureBFData(); renderBFBookings(_bfAllData); });
  document.getElementById('bf-bk-today')?.addEventListener('click', () => { window._bfTodayFilter = true; ensureBFData(); renderBFBookings(_bfAllData); });
  document.getElementById('bf-bk-reset')?.addEventListener('click', () => { ['bf-bk-status','bf-bk-facility','bf-bk-period','bf-bk-month'].forEach(id => { const e=document.getElementById(id); if(e) e.value=''; }); document.getElementById('bf-bk-search').value=''; window._bfTodayFilter=false; ensureBFData(); renderBFBookings(_bfAllData); });
  ['bf-bk-facility','bf-bk-status','bf-bk-period','bf-bk-month'].forEach(id => { document.getElementById(id)?.addEventListener('change', () => { ensureBFData(); renderBFBookings(_bfAllData); }); });
  let bfSearchTimer;
  document.getElementById('bf-bk-search')?.addEventListener('input', () => { clearTimeout(bfSearchTimer); bfSearchTimer = setTimeout(() => { ensureBFData(); renderBFBookings(_bfAllData); }, 300); });

  // BF sub-tabs
  document.querySelectorAll('.bf-sub-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // BFサブタブだけ切替（親のサブナビは触らない）
      document.querySelectorAll('.bf-sub-btn').forEach(b => { b.style.borderBottomColor = 'transparent'; b.style.color = 'var(--text-sub)'; b.style.fontWeight = '400'; });
      btn.style.borderBottomColor = 'var(--accent)';
      btn.style.color = 'var(--text)';
      btn.style.fontWeight = '600';
      const sub = btn.dataset.bfsub;
      ['bf-progress','bf-patients','bf-contracts','bf-bookings','bf-lifecycle'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.hidden = el.id !== sub;
      });
      // sub-bk-bf自体は表示のまま
      document.getElementById('sub-bk-bf').hidden = false;
      // ページトップにスクロール
      window.scrollTo({ top: 0, behavior: 'instant' });
      // セット進捗では他のメインサブナビを隠す (予約一覧/患者検索など)
      const mainSubNav = document.getElementById('bk-sub-nav');
      if (mainSubNav) mainSubNav.style.display = (sub === 'bf-lifecycle') ? 'none' : '';
      if (sub === 'bf-progress') renderBF('all');
      if (sub === 'bf-patients' || sub === 'bf-contracts') {
        if (bfPatientData.length === 0) loadBFSheetData().then(() => renderBF('all'));
        else renderBF('all');
      }
      if (sub === 'bf-bookings') { renderBF('all'); }
      if (sub === 'bf-lifecycle') { renderBFLifecycle(); }
    });
  });

  // BF tab - password protected
  document.getElementById('bf-tab-btn').addEventListener('click', (e) => {
    if (!bfUnlocked) { e.preventDefault(); e.stopPropagation(); unlockBF(); }
  });
  document.querySelectorAll('.bf-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bf-period-btn').forEach(b => b.className = 'btn btn-outline bf-period-btn');
      btn.className = 'btn btn-dark bf-period-btn';
      renderBF(btn.dataset.period);
    });
  });
  // 管理者はBFデータ読み込みのみ (BFタブ自体は来院管理に移管済みで非表示)
  if (userRole === 'admin') { bfUnlocked = true; loadBFSheetData(); }
  // 起動時にBFタブがアクティブだった場合は予約一覧にフォールバック
  try {
    const bfBtn = document.getElementById('bf-tab-btn');
    const bfSub = document.getElementById('sub-bk-bf');
    if (bfBtn && bfBtn.classList.contains('active')) {
      bfBtn.classList.remove('active');
      const bkListBtn = document.querySelector('.sub-nav-btn[data-sub="bk-list"]');
      if (bkListBtn) bkListBtn.click();
    }
    if (bfSub) bfSub.hidden = true;
  } catch(_){}

  // Apply analysis period buttons
  document.querySelectorAll('.apply-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.apply-period-btn').forEach(b => b.className = 'btn btn-outline apply-period-btn');
      btn.className = 'btn btn-dark apply-period-btn';
      renderApplyAnalysis(btn.dataset.period);
    });
  });

  // Analysis filters & axis
  ['an-facility','an-service','an-promo','an-tool','an-month'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', renderAnalysis);
  });
  const anResetBtn = document.getElementById('an-reset');
  if (anResetBtn) anResetBtn.addEventListener('click', () => {
    ['an-facility','an-service','an-promo','an-tool','an-month'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
    renderAnalysis();
  });
  document.querySelectorAll('.an-axis-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.an-axis-btn').forEach(b => { b.className = 'btn btn-outline an-axis-btn'; });
      btn.className = 'btn btn-dark an-axis-btn';
      window._anAxis = btn.dataset.axis;
      renderAnalysis();
    });
  });
  window._anAxis = 'promo';

  // Bookings filters
  // Quick filter buttons
  const resetQuickBtns = () => {
    document.getElementById('bk-overdue-btn').style.cssText = 'min-height:34px;padding:6px 16px;font-size:12px;background:#fff0f0;color:#b91c1c;border:2px solid #fecaca;font-weight:600;border-radius:20px';
    document.getElementById('bk-today-btn').style.cssText = 'min-height:34px;padding:6px 16px;font-size:12px;background:#eff6ff;color:#1d4ed8;border:2px solid #bfdbfe;font-weight:600;border-radius:20px';
  };
  document.getElementById('bk-overdue-btn').addEventListener('click', () => {
    const wasActive = window._bkProgressFilter;
    resetQuickBtns();
    window._bkProgressFilter = !wasActive;
    window._bkTodayFilter = false;
    if (window._bkProgressFilter) {
      document.getElementById('bk-overdue-btn').style.cssText = 'min-height:34px;padding:6px 16px;font-size:12px;background:#dc2626;color:white;border:2px solid #dc2626;font-weight:700;border-radius:20px;box-shadow:0 2px 8px rgba(220,38,38,0.3)';
      if (window._bkDD?.status) { window._bkDD.status.selected.clear(); window._bkDD.status.updateLabel(); }
    }
    renderBookings();
  });
  document.getElementById('bk-today-btn').addEventListener('click', () => {
    const wasActive = window._bkTodayFilter;
    resetQuickBtns();
    window._bkTodayFilter = !wasActive;
    window._bkProgressFilter = false;
    if (window._bkTodayFilter) {
      document.getElementById('bk-today-btn').style.cssText = 'min-height:34px;padding:6px 16px;font-size:12px;background:#1d4ed8;color:white;border:2px solid #1d4ed8;font-weight:700;border-radius:20px;box-shadow:0 2px 8px rgba(29,78,216,0.3)';
      if (window._bkDD?.status) { window._bkDD.status.selected.clear(); window._bkDD.status.updateLabel(); }
    }
    renderBookings();
  });
  document.getElementById('bk-reset').addEventListener('click', () => {
    if (window._bkDD) {
      ['tool','facility','promo','service','status','contract'].forEach(k => {
        if (window._bkDD[k]) { window._bkDD[k].selected.clear(); window._bkDD[k].updateLabel(); }
      });
    }
    document.getElementById('bk-search').value = '';
    document.getElementById('bk-period').value = '';
    document.getElementById('bk-month').value = '';
    window._bkDateFilter = null;
    window._bkProgressFilter = false;
    window._bkTodayFilter = false;
    window._bkDisplayLimit = 200;
    resetQuickBtns();
    if (window._highlightBkFilters) window._highlightBkFilters();
    renderBookings();
  });

  // Search with debounce
  let searchTimer;
  document.getElementById('bk-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderBookings, 300);
  });
  const highlightActiveFilter = (el) => {
    if (!el) return;
    const hasVal = el.value && el.value !== '';
    if (hasVal) {
      el.style.background = '#1d4ed8';
      el.style.color = '#fff';
      el.style.borderColor = '#1d4ed8';
      el.style.fontWeight = '700';
    } else {
      el.style.background = '';
      el.style.color = '';
      el.style.borderColor = '';
      el.style.fontWeight = '';
    }
  };
  ['bk-period','bk-month'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { highlightActiveFilter(el); renderBookings(); });
  });
  // 検索欄も色付け
  document.getElementById('bk-search').addEventListener('input', () => highlightActiveFilter(document.getElementById('bk-search')));
  window._highlightBkFilters = () => ['bk-period','bk-month','bk-search'].forEach(id => { const el = document.getElementById(id); if (el) highlightActiveFilter(el); });
  document.getElementById('bk-refresh').addEventListener('click', loadBookings);
  // 除外も表示チェックボックス
  document.getElementById('bk-show-excluded')?.addEventListener('change', () => renderBookings());
  // 重複フィルターボタン
  document.getElementById('bk-dup-filter')?.addEventListener('click', () => {
    window._bkDupFilter = !window._bkDupFilter;
    const btn = document.getElementById('bk-dup-filter');
    if (window._bkDupFilter) {
      btn.style.background = '#f59e0b';
      btn.style.color = '#fff';
      btn.innerHTML = '✓ 重複のみ';
    } else {
      btn.style.background = '#fef3c7';
      btn.style.color = '#b45309';
      btn.innerHTML = '🔍 重複';
    }
    renderBookings();
  });
  document.getElementById('bk-csv').addEventListener('click', exportCSV);
  document.getElementById('bk-pdf')?.addEventListener('click', () => {
    const prevLimit = window._bkDisplayLimit;
    const prevTitle = document.title;
    // #8 PDF安全上限
    const SAFE_MAX = 1000;
    const total = (typeof bookingsData !== 'undefined' ? bookingsData : []).length;
    if (total > SAFE_MAX && !confirm(`${total}件あります。印刷はブラウザが停止する可能性があります。フィルタで絞り込むことを推奨。続行しますか?`)) return;
    printTable(
      () => {
        window._bkDisplayLimit = Math.min(Math.max(total, 1), SAFE_MAX);
        if (typeof renderBookings === 'function') renderBookings();
        document.title = `予約一覧_${new Date().toISOString().slice(0,10)}`;
      },
      () => {
        window._bkDisplayLimit = prevLimit || 200;
        if (typeof renderBookings === 'function') renderBookings();
        document.title = prevTitle;
      }
    );
  });

  // Ad Budget
  document.getElementById('ad-save').addEventListener('click', saveAdBudget);
  document.getElementById('ad-add-facility').addEventListener('click', () => addAdFacilityRow());

  // 自医院録音
  const recSaveBtn = document.getElementById('rec-save');
  if (recSaveBtn) {
    recSaveBtn.addEventListener('click', saveRecording);
    const today = new Date();
    document.getElementById('rec-date').value = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    ['rec-filter-counselor','rec-filter-facility','rec-filter-contract'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', renderRecordings);
    });
    document.getElementById('rec-start')?.addEventListener('click', startRecording);
    document.getElementById('rec-stop')?.addEventListener('click', stopRecording);
    document.getElementById('comp-ai-run')?.addEventListener('click', runCompetitorAIAnalysis);

    // プロモ率
    document.getElementById('pr-save')?.addEventListener('click', savePromoRate);
    loadPromoRates();
    renderPromoRates();

    // 変更履歴
    document.getElementById('ch-reload')?.addEventListener('click', renderChangeLog);
    document.getElementById('ch-export')?.addEventListener('click', exportChangeLogCsv);
    // バックアップ
    document.getElementById('backup-now')?.addEventListener('click', async () => {
      const btn = document.getElementById('backup-now');
      btn.disabled = true; btn.textContent = '⏳ 作成中...';
      await createBackup(true);
      btn.disabled = false; btn.textContent = '📦 今すぐバックアップ';
      renderBackupsList();
    });
    document.getElementById('backup-refresh')?.addEventListener('click', renderBackupsList);
    ['ch-filter-table','ch-filter-op','ch-filter-period'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', renderChangeLog);
    });
    document.getElementById('ch-filter-key')?.addEventListener('input', () => {
      clearTimeout(window._chSearchTimer);
      window._chSearchTimer = setTimeout(renderChangeLog, 500);
    });
    document.getElementById('rec-file')?.addEventListener('change', e => {
      const f = e.target.files[0];
      const lbl = document.getElementById('rec-file-label');
      const prev = document.getElementById('rec-file-preview');
      if (!f) { lbl.textContent = 'クリックして選択 (m4a/mp3/wav/webm)'; prev.style.display = 'none'; return; }
      const sizeMb = (f.size / 1024 / 1024).toFixed(1);
      lbl.textContent = `${f.name} (${sizeMb} MB)`;
      prev.src = URL.createObjectURL(f);
      prev.style.display = 'block';
      if (f.size > 50 * 1024 * 1024) {
        document.getElementById('rec-status').innerHTML = '<span style="color:#c00">⚠ ファイルが50MBを超えています。Supabase Freeプランでは50MBまでです</span>';
      } else {
        document.getElementById('rec-status').textContent = '';
      }
      // 録音時間をmetadata loadedで自動推測
      prev.addEventListener('loadedmetadata', () => {
        const durEl = document.getElementById('rec-duration');
        if (prev.duration && !durEl.value) durEl.value = Math.max(1, Math.round(prev.duration / 60));
      }, { once: true });
    });
  }
  document.getElementById('ad-filter-agency').addEventListener('change', renderAdBudgets);
  document.getElementById('ad-filter-month').addEventListener('change', renderAdBudgets);
  document.getElementById('ad-month').value = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  // 初期で1店舗行を追加
  addAdFacilityRow();

  // Migrate localStorage data to Supabase (one-time)
  migrateToSupabase();

  // Admin
  document.getElementById('adm-create').addEventListener('click', createAccount);
  document.querySelectorAll('.adm-toggle-all').forEach(btn => {
    btn.addEventListener('click', () => {
      const sel = document.getElementById(btn.dataset.target);
      const allSelected = [...sel.options].every(o => o.selected);
      [...sel.options].forEach(o => o.selected = !allSelected);
      btn.textContent = allSelected ? '全選択' : '解除';
    });
  });
  renderAccounts();

  // Add clinic
  document.getElementById('add-clinic-btn').addEventListener('click', () => { document.getElementById('clinic-add-modal').hidden = false; });
  document.getElementById('nc-save').addEventListener('click', saveNewClinic);

  // Documents
  document.getElementById('doc-save').addEventListener('click', saveDocument);

  // Notes
  // #1 戦略ノートをSupabase保存
  document.getElementById('save-notes').addEventListener('click', async () => {
    const val = document.getElementById('strategy-notes').value;
    localStorage.setItem('strategy-notes', val);
    await sb.from('reviews').upsert({ id: 99999, facility: '_notes_', month: 'strategy', count: 0, rating: 0 }, { onConflict: 'id' }).catch(() => {});
    // reviewsテーブルのmemo的な使い方は避け、booking_statusに保存
    await sb.from('booking_status').upsert({ name: '__strategy_notes__', apply_date: '__notes__', memo: val }, { onConflict: 'name,apply_date' }).catch(() => {});
    showToast('戦略ノートを保存しました');
  });
  // ノート読み込み（DB優先）
  sb.from('booking_status').select('memo').eq('name', '__strategy_notes__').eq('apply_date', '__notes__').then(({ data }) => {
    if (data && data[0] && data[0].memo) document.getElementById('strategy-notes').value = data[0].memo;
    else { const saved = localStorage.getItem('strategy-notes'); if (saved) document.getElementById('strategy-notes').value = saved; }
  });

  // Set default month
  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  document.getElementById('sales-month').value = monthStr;
  document.getElementById('pt-date').value = now.toISOString().split('T')[0];
}

function seedSalesData() {
  if (loadData('sales-seeded-v3', false)) return;
  const d = [
    // エスカ 7-12月
    {facility:'エスカ',month:'2025-07',insurance:10784633,selfPay:32195524,product:298338,adCost:0},
    {facility:'エスカ',month:'2025-08',insurance:9641259,selfPay:28039773,product:277920,adCost:0},
    {facility:'エスカ',month:'2025-09',insurance:11187370,selfPay:25077438,product:239518,adCost:0},
    {facility:'エスカ',month:'2025-10',insurance:11026370,selfPay:22236103,product:231840,adCost:0},
    {facility:'エスカ',month:'2025-11',insurance:9714268,selfPay:22839318,product:204102,adCost:0},
    {facility:'エスカ',month:'2025-12',insurance:10584142,selfPay:22788511,product:260648,adCost:0},
    // アール
    {facility:'アール',month:'2025-07',insurance:5867929,selfPay:19697375,product:143156,adCost:0},
    {facility:'アール',month:'2025-08',insurance:5306773,selfPay:18234847,product:235553,adCost:0},
    {facility:'アール',month:'2025-09',insurance:5585508,selfPay:14245436,product:186442,adCost:0},
    {facility:'アール',month:'2025-10',insurance:5728221,selfPay:14562746,product:167724,adCost:0},
    {facility:'アール',month:'2025-11',insurance:5013224,selfPay:16160823,product:171171,adCost:0},
    {facility:'アール',month:'2025-12',insurance:6115802,selfPay:18874019,product:129154,adCost:0},
    // ウィズ
    {facility:'ウィズ',month:'2025-07',insurance:6434977,selfPay:32429386,product:337410,adCost:0},
    {facility:'ウィズ',month:'2025-08',insurance:5214514,selfPay:23494052,product:346346,adCost:0},
    {facility:'ウィズ',month:'2025-09',insurance:6132938,selfPay:25692531,product:343754,adCost:0},
    {facility:'ウィズ',month:'2025-10',insurance:5975812,selfPay:28171796,product:198986,adCost:0},
    {facility:'ウィズ',month:'2025-11',insurance:5435821,selfPay:21198022,product:173755,adCost:0},
    {facility:'ウィズ',month:'2025-12',insurance:5538755,selfPay:23782452,product:184027,adCost:0},
    // ルミナス
    {facility:'ルミナス',month:'2025-07',insurance:6896812,selfPay:7947677,product:66892,adCost:0},
    {facility:'ルミナス',month:'2025-08',insurance:5988261,selfPay:14477111,product:88572,adCost:0},
    {facility:'ルミナス',month:'2025-09',insurance:7352373,selfPay:23829451,product:56229,adCost:0},
    {facility:'ルミナス',month:'2025-10',insurance:7549934,selfPay:10019302,product:37320,adCost:0},
    {facility:'ルミナス',month:'2025-11',insurance:7538873,selfPay:17986444,product:42356,adCost:0},
    {facility:'ルミナス',month:'2025-12',insurance:6761857,selfPay:14099253,product:67010,adCost:0},
    // 茶屋
    {facility:'茶屋',month:'2025-07',insurance:9748660,selfPay:8031837,product:57282,adCost:0},
    {facility:'茶屋',month:'2025-08',insurance:9396526,selfPay:8691819,product:65144,adCost:0},
    {facility:'茶屋',month:'2025-09',insurance:10359616,selfPay:8213979,product:89449,adCost:0},
    {facility:'茶屋',month:'2025-10',insurance:10450194,selfPay:9964517,product:90230,adCost:0},
    {facility:'茶屋',month:'2025-11',insurance:8703271,selfPay:9711275,product:53160,adCost:0},
    {facility:'茶屋',month:'2025-12',insurance:10042886,selfPay:4199521,product:77662,adCost:0},
    // アサノ
    {facility:'アサノ',month:'2025-07',insurance:2440291,selfPay:34275,product:1764,adCost:0},
    {facility:'アサノ',month:'2025-08',insurance:2058612,selfPay:0,product:1655,adCost:0},
    {facility:'アサノ',month:'2025-09',insurance:2228660,selfPay:67673,product:2464,adCost:0},
    {facility:'アサノ',month:'2025-10',insurance:1857327,selfPay:86513,product:3209,adCost:0},
    {facility:'アサノ',month:'2025-11',insurance:1931515,selfPay:0,product:2127,adCost:0},
    {facility:'アサノ',month:'2025-12',insurance:2094853,selfPay:97650,product:3591,adCost:0},
    // 知立
    {facility:'知立',month:'2025-07',insurance:6558486,selfPay:16959092,product:56011,adCost:0},
    {facility:'知立',month:'2025-08',insurance:5981855,selfPay:11505319,product:56610,adCost:0},
    {facility:'知立',month:'2025-09',insurance:2644458,selfPay:17767683,product:78029,adCost:0},
    {facility:'知立',month:'2025-10',insurance:12496635,selfPay:14276908,product:56009,adCost:0},
    {facility:'知立',month:'2025-11',insurance:6742165,selfPay:13201864,product:70737,adCost:0},
    {facility:'知立',month:'2025-12',insurance:7556702,selfPay:11845590,product:73310,adCost:0},
    // 小牧
    {facility:'小牧',month:'2025-07',insurance:6410073,selfPay:13303594,product:66218,adCost:0},
    {facility:'小牧',month:'2025-08',insurance:6458337,selfPay:14271909,product:84756,adCost:0},
    {facility:'小牧',month:'2025-09',insurance:5246363,selfPay:15164304,product:114066,adCost:0},
    {facility:'小牧',month:'2025-10',insurance:6223015,selfPay:14276908,product:56009,adCost:0},
    {facility:'小牧',month:'2025-11',insurance:5272743,selfPay:18056910,product:94881,adCost:0},
    {facility:'小牧',month:'2025-12',insurance:5676797,selfPay:11492810,product:94168,adCost:0},
    // 八事
    {facility:'八事',month:'2025-07',insurance:11473332,selfPay:3947835,product:11157,adCost:0},
    {facility:'八事',month:'2025-08',insurance:13144862,selfPay:2205136,product:10511,adCost:0},
    {facility:'八事',month:'2025-09',insurance:13600094,selfPay:4148912,product:12483,adCost:0},
    {facility:'八事',month:'2025-10',insurance:13258155,selfPay:6154073,product:11565,adCost:0},
    {facility:'八事',month:'2025-11',insurance:12732421,selfPay:2687269,product:9603,adCost:0},
    {facility:'八事',month:'2025-12',insurance:13596643,selfPay:3237590,product:11728,adCost:0},
    // 岩田
    {facility:'岩田',month:'2025-07',insurance:8520892,selfPay:2014329,product:78695,adCost:0},
    {facility:'岩田',month:'2025-08',insurance:6891121,selfPay:1092800,product:64755,adCost:0},
    {facility:'岩田',month:'2025-09',insurance:7748746,selfPay:4948306,product:90916,adCost:0},
    {facility:'岩田',month:'2025-10',insurance:7994541,selfPay:626238,product:62843,adCost:0},
    {facility:'岩田',month:'2025-11',insurance:6288113,selfPay:993547,product:59097,adCost:0},
    {facility:'岩田',month:'2025-12',insurance:6627770,selfPay:1795307,product:82066,adCost:0},
    // 大森（8月開院）
    {facility:'大森',month:'2025-08',insurance:3260920,selfPay:7589438,product:4772,adCost:0},
    {facility:'大森',month:'2025-09',insurance:2382430,selfPay:6365164,product:11516,adCost:0},
    {facility:'大森',month:'2025-10',insurance:2385517,selfPay:13685010,product:13745,adCost:0},
    {facility:'大森',month:'2025-11',insurance:2846070,selfPay:13585800,product:15501,adCost:0},
    {facility:'大森',month:'2025-12',insurance:2624221,selfPay:13492064,product:20518,adCost:0},
    // 京都（9月開院）
    {facility:'京都',month:'2025-09',insurance:395930,selfPay:1142638,product:1155,adCost:0},
    {facility:'京都',month:'2025-10',insurance:1602090,selfPay:6452866,product:31889,adCost:0},
    {facility:'京都',month:'2025-11',insurance:2225839,selfPay:10436988,product:14928,adCost:0},
    {facility:'京都',month:'2025-12',insurance:2756365,selfPay:15773248,product:27565,adCost:0},
  ].map((d,i) => ({...d, id: i+1}));
  // 24期 (2024.7-2025.6) 前期
  const prev = [
    // エスカ
    {facility:'エスカ',month:'2024-07',insurance:10706023,selfPay:32807092,product:324645,adCost:0},
    {facility:'エスカ',month:'2024-08',insurance:8656287,selfPay:34701410,product:331308,adCost:0},
    {facility:'エスカ',month:'2024-09',insurance:9222462,selfPay:26237866,product:265091,adCost:0},
    {facility:'エスカ',month:'2024-10',insurance:11457247,selfPay:32002662,product:267652,adCost:0},
    {facility:'エスカ',month:'2024-11',insurance:8961511,selfPay:20229015,product:218047,adCost:0},
    {facility:'エスカ',month:'2024-12',insurance:8749237,selfPay:20849566,product:311846,adCost:0},
    {facility:'エスカ',month:'2025-01',insurance:8994992,selfPay:27666152,product:294657,adCost:0},
    {facility:'エスカ',month:'2025-02',insurance:8843964,selfPay:26809813,product:207736,adCost:0},
    {facility:'エスカ',month:'2025-03',insurance:11432135,selfPay:32553953,product:273055,adCost:0},
    {facility:'エスカ',month:'2025-04',insurance:9755427,selfPay:41426550,product:246916,adCost:0},
    {facility:'エスカ',month:'2025-05',insurance:9568864,selfPay:30735625,product:243927,adCost:0},
    {facility:'エスカ',month:'2025-06',insurance:9709479,selfPay:31199913,product:247476,adCost:0},
    // アール
    {facility:'アール',month:'2024-07',insurance:6165198,selfPay:29039447,product:142390,adCost:0},
    {facility:'アール',month:'2024-08',insurance:6430153,selfPay:27617781,product:199672,adCost:0},
    {facility:'アール',month:'2024-09',insurance:5565081,selfPay:19962507,product:94241,adCost:0},
    {facility:'アール',month:'2024-10',insurance:6298923,selfPay:25411975,product:112645,adCost:0},
    {facility:'アール',month:'2024-11',insurance:5106601,selfPay:21350672,product:140982,adCost:0},
    {facility:'アール',month:'2024-12',insurance:5822595,selfPay:33876009,product:182555,adCost:0},
    {facility:'アール',month:'2025-01',insurance:5619916,selfPay:19712837,product:122481,adCost:0},
    {facility:'アール',month:'2025-02',insurance:3567955,selfPay:21563888,product:150200,adCost:0},
    {facility:'アール',month:'2025-03',insurance:6720522,selfPay:24521858,product:146367,adCost:0},
    {facility:'アール',month:'2025-04',insurance:5155654,selfPay:15745837,product:148667,adCost:0},
    {facility:'アール',month:'2025-05',insurance:4730599,selfPay:21386290,product:175221,adCost:0},
    {facility:'アール',month:'2025-06',insurance:6102000,selfPay:18320915,product:184057,adCost:0},
    // ウィズ
    {facility:'ウィズ',month:'2024-07',insurance:4646159,selfPay:34461952,product:325029,adCost:0},
    {facility:'ウィズ',month:'2024-08',insurance:3899456,selfPay:37195137,product:330018,adCost:0},
    {facility:'ウィズ',month:'2024-09',insurance:4066480,selfPay:32326085,product:154054,adCost:0},
    {facility:'ウィズ',month:'2024-10',insurance:5295804,selfPay:29985612,product:329116,adCost:0},
    {facility:'ウィズ',month:'2024-11',insurance:3967482,selfPay:29255699,product:104216,adCost:0},
    {facility:'ウィズ',month:'2024-12',insurance:4690514,selfPay:26465009,product:102599,adCost:0},
    {facility:'ウィズ',month:'2025-01',insurance:4591256,selfPay:30355028,product:125881,adCost:0},
    {facility:'ウィズ',month:'2025-02',insurance:4862753,selfPay:33514109,product:104762,adCost:0},
    {facility:'ウィズ',month:'2025-03',insurance:5319279,selfPay:39353245,product:277180,adCost:0},
    {facility:'ウィズ',month:'2025-04',insurance:4959707,selfPay:29348118,product:148020,adCost:0},
    {facility:'ウィズ',month:'2025-05',insurance:5043383,selfPay:21643818,product:195202,adCost:0},
    {facility:'ウィズ',month:'2025-06',insurance:3644596,selfPay:36056855,product:1569708,adCost:0},
    // ルミナス
    {facility:'ルミナス',month:'2024-07',insurance:7020481,selfPay:8094101,product:60060,adCost:0},
    {facility:'ルミナス',month:'2024-08',insurance:6754322,selfPay:7229500,product:56083,adCost:0},
    {facility:'ルミナス',month:'2024-09',insurance:7474929,selfPay:7936071,product:45699,adCost:0},
    {facility:'ルミナス',month:'2024-10',insurance:7088765,selfPay:7846054,product:41839,adCost:0},
    {facility:'ルミナス',month:'2024-11',insurance:6603463,selfPay:3220682,product:41789,adCost:0},
    {facility:'ルミナス',month:'2024-12',insurance:6644678,selfPay:4777253,product:52529,adCost:0},
    {facility:'ルミナス',month:'2025-01',insurance:6168041,selfPay:5003863,product:27327,adCost:0},
    {facility:'ルミナス',month:'2025-02',insurance:5968074,selfPay:10043375,product:37563,adCost:0},
    {facility:'ルミナス',month:'2025-03',insurance:6420356,selfPay:6285882,product:48758,adCost:0},
    {facility:'ルミナス',month:'2025-04',insurance:6625648,selfPay:6964365,product:61111,adCost:0},
    {facility:'ルミナス',month:'2025-05',insurance:6862560,selfPay:6875404,product:52411,adCost:0},
    {facility:'ルミナス',month:'2025-06',insurance:6841934,selfPay:13067664,product:56722,adCost:0},
    // 茶屋
    {facility:'茶屋',month:'2024-07',insurance:8410214,selfPay:11958503,product:56838,adCost:0},
    {facility:'茶屋',month:'2024-08',insurance:6805577,selfPay:11326777,product:44618,adCost:0},
    {facility:'茶屋',month:'2024-09',insurance:7347278,selfPay:11413512,product:41799,adCost:0},
    {facility:'茶屋',month:'2024-10',insurance:8537815,selfPay:5301613,product:43464,adCost:0},
    {facility:'茶屋',month:'2024-11',insurance:5747460,selfPay:13529178,product:46674,adCost:0},
    {facility:'茶屋',month:'2024-12',insurance:8103911,selfPay:9527449,product:51651,adCost:0},
    {facility:'茶屋',month:'2025-01',insurance:9542320,selfPay:7504288,product:33747,adCost:0},
    {facility:'茶屋',month:'2025-02',insurance:7857774,selfPay:9221927,product:66821,adCost:0},
    {facility:'茶屋',month:'2025-03',insurance:9926814,selfPay:11403438,product:65891,adCost:0},
    {facility:'茶屋',month:'2025-04',insurance:8754679,selfPay:8347240,product:104402,adCost:0},
    {facility:'茶屋',month:'2025-05',insurance:7946434,selfPay:6849185,product:58240,adCost:0},
    {facility:'茶屋',month:'2025-06',insurance:10005547,selfPay:7675529,product:79562,adCost:0},
    // アサノ
    {facility:'アサノ',month:'2024-07',insurance:1126698,selfPay:0,product:1700,adCost:0},
    {facility:'アサノ',month:'2024-08',insurance:1260100,selfPay:10509,product:482,adCost:0},
    {facility:'アサノ',month:'2024-09',insurance:1644775,selfPay:0,product:5082,adCost:0},
    {facility:'アサノ',month:'2024-10',insurance:1762688,selfPay:90682,product:1182,adCost:0},
    {facility:'アサノ',month:'2024-11',insurance:3135150,selfPay:12000,product:1755,adCost:0},
    {facility:'アサノ',month:'2024-12',insurance:1593983,selfPay:84896,product:255,adCost:0},
    {facility:'アサノ',month:'2025-01',insurance:1761419,selfPay:66213,product:2491,adCost:0},
    {facility:'アサノ',month:'2025-02',insurance:1854913,selfPay:117000,product:1254,adCost:0},
    {facility:'アサノ',month:'2025-03',insurance:1494898,selfPay:199544,product:1882,adCost:0},
    {facility:'アサノ',month:'2025-04',insurance:1956367,selfPay:6000,product:691,adCost:0},
    {facility:'アサノ',month:'2025-05',insurance:2167327,selfPay:67008,product:1027,adCost:0},
    {facility:'アサノ',month:'2025-06',insurance:2767541,selfPay:46625,product:4200,adCost:0},
    // 知立
    {facility:'知立',month:'2024-07',insurance:4648320,selfPay:7938320,product:46953,adCost:0},
    {facility:'知立',month:'2024-08',insurance:4199146,selfPay:11796183,product:54539,adCost:0},
    {facility:'知立',month:'2024-09',insurance:5380403,selfPay:9749773,product:51735,adCost:0},
    {facility:'知立',month:'2024-10',insurance:5184839,selfPay:8159619,product:65112,adCost:0},
    {facility:'知立',month:'2024-11',insurance:5255503,selfPay:13697682,product:70737,adCost:0},
    {facility:'知立',month:'2024-12',insurance:5619449,selfPay:16779409,product:80417,adCost:0},
    {facility:'知立',month:'2025-01',insurance:5456301,selfPay:14770865,product:52211,adCost:0},
    {facility:'知立',month:'2025-02',insurance:5396551,selfPay:16929673,product:56519,adCost:0},
    {facility:'知立',month:'2025-03',insurance:6090643,selfPay:19948409,product:70265,adCost:0},
    {facility:'知立',month:'2025-04',insurance:5672023,selfPay:21526320,product:69926,adCost:0},
    {facility:'知立',month:'2025-05',insurance:6006939,selfPay:19225819,product:76389,adCost:0},
    {facility:'知立',month:'2025-06',insurance:6389932,selfPay:20881947,product:78140,adCost:0},
    // 小牧
    {facility:'小牧',month:'2024-07',insurance:5589440,selfPay:19611594,product:47346,adCost:0},
    {facility:'小牧',month:'2024-08',insurance:4591126,selfPay:17286810,product:76354,adCost:0},
    {facility:'小牧',month:'2024-09',insurance:4646293,selfPay:13089999,product:47216,adCost:0},
    {facility:'小牧',month:'2024-10',insurance:4670008,selfPay:8514408,product:77284,adCost:0},
    {facility:'小牧',month:'2024-11',insurance:4827155,selfPay:12032199,product:71378,adCost:0},
    {facility:'小牧',month:'2024-12',insurance:5536365,selfPay:14793283,product:92969,adCost:0},
    {facility:'小牧',month:'2025-01',insurance:5547099,selfPay:16339602,product:84562,adCost:0},
    {facility:'小牧',month:'2025-02',insurance:5568289,selfPay:19899363,product:83146,adCost:0},
    {facility:'小牧',month:'2025-03',insurance:7085798,selfPay:26521067,product:106733,adCost:0},
    {facility:'小牧',month:'2025-04',insurance:5863344,selfPay:15955705,product:70295,adCost:0},
    {facility:'小牧',month:'2025-05',insurance:6523237,selfPay:19087067,product:52825,adCost:0},
    {facility:'小牧',month:'2025-06',insurance:5673396,selfPay:23702341,product:86924,adCost:0},
    // 八事(24/8開院)
    {facility:'八事',month:'2024-08',insurance:8076620,selfPay:720000,product:7784,adCost:0},
    {facility:'八事',month:'2024-09',insurance:9204310,selfPay:656000,product:8598,adCost:0},
    {facility:'八事',month:'2024-10',insurance:9767904,selfPay:1202286,product:4837,adCost:0},
    {facility:'八事',month:'2024-11',insurance:10337519,selfPay:201000,product:8291,adCost:0},
    {facility:'八事',month:'2024-12',insurance:9980427,selfPay:1278702,product:24701,adCost:0},
    {facility:'八事',month:'2025-01',insurance:9483294,selfPay:477506,product:11145,adCost:0},
    {facility:'八事',month:'2025-02',insurance:10213539,selfPay:1798838,product:15974,adCost:0},
    {facility:'八事',month:'2025-03',insurance:11695083,selfPay:1768105,product:14082,adCost:0},
    {facility:'八事',month:'2025-04',insurance:12507698,selfPay:719561,product:16538,adCost:0},
    {facility:'八事',month:'2025-05',insurance:11729259,selfPay:1083526,product:21092,adCost:0},
    {facility:'八事',month:'2025-06',insurance:14523596,selfPay:2020057,product:17029,adCost:0},
    // 岩田(25/1開院)
    {facility:'岩田',month:'2025-01',insurance:6858430,selfPay:481509,product:62481,adCost:0},
    {facility:'岩田',month:'2025-02',insurance:6859110,selfPay:237500,product:62595,adCost:0},
    {facility:'岩田',month:'2025-03',insurance:8355135,selfPay:113500,product:87189,adCost:0},
    {facility:'岩田',month:'2025-04',insurance:7699965,selfPay:706536,product:65112,adCost:0},
    {facility:'岩田',month:'2025-05',insurance:7555106,selfPay:308728,product:52953,adCost:0},
    {facility:'岩田',month:'2025-06',insurance:7907876,selfPay:333324,product:92231,adCost:0},
  ].map((d,i) => ({...d, id: 1000+i}));
  saveData('sales-data', [...d, ...prev]);
  saveData('sales-seeded-v3', true);
}

function seedConsultationData() {
  if (loadData('consult-seeded-v5', false)) return;
  // 24期 矯正相談データ（施設別・月別・種類別）
  const facilities = {
    'エスカ': {consult:[109,74,90,101,88,62,96,98,110,110,98,87],decide:[53,39,41,36,40,33,41,44,62,52,36,51],kr_c:[4,5,8,10,4,3,1,1,1,2,2,2],kr_d:[2,1,4,2,1,1,0,0,1,1,1,0],ws_c:[4,8,5,11,16,8,11,16,17,7,5,4],ws_d:[2,2,1,2,4,0,2,4,6,3,2,2],bx_c:[19,15,30,24,17,13,27,23,34,30,33,26],bx_d:[5,4,10,7,6,6,8,7,19,12,7,11]},
    'アール': {consult:[94,65,80,74,83,82,92,103,87,81,78,66],decide:[38,42,45,42,43,44,50,41,39,39,47,29],kr_c:[7,6,10,7,4,6,4,5,3,1,1,3],kr_d:[4,2,8,3,1,2,1,2,0,0,1,1],ws_c:[5,1,6,13,20,13,8,19,28,16,7,8],ws_d:[0,1,1,3,6,1,5,6,7,6,2,1],bx_c:[6,6,12,11,8,17,27,23,4,15,20,11],bx_d:[1,7,8,6,4,9,13,12,0,4,9,2]},
    'ウィズ': {consult:[122,86,97,72,104,110,92,126,92,96,84,97],decide:[82,59,64,56,66,68,45,57,69,34,46,56],kr_c:[12,10,14,6,2,4,4,5,2,5,4,2],kr_d:[4,4,4,2,0,0,1,0,2,2,1,1],ws_c:[10,21,34,47,63,22,27,43,19,26,19,20],ws_d:[10,6,7,15,25,7,10,15,10,3,9,12],bx_c:[0,0,16,17,9,0,6,14,15,13,4,5],bx_d:[0,0,5,7,2,0,0,0,5,4,4,2]},
    'ルミナス': {consult:[25,12,14,11,11,9,16,21,18,23,13,10],decide:[18,8,10,9,9,5,14,14,11,17,10,8],kr_c:[3,0,3,1,1,1,2,1,2,1,0,1],kr_d:[3,0,1,0,0,0,0,0,0,0,0,0],ws_c:[0,2,0,0,1,1,1,3,2,1,1,0],ws_d:[0,0,0,0,0,0,0,1,0,0,0,0],bx_c:[3,1,4,1,1,0,2,7,0,4,0,4],bx_d:[3,0,2,2,1,0,2,4,0,2,0,0]},
    '茶屋': {consult:[32,34,36,45,52,22,22,35,30,30,22,31],decide:[18,16,14,20,18,18,10,12,9,12,10,15],kr_c:[2,7,3,6,4,1,2,3,1,0,4,0],kr_d:[0,3,1,1,0,1,0,0,0,0,0,0],ws_c:[4,8,10,8,17,15,9,13,17,10,6,20],ws_d:[0,3,2,0,5,4,1,0,3,1,0,2],bx_c:[0,0,0,0,0,0,0,0,0,0,0,0],bx_d:[0,0,0,0,0,0,0,0,0,0,0,0]},
    '小牧': {consult:[50,38,33,18,27,108,99,88,71,81,72,83],decide:[37,24,24,12,21,42,50,45,30,31,41,29],kr_c:[0,0,0,1,0,0,1,4,2,1,2,2],kr_d:[0,0,0,0,0,0,0,1,0,0,0,2],ws_c:[2,8,4,4,11,11,11,5,8,0,8,20],ws_d:[1,4,1,2,16,1,2,0,0,0,1,6],bx_c:[0,0,0,0,0,0,0,0,0,0,0,0],bx_d:[0,0,0,0,0,0,0,0,0,0,0,0]},
    '知立': {consult:[40,39,46,46,67,98,95,114,137,117,113,114],decide:[29,18,18,27,39,26,35,43,49,31,40,67],kr_c:[0,0,0,0,0,0,8,5,4,1,3,3],kr_d:[0,0,0,0,0,0,3,2,0,0,1,2],ws_c:[12,10,15,15,28,26,18,31,30,11,36,25],ws_d:[1,3,4,2,9,5,4,6,10,3,6,12],bx_c:[0,0,0,0,0,0,0,0,0,0,0,0],bx_d:[0,0,0,0,0,0,0,0,0,0,0,0]},
  };
  const months24 = ['2024-07','2024-08','2024-09','2024-10','2024-11','2024-12','2025-01','2025-02','2025-03','2025-04','2025-05','2025-06'];
  const entries = [];
  Object.entries(facilities).forEach(([fac, data]) => {
    months24.forEach((m, i) => {
      entries.push({facility:fac,month:m,consult:data.consult[i],decide:data.decide[i],kr_c:data.kr_c[i],kr_d:data.kr_d[i],ws_c:data.ws_c[i],ws_d:data.ws_d[i],bx_c:data.bx_c[i],bx_d:data.bx_d[i]});
    });
  });
  // 25期 (2025.7-) 今期データ
  const facilities25 = {
    'エスカ': {consult:[93,84,82,76,73,62,86,75,0,0,0,0],decide:[45,41,33,40,26,28,30,36,0,0,0,0],kr_c:[0,1,1,1,1,0,0,0,0,0,0,0],kr_d:[0,0,1,0,0,0,0,0,0,0,0,0],ws_c:[10,2,3,3,5,2,2,5,0,0,0,0],ws_d:[2,0,0,0,1,0,0,1,0,0,0,0],bx_c:[19,18,24,24,30,23,29,20,0,0,0,0],bx_d:[8,7,5,9,10,9,11,8,0,0,0,0]},
    'アール': {consult:[58,62,52,66,40,51,69,65,0,0,0,0],decide:[24,15,24,33,28,25,37,25,0,0,0,0],kr_c:[1,5,0,1,0,2,1,0,0,0,0,0],kr_d:[1,0,0,1,0,0,0,0,0,0,0,0],ws_c:[9,4,0,0,4,6,0,2,0,0,0,0],ws_d:[2,0,0,0,0,1,0,0,0,0,0,0],bx_c:[15,16,14,14,9,0,13,4,0,0,0,0],bx_d:[6,6,3,6,0,0,3,0,0,0,0,0]},
    'ウィズ': {consult:[81,66,82,65,73,47,125,119,0,0,0,0],decide:[52,33,52,25,39,33,68,53,0,0,0,0],kr_c:[2,0,1,4,1,0,1,3,0,0,0,0],kr_d:[0,1,1,1,0,0,0,0,0,0,0,0],ws_c:[18,10,17,13,14,8,14,9,0,0,0,0],ws_d:[9,2,6,4,4,3,5,5,0,0,0,0],bx_c:[10,10,4,9,9,6,4,5,0,0,0,0],bx_d:[3,6,3,2,6,4,0,5,0,0,0,0]},
    'ルミナス': {consult:[14,15,13,22,14,10,21,18,0,0,0,0],decide:[13,6,9,15,12,10,18,17,0,0,0,0],kr_c:[0,0,0,0,0,0,0,0,0,0,0,0],kr_d:[0,0,0,0,0,0,0,0,0,0,0,0],ws_c:[0,0,0,0,1,0,0,0,0,0,0,0],ws_d:[1,0,0,0,0,0,0,0,0,0,0,0],bx_c:[0,2,3,3,0,1,4,0,0,0,0,0],bx_d:[2,0,1,3,0,1,4,0,0,0,0,0]},
    '茶屋': {consult:[48,45,35,32,19,26,0,0,0,0,0,0],decide:[14,12,17,11,4,16,0,0,0,0,0,0],kr_c:[3,2,0,1,0,0,0,0,0,0,0,0],kr_d:[0,1,0,0,0,0,0,0,0,0,0,0],ws_c:[27,30,19,15,10,13,0,0,0,0,0,0],ws_d:[5,1,3,4,1,0,0,0,0,0,0,0],bx_c:[0,0,0,0,0,0,0,0,0,0,0,0],bx_d:[0,0,0,0,0,0,0,0,0,0,0,0]},
    '小牧': {consult:[74,63,41,48,51,48,0,0,0,0,0,0],decide:[30,39,32,29,18,30,0,0,0,0,0,0],kr_c:[2,2,0,1,0,0,0,0,0,0,0,0],kr_d:[0,2,0,1,0,0,0,0,0,0,0,0],ws_c:[22,8,4,6,8,6,0,0,0,0,0,0],ws_d:[5,2,1,3,3,4,0,0,0,0,0,0],bx_c:[0,0,0,0,0,0,0,0,0,0,0,0],bx_d:[0,0,0,0,0,0,0,0,0,0,0,0]},
    '知立': {consult:[85,86,85,53,38,62,0,0,0,0,0,0],decide:[21,17,31,26,15,19,0,0,0,0,0,0],kr_c:[2,3,3,1,1,0,0,0,0,0,0,0],kr_d:[0,1,1,1,1,0,0,0,0,0,0,0],ws_c:[20,24,24,11,10,21,0,0,0,0,0,0],ws_d:[4,2,4,3,4,3,0,0,0,0,0,0],bx_c:[0,0,0,0,0,0,0,0,0,0,0,0],bx_d:[0,0,0,0,0,0,0,0,0,0,0,0]},
  };
  const months25 = ['2025-07','2025-08','2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06'];
  Object.entries(facilities25).forEach(([fac, data]) => {
    months25.forEach((m, i) => {
      if (data.consult[i] > 0) {
        entries.push({facility:fac,month:m,consult:data.consult[i],decide:data.decide[i],kr_c:data.kr_c[i],kr_d:data.kr_d[i],ws_c:data.ws_c[i],ws_d:data.ws_d[i],bx_c:data.bx_c[i],bx_d:data.bx_d[i]});
      }
    });
  });

  saveData('consultation-data', entries);

  // ドクター矯正データ 全年度
  const drData = [
    // 2020年
    ...[
      {name:'小池',consult:[15,27,20,11,13,25,40,33,17,31,29,21],decide:[13,15,18,6,11,13,23,14,11,13,13,15]},
      {name:'清水',consult:[14,17,24,17,24,41,50,26,26,36,30,18],decide:[3,7,13,8,10,16,12,18,15,14,9,3]},
      {name:'星野',consult:[10,7,7,3,13,23,21,19,11,17,4,7],decide:[0,3,4,2,6,13,12,11,6,6,3,7]},
      {name:'越知',consult:[19,12,14,9,13,22,32,18,12,19,13,18],decide:[9,3,8,4,5,9,11,8,4,14,3,4]},
      {name:'荒木',consult:[10,10,7,11,11,15,17,15,16,13,14,8],decide:[9,3,4,4,3,4,4,4,11,6,9,2]},
      {name:'山田',consult:[3,5,6,4,2,16,13,11,18,14,9,12],decide:[0,0,2,0,0,7,6,6,6,5,5,11]},
      {name:'古田',consult:[0,0,3,1,0,2,4,1,12,8,9,5],decide:[0,0,1,0,1,1,0,1,6,1,2,2]},
      {name:'原',consult:[0,0,0,0,0,0,2,17,19,9,14,12],decide:[0,0,0,0,0,0,1,5,6,5,9,7]},
      {name:'英',consult:[13,5,5,3,4,14,12,13,16,13,6,16],decide:[7,3,2,1,1,8,9,8,4,4,2,7]},
      {name:'小倉',consult:[0,0,0,0,1,2,2,8,12,6,11,11],decide:[0,0,0,0,1,1,0,4,4,0,3,6]},
    ].flatMap(dr => ['2020-01','2020-02','2020-03','2020-04','2020-05','2020-06','2020-07','2020-08','2020-09','2020-10','2020-11','2020-12'].map((m,i) => dr.consult[i]>0?{name:dr.name,month:m,consult:dr.consult[i],decide:dr.decide[i]}:null).filter(Boolean)),
    // 2021年
    ...[
      {name:'小池',consult:[20,37,35,26,25,20,14,13,4,10,12,13],decide:[16,25,12,17,20,12,11,8,5,2,7,10]},
      {name:'越知',consult:[11,17,14,33,5,12,5,11,12,9,6,5],decide:[8,6,4,5,7,5,4,5,6,2,6,3]},
      {name:'荒木',consult:[17,13,10,14,8,7,7,12,5,3,7,8],decide:[6,9,2,7,9,4,4,6,3,1,3,5]},
      {name:'山田',consult:[22,22,9,32,27,20,8,6,10,7,10,6],decide:[15,23,6,25,23,9,5,2,8,3,7,7]},
      {name:'古田',consult:[30,16,6,26,14,15,17,12,22,10,18,8],decide:[13,10,5,10,6,1,5,4,13,3,5,5]},
      {name:'小倉',consult:[13,21,15,16,16,12,13,6,23,12,13,4],decide:[11,16,4,10,10,6,5,4,6,6,6,2]},
      {name:'原',consult:[14,17,15,24,18,13,21,2,15,10,23,17],decide:[14,13,5,13,18,8,10,4,7,8,14,14]},
      {name:'鈴木',consult:[0,0,0,4,16,15,10,14,10,8,6,3],decide:[0,0,0,3,8,5,6,7,7,4,4,3]},
      {name:'奥村',consult:[13,9,15,16,22,13,14,11,9,10,6,10],decide:[10,7,7,5,15,8,13,8,8,5,5,6]},
      {name:'竹内',consult:[0,0,0,0,0,6,3,4,3,7,3,1],decide:[0,0,0,0,0,0,2,0,2,5,1,0]},
    ].flatMap(dr => ['2021-01','2021-02','2021-03','2021-04','2021-05','2021-06','2021-07','2021-08','2021-09','2021-10','2021-11','2021-12'].map((m,i) => dr.consult[i]>0?{name:dr.name,month:m,consult:dr.consult[i],decide:dr.decide[i]}:null).filter(Boolean)),
    // 2022年
    ...[
      {name:'小池',consult:[27,22,25,17,14,17,17,15,19,19,22,22],decide:[23,17,18,14,15,14,10,12,14,16,18,12]},
      {name:'越知',consult:[18,7,10,5,15,11,12,5,10,11,14,5],decide:[13,5,7,3,4,10,3,3,3,4,6,3]},
      {name:'荒木',consult:[14,10,10,3,33,10,18,11,7,10,11,16],decide:[10,6,8,3,10,9,4,4,5,7,4,6]},
      {name:'山田',consult:[8,8,10,7,5,11,6,8,11,15,8,7],decide:[9,5,12,5,4,6,5,5,7,8,5,5]},
      {name:'古田',consult:[17,17,15,21,21,16,17,27,23,14,12,21],decide:[10,11,10,8,15,8,7,13,10,4,4,6]},
      {name:'小倉',consult:[15,15,8,7,11,11,15,8,8,8,5,6],decide:[8,8,7,2,7,4,6,5,3,7,3,0]},
      {name:'原',consult:[28,16,16,18,16,14,12,17,23,29,27,30],decide:[19,15,14,16,10,14,8,14,18,17,23,22]},
      {name:'竹内',consult:[2,3,6,3,11,12,9,13,10,10,10,12],decide:[3,1,3,2,6,7,10,6,6,4,5,8]},
      {name:'大西麻',consult:[0,0,0,1,3,2,7,3,4,3,5,5],decide:[0,0,0,0,0,3,2,3,0,2,0,4]},
      {name:'安藤',consult:[7,5,9,7,11,9,4,6,10,4,6,6],decide:[3,3,7,3,5,6,2,6,9,4,4,3]},
      {name:'清水',consult:[0,0,0,0,3,5,8,7,8,3,5,3],decide:[0,0,0,0,0,2,4,4,7,2,2,2]},
      {name:'田村',consult:[0,0,0,0,0,0,1,5,10,6,4,6],decide:[0,0,0,0,0,0,0,2,5,5,2,3]},
      {name:'奥村',consult:[14,8,7,6,15,3,0,0,0,0,0,8],decide:[11,6,7,3,7,5,0,1,0,0,0,3]},
    ].flatMap(dr => ['2022-01','2022-02','2022-03','2022-04','2022-05','2022-06','2022-07','2022-08','2022-09','2022-10','2022-11','2022-12'].map((m,i) => dr.consult[i]>0?{name:dr.name,month:m,consult:dr.consult[i],decide:dr.decide[i]}:null).filter(Boolean)),
    // 2023年
    ...[
      {name:'小池',consult:[37,48,34,42,36,26,42,32,48,31,27,28],decide:[29,35,23,27,29,15,28,21,34,28,14,13]},
      {name:'越知',consult:[16,14,33,15,23,11,18,21,24,16,10,11],decide:[7,3,17,8,9,5,11,10,11,5,7,3]},
      {name:'荒木',consult:[23,21,21,24,35,23,30,26,14,21,14,18],decide:[7,10,11,9,18,11,7,9,10,14,2,6]},
      {name:'山田',consult:[13,16,16,10,21,23,12,16,16,10,5,13],decide:[11,4,8,8,13,17,11,6,14,8,1,11]},
      {name:'古田',consult:[39,35,24,35,37,24,40,41,37,31,16,29],decide:[23,21,17,13,15,12,14,15,11,15,7,8]},
      {name:'小倉',consult:[14,10,22,22,34,30,48,40,47,46,21,17],decide:[10,6,17,9,12,13,25,19,23,23,11,7]},
      {name:'原',consult:[60,49,70,59,61,50,41,71,43,43,42,45],decide:[35,32,51,45,30,38,27,39,25,29,19,24]},
      {name:'竹内',consult:[11,12,16,24,16,12,21,29,25,29,16,26],decide:[8,8,9,10,7,8,5,9,7,13,13,16]},
      {name:'大西麻',consult:[6,5,5,14,2,2,9,9,9,9,5,8],decide:[3,1,4,6,3,1,4,3,7,8,3,5]},
      {name:'清水',consult:[9,8,14,5,15,10,13,11,7,10,12,15],decide:[3,5,8,4,6,3,6,2,4,0,9,6]},
      {name:'田村',consult:[3,7,7,4,16,27,21,24,21,19,11,21],decide:[2,1,6,2,6,13,11,15,16,6,8,10]},
      {name:'立松',consult:[0,0,0,0,0,1,1,8,13,21,15,5],decide:[0,0,0,0,0,0,0,2,7,10,5,3]},
      {name:'奥村',consult:[9,16,17,13,27,13,15,0,0,0,0,0],decide:[5,7,7,9,11,9,8,0,0,1,0,0]},
      {name:'安藤',consult:[6,2,6,0,0,5,2,2,0,0,0,0],decide:[1,1,2,1,1,3,1,2,0,2,0,0]},
      {name:'武内',consult:[0,0,0,0,0,0,0,0,1,0,0,1],decide:[0,0,0,0,0,0,0,0,1,0,0,1]},
      {name:'長谷川',consult:[0,0,0,0,0,0,0,0,0,0,0,1],decide:[0,0,0,0,0,0,0,0,0,0,1,1]},
    ].flatMap(dr => ['2023-01','2023-02','2023-03','2023-04','2023-05','2023-06','2023-07','2023-08','2023-09','2023-10','2023-11','2023-12'].map((m,i) => dr.consult[i]>0?{name:dr.name,month:m,consult:dr.consult[i],decide:dr.decide[i]}:null).filter(Boolean)),
    // 2025年（1月〜11月）
    ...[
      {name:'小池',consult:[25,31,41,43,35,27,25,23,13,33,20],decide:[19,19,33,26,22,19,17,18,10,18,11]},
      {name:'越知',consult:[23,22,23,20,20,19,20,8,6,7,12],decide:[7,10,15,7,13,16,7,4,4,5,2]},
      {name:'荒木',consult:[19,22,21,18,17,23,33,34,25,29,15],decide:[6,7,4,9,2,8,7,8,10,8,4]},
      {name:'山田',consult:[12,19,11,15,7,9,10,12,15,16,10],decide:[10,12,9,11,6,7,10,5,6,10,8]},
      {name:'古田',consult:[42,43,31,41,38,36,27,28,26,30,23],decide:[16,22,13,11,17,12,8,8,4,21,12]},
      {name:'小倉',consult:[24,24,24,1,0,2,0,0,0,1,0],decide:[11,16,17,1,1,1,0,1,1,2,1]},
      {name:'原',consult:[41,43,21,38,40,26,28,33,41,34,30],decide:[23,23,19,16,24,21,21,18,25,14,15]},
      {name:'竹内耀',consult:[68,66,48,58,49,74,49,41,21,23,28],decide:[32,33,17,24,18,23,20,23,15,10,12]},
      {name:'大西麻',consult:[72,85,99,83,85,67,51,42,51,32,21],decide:[26,36,35,26,29,45,14,8,18,17,11]},
      {name:'田村',consult:[26,27,23,0,5,33,17,15,25,6,7],decide:[15,5,11,1,4,7,8,6,19,6,3]},
      {name:'立松',consult:[19,25,26,46,37,50,29,32,31,20,21],decide:[8,12,12,14,21,24,17,10,18,14,12]},
      {name:'武内',consult:[25,32,31,20,33,16,31,20,18,21,20],decide:[11,11,15,10,10,8,9,10,9,9,3]},
      {name:'長谷川',consult:[17,17,25,21,41,30,36,34,37,33,30],decide:[11,11,15,9,12,15,18,13,15,8,12]},
      {name:'永江',consult:[13,24,22,22,8,17,29,15,24,24,8],decide:[10,6,9,7,3,8,11,9,5,9,3]},
      {name:'加藤',consult:[21,25,20,28,21,23,2,42,27,30,40],decide:[10,6,10,11,3,11,1,11,9,16,15]},
      {name:'竹内玲',consult:[3,3,5,10,10,4,16,14,17,12,11],decide:[4,0,3,5,4,2,6,2,7,6,5]},
      {name:'西村',consult:[10,1,6,14,10,14,15,13,18,9,8],decide:[8,0,2,8,7,8,4,5,9,5,7]},
      {name:'鈴木',consult:[6,13,14,15,17,9,15,5,13,7,2],decide:[1,5,8,5,2,3,3,3,4,3,2]},
      {name:'中山',consult:[12,27,20,19,10,19,18,15,33,49,41],decide:[4,11,5,5,2,4,8,7,20,26,23]},
      {name:'星野',consult:[0,0,0,1,4,12,10,21,10,9,10],decide:[0,0,0,0,3,6,2,3,5,1,3]},
      {name:'綱島',consult:[0,0,0,2,1,4,10,11,13,10,17],decide:[0,0,0,0,0,1,2,1,9,9,6]},
      {name:'向田',consult:[0,0,0,2,0,2,5,10,14,21,14],decide:[0,0,0,0,0,0,4,2,5,11,2]},
      {name:'清水',consult:[0,0,0,0,0,17,15,18,16,2,7],decide:[0,0,0,0,0,7,4,1,7,3,1]},
    ].flatMap(dr => ['2025-01','2025-02','2025-03','2025-04','2025-05','2025-06','2025-07','2025-08','2025-09','2025-10','2025-11'].map((m,i) => dr.consult[i]>0?{name:dr.name,month:m,consult:dr.consult[i],decide:dr.decide[i]}:null).filter(Boolean)),
  ];
  saveData('doctor-data', drData);

  saveData('consult-seeded-v5', true);
}

function showApp() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').hidden = false;
  // v267 セッションタイムアウト監視を開始 (30分無操作で自動ログアウト)
  try { setupSessionTimeout(); } catch(e) { console.warn('setupSessionTimeout failed', e); }
  // v265 ログイン後にプルリフレッシュインジケーターを再表示可能に (logout で display:none にされている可能性)
  const _pri = document.getElementById('pull-refresh-indicator');
  if (_pri) _pri.style.display = '';

  // Phase 6: ロール別 UI ガード (ナビ非表示 + 編集禁止ビット)
  try { applyRoleUI(); } catch(e) { console.warn('applyRoleUI failed', e); }

  // A1: リアルタイム同期を開始
  try { setupRealtime(); } catch(e) { console.warn('realtime setup failed', e); }
  // A3: キューに残っている保存を試行
  try { processQueue(true); } catch(_){}
  // Layer 3: 日次自動バックアップ (admin のみ、24h経過時)
  setTimeout(() => { try { maybeAutoBackup(); } catch(_){} }, 5000);
  // v261: ヘッダーバッジ + プルリフレッシュ 初期化 (1度だけ)
  try { setupHeaderBadge(); } catch(_){}
  try { setupPullRefresh(); } catch(_){}
  // v261: データ読込後にホームダッシュボード描画
  setTimeout(() => { try { renderHomeDashboard(); } catch(_){} }, 800);
  setTimeout(() => { try { renderHomeDashboard(); } catch(_){} }, 2500);

  // ヘッダーのロール表示
  const header = document.querySelector('.header');
  header.classList.remove('role-promo', 'role-custom');
  const existingUser = header.querySelector('.header-user');
  if (existingUser) existingUser.remove();
  if (userRole === 'promo') {
    header.classList.add('role-promo');
    const span = document.createElement('span');
    span.className = 'header-user';
    span.textContent = promoFilter + ' でログイン中';
    header.querySelector('.nav-spacer').after(span);
  } else if (userRole === 'custom') {
    header.classList.add('role-custom');
    const customName = sessionStorage.getItem('customName') || '';
    if (customName) {
      const span = document.createElement('span');
      span.className = 'header-user';
      span.textContent = customName + ' でログイン中';
      header.querySelector('.nav-spacer').after(span);
    }
    // 個別発行アカウントはサブタブを全部非表示
    const bkSubNav = document.getElementById('bk-sub-nav');
    if (bkSubNav) bkSubNav.style.display = 'none';
  }

  // userRole / promoFilter は下位処理 (フィルタリング等) で参照するため必ずセット
  userRole = sessionStorage.getItem('role') || 'admin';
  promoFilter = sessionStorage.getItem('promoFilter') || '';
  // (旧 userRole ('sales' / 'tc' / 'promo' / 'custom') 別の分岐は Phase 6 で廃止。
  //  ナビの表示/非表示は applyRoleUI() 側で currentRole ('admin'/'staff_promo'/'agency') に基づき制御する)

  seedSalesData();
  seedConsultationData();
  loadClinics();
  renderFacilityTabs('sales-facility-tabs', salesFacility, f => { salesFacility = f; renderSales(); });
  renderFacilityTabs('patients-facility-tabs', patientsFacility, f => { patientsFacility = f; renderPatients(); renderRates(); });
  renderFacilityTabs('reviews-facility-tabs', reviewsFacility, f => { reviewsFacility = f; renderReviews(); });
  renderSales();
  renderPatients();
  renderRates();
  renderReviews();
  renderDocuments();
  loadBookings();
  renderAdBudgets();
  // 前回のビュー位置を復元
  restoreLastView();
}

function restoreLastView() {
  try {
    // v271: 外部ページへのログイン後リダイレクト (例: /users/ から戻ってきた場合)
    const afterLoginUrl = sessionStorage.getItem('after-login-url');
    if (afterLoginUrl) {
      sessionStorage.removeItem('after-login-url');
      // 同一オリジン内のパスのみ許可 (オープンリダイレクト防止)
      if (/^\/[\w\-/]/.test(afterLoginUrl) && !afterLoginUrl.startsWith('//')) {
        location.href = afterLoginUrl;
        return;
      }
    }

    // ロールごとに許可されたビューしか復元しない (Phase 6: currentRole ベース)
    const isAllowed = (v) => {
      if (isAdminRole()) return ['bookings','kaiin','tc','adbudget','admin','sales'].includes(v);
      if (isStaffPromoRole()) return ['bookings','kaiin'].includes(v);
      if (isAgencyRole()) return v === 'bookings';
      return v === 'bookings';
    };

    // v270: ポータルからのリダイレクト (例: ユーザー管理ボタン → admin/権限管理)
    const redirectView = sessionStorage.getItem('portal-redirect-view');
    if (redirectView) {
      sessionStorage.removeItem('portal-redirect-view');
      const redirectSub = sessionStorage.getItem('portal-redirect-sub');
      sessionStorage.removeItem('portal-redirect-sub');
      if (isAllowed(redirectView)) {
        switchView(redirectView);
        if (redirectSub) {
          setTimeout(() => {
            const subBtn = document.querySelector(`#view-${redirectView} .sub-nav-btn[data-sub="${redirectSub}"]`);
            if (subBtn) subBtn.click();
          }, 150);
        }
        return; // 通常の lastView 復元はスキップ
      }
    }

    const lastView = sessionStorage.getItem('lastView');
    if (lastView && isAllowed(lastView)) {
      switchView(lastView);
    }
    // 各ビューのサブタブ位置を復元
    document.querySelectorAll('main.view').forEach(main => {
      const sub = sessionStorage.getItem('lastSub:' + main.id);
      if (!sub) return;
      const subBtn = main.querySelector(`.sub-nav-btn[data-sub="${sub}"]`);
      if (subBtn && subBtn.style.display !== 'none') {
        // 直接DOMを切替（クリックすると医院タブの個別データロードが走るため）
        const parent = subBtn.closest('.sub-nav');
        if (parent) {
          parent.querySelectorAll('.sub-nav-btn').forEach(s => s.classList.remove('active'));
          subBtn.classList.add('active');
        }
        main.querySelectorAll('[id^="sub-"]').forEach(s => s.hidden = s.id !== `sub-${sub}`);
      }
    });
  } catch(e) { console.warn('restoreLastView', e); }
}

// === Navigation ===
// === v261 ホームダッシュボード ===
// v273: ホームダッシュボードの分析期間 (デフォルト = 今月) — sessionStorage で永続化
let _homeAnalysisRange = (() => {
  try {
    const saved = sessionStorage.getItem('home-analysis-range');
    return saved ? JSON.parse(saved) : null;
  } catch(_) { return null; }
})();
function _saveHomeRange() {
  try { sessionStorage.setItem('home-analysis-range', _homeAnalysisRange ? JSON.stringify(_homeAnalysisRange) : ''); } catch(_){}
}

function renderHomeDashboard() {
  const el = document.getElementById('home-dashboard-content');
  if (!el) return;
  const data = Array.isArray(bookingsData) ? (getFilteredBookingsData ? getFilteredBookingsData() : bookingsData) : [];
  if (!data.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-sub)">データがありません</div>';
    return;
  }

  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
  const todayEnd = new Date(now); todayEnd.setHours(23,59,59,999);
  const tomorrowEnd = new Date(todayEnd.getTime() + 24*3600*1000);
  const weekEnd = new Date(todayEnd.getTime() + 6*24*3600*1000);
  const thisMonth = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}`;
  const active = data.filter(d => d.status !== '除外');
  // 選択中の分析期間 (デフォルト = 今月)
  const ymToLabel = (ym) => {
    const [y, m] = ym.split('/');
    return `${y}年${parseInt(m)}月`;
  };
  const ymOffset = (offset) => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}`;
  };
  const range = _homeAnalysisRange || { fromYM: thisMonth, toYM: thisMonth, label: '今月' };
  // 期間内に含まれる行 (bookDate ベース)
  const inRange = (d) => {
    const bd = (d.bookDate || '');
    if (!bd) return false;
    const m = bd.match(/(\d{4})\D+(\d{1,2})/);
    if (!m) return false;
    const ym = `${m[1]}/${String(parseInt(m[2])).padStart(2,'0')}`;
    return ym >= range.fromYM && ym <= range.toYM;
  };
  const rangeRows = active.filter(inRange);

  // 今日の予約
  const today = active.filter(d => {
    const bd = parseDate(d.bookDate);
    return bd && bd >= todayStart && bd <= todayEnd;
  });
  const tomorrow = active.filter(d => {
    const bd = parseDate(d.bookDate);
    return bd && bd > todayEnd && bd <= tomorrowEnd;
  });
  const thisWeek = active.filter(d => {
    const bd = parseDate(d.bookDate);
    return bd && bd >= todayStart && bd <= weekEnd;
  });

  // 要対応 (status 未設定・未対応)
  const pending = active.filter(d => !d.status || d.status === '未対応').length;
  const confirmed = active.filter(d => d.status === '確認済' || d.status === '来院済' || d.status === '成約').length;
  const todayPending = today.filter(d => !d.status || d.status === '未対応').length;

  // 今日の予約 時間順
  const todaySorted = today.slice().sort((a,b) => (a.bookDate||'').localeCompare(b.bookDate||''));

  // v273: KPI計算 (期間範囲対応)
  const visitedStatuses = new Set(['来院済', '成約']);
  const isVisited = (s) => visitedStatuses.has(s) || (typeof IMPLANT_TREATMENT_STAGES !== 'undefined' && Array.isArray(IMPLANT_TREATMENT_STAGES) && IMPLANT_TREATMENT_STAGES.includes(s));
  const calcKPI = (rows) => {
    const booking = rows.length;
    const visited = rows.filter(d => isVisited(d.status)).length;
    const contracted = rows.filter(d => d.status === '成約');
    const amount = contracted.reduce((s,d) => s + Number(d.contractAmount || 0), 0);
    return {
      booking,
      visited,
      visitRate: booking > 0 ? Math.round(visited / booking * 100) : 0,
      contracted: contracted.length,
      decideRate: visited > 0 ? Math.round(contracted.length / visited * 100) : 0,
      amount,
      unitPrice: contracted.length > 0 ? Math.round(amount / contracted.length) : 0,
    };
  };
  const kpiRange = calcKPI(rangeRows);

  // v273: 前期間比較 (range と同じ長さの「ひとつ前」期間)
  const ymToDate = (ym) => { const [y,m] = ym.split('/').map(Number); return new Date(y, m-1, 1); };
  const dateToYM = (d) => `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}`;
  const fromDate = ymToDate(range.fromYM);
  const toDate = ymToDate(range.toYM);
  const monthsLen = (toDate.getFullYear()-fromDate.getFullYear())*12 + (toDate.getMonth()-fromDate.getMonth()) + 1;
  const prevToDate = new Date(fromDate); prevToDate.setMonth(prevToDate.getMonth() - 1);
  const prevFromDate = new Date(prevToDate); prevFromDate.setMonth(prevFromDate.getMonth() - (monthsLen - 1));
  const prevFromYM = dateToYM(prevFromDate);
  const prevToYM = dateToYM(prevToDate);
  const prevRangeRows = active.filter(d => {
    const bd = d.bookDate || '';
    if (!bd) return false;
    const m = bd.match(/(\d{4})\D+(\d{1,2})/);
    if (!m) return false;
    const ym = `${m[1]}/${String(parseInt(m[2])).padStart(2,'0')}`;
    return ym >= prevFromYM && ym <= prevToYM;
  });
  const kpiPrev = calcKPI(prevRangeRows);
  // 増減計算
  const delta = (cur, prev) => {
    if (prev === 0) return cur > 0 ? 100 : 0;
    return Math.round((cur - prev) / prev * 100);
  };
  const fmtDelta = (cur, prev) => {
    if (cur === prev) return '';
    const d = delta(cur, prev);
    if (d === 0) return '';
    const arrow = d > 0 ? '▲' : '▼';
    const color = d > 0 ? '#059669' : '#dc2626';
    return `<span style="font-size:9px;color:${color};font-weight:600;margin-left:4px">${arrow}${Math.abs(d)}%</span>`;
  };

  // 既存指標 (互換性のため)
  const thisMonthAll = active.filter(d => (d.bookDate || '').startsWith(thisMonth));
  const thisMonthContracted = thisMonthAll.filter(d => d.status === '成約');
  const thisMonthAmount = thisMonthContracted.reduce((s,d) => s + Number(d.contractAmount||0), 0);

  // 医院別 / 治療別 (選択期間)
  const byFacMonth = {};
  rangeRows.forEach(d => {
    const f = normFac(d.facility) || '-';
    if (!byFacMonth[f]) byFacMonth[f] = { booking: 0, visited: 0, contracted: 0 };
    byFacMonth[f].booking++;
    if (isVisited(d.status)) byFacMonth[f].visited++;
    if (d.status === '成約') byFacMonth[f].contracted++;
  });
  const facList = Object.keys(byFacMonth).sort((a,b) => byFacMonth[b].booking - byFacMonth[a].booking);

  const byTreatMonth = {};
  rangeRows.forEach(d => {
    const t = (typeof normSvc === 'function' ? normSvc(d.service) : d.service) || '-';
    if (!byTreatMonth[t]) byTreatMonth[t] = { booking: 0, visited: 0, contracted: 0 };
    byTreatMonth[t].booking++;
    if (isVisited(d.status)) byTreatMonth[t].visited++;
    if (d.status === '成約') byTreatMonth[t].contracted++;
  });
  const treatList = Object.keys(byTreatMonth).sort((a,b) => byTreatMonth[b].booking - byTreatMonth[a].booking);

  // v273: 時間帯別予約分布 (選択期間)
  const byHour = new Array(24).fill(0);
  rangeRows.forEach(d => {
    const tm = (d.bookDate || '').match(/(\d{1,2}):(\d{2})/);
    if (tm) {
      const h = parseInt(tm[1], 10);
      if (h >= 0 && h <= 23) byHour[h]++;
    }
  });
  const maxHour = Math.max(...byHour, 1);
  const hourPeak = byHour.indexOf(maxHour);

  // 期間ラベル
  const rangeLabel = range.label || (range.fromYM === range.toYM ? ymToLabel(range.fromYM) : `${ymToLabel(range.fromYM)}〜${ymToLabel(range.toYM)}`);
  // 期間プリセットの判定
  const presetMatch = (preset) => {
    if (preset === 'last' && range.fromYM === ymOffset(-1) && range.toYM === ymOffset(-1)) return true;
    if (preset === 'this' && range.fromYM === ymOffset(0) && range.toYM === ymOffset(0)) return true;
    if (preset === 'next' && range.fromYM === ymOffset(1) && range.toYM === ymOffset(1)) return true;
    if (preset === '3m' && range.fromYM === ymOffset(-1) && range.toYM === ymOffset(1)) return true;
    return false;
  };
  const monthInputValue = (ym) => ym.replace('/', '-'); // YYYY/MM → YYYY-MM (input type=month)

  // キャンセル (今週)
  const weekCancel = active.filter(d => {
    if (d.status !== 'キャンセル') return false;
    const bd = parseDate(d.bookDate);
    return bd && bd >= todayStart && bd <= weekEnd;
  }).length;

  const fmtYen = n => '¥' + (n || 0).toLocaleString('ja-JP');
  const greeting = (() => {
    const h = now.getHours();
    if (h < 5) return 'おつかれさまです';
    if (h < 11) return 'おはようございます';
    if (h < 18) return 'こんにちは';
    return 'おつかれさまです';
  })();
  const name = (window.currentUserName || sessionStorage.getItem('customName') || (typeof currentRole !== 'undefined' ? currentRole : '') || '').toString();

  el.innerHTML = `
    <div style="margin-bottom:14px">
      <div style="font-size:13px;color:var(--text-sub);margin-bottom:4px">${greeting}${name ? '、' + escapeHtml(name) + ' さん' : ''}</div>
      <div style="font-size:18px;font-weight:700;color:#1a1a1a">今日は ${now.getMonth()+1}月${now.getDate()}日 (${'日月火水木金土'[now.getDay()]})</div>
    </div>

    <!-- 大きなアラート (要対応が多い) -->
    ${todayPending > 0 ? `
      <div class="home-alert" data-action="today-pending" style="margin-bottom:14px;padding:14px 16px;background:linear-gradient(135deg,#fee2e2 0%,#fecaca 100%);border:2px solid #dc2626;border-radius:12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:12px;color:#991b1b;font-weight:700;letter-spacing:0.5px;margin-bottom:2px">⚠️ 今日の未対応予約</div>
          <div style="font-size:24px;color:#991b1b;font-weight:900">${todayPending} <span style="font-size:13px;font-weight:600">件</span></div>
        </div>
        <div style="font-size:11px;color:#991b1b;font-weight:600">タップで確認 →</div>
      </div>
    ` : ''}

    <!-- メインメトリクス -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
      <div class="home-card" data-action="today" style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:12px 10px;cursor:pointer;transition:all 0.15s">
        <div style="font-size:10px;color:var(--text-sub);font-weight:600;letter-spacing:0.5px">📅 今日</div>
        <div style="font-size:22px;font-weight:800;color:#1d4ed8;margin-top:4px">${today.length}<span style="font-size:11px;color:var(--text-sub);margin-left:2px">件</span></div>
      </div>
      <div class="home-card" data-action="tomorrow" style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:12px 10px;cursor:pointer;transition:all 0.15s">
        <div style="font-size:10px;color:var(--text-sub);font-weight:600;letter-spacing:0.5px">🗓 明日</div>
        <div style="font-size:22px;font-weight:800;color:#7c3aed;margin-top:4px">${tomorrow.length}<span style="font-size:11px;color:var(--text-sub);margin-left:2px">件</span></div>
      </div>
      <div class="home-card" data-action="week" style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:12px 10px;cursor:pointer;transition:all 0.15s">
        <div style="font-size:10px;color:var(--text-sub);font-weight:600;letter-spacing:0.5px">📆 今週</div>
        <div style="font-size:22px;font-weight:800;color:#059669;margin-top:4px">${thisWeek.length}<span style="font-size:11px;color:var(--text-sub);margin-left:2px">件</span></div>
      </div>
      <div class="home-card" data-action="pending" style="background:#fff;border:1px solid #f59e0b;border-radius:12px;padding:12px 10px;cursor:pointer;transition:all 0.15s;background:#fffbeb">
        <div style="font-size:10px;color:#92400e;font-weight:600;letter-spacing:0.5px">⏳ 要対応</div>
        <div style="font-size:22px;font-weight:800;color:#b45309;margin-top:4px">${pending}<span style="font-size:11px;color:var(--text-sub);margin-left:2px">件</span></div>
      </div>
    </div>

    <!-- v273 期間分析: クイック選択 + カスタム範囲 + KPI -->
    <div style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap">
        <div style="font-size:13px;font-weight:700;color:#1a1a1a">📊 期間分析: <span style="color:#1d4ed8">${escapeHtml(rangeLabel)}</span></div>
        <div style="font-size:10px;color:var(--text-sub)">予約日基準 / 来院率=来院÷予約 / 決定率=成約÷来院</div>
      </div>
      <!-- 期間セレクター -->
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px;padding:8px;background:#f9fafb;border-radius:8px">
        <span style="font-size:11px;color:var(--text-sub);font-weight:600;letter-spacing:1px;margin-right:4px">期間</span>
        <button class="home-period-btn" data-preset="last" style="padding:5px 12px;font-size:11px;border:1px solid ${presetMatch('last')?'#1a1a1a':'var(--border)'};background:${presetMatch('last')?'#1a1a1a':'#fff'};color:${presetMatch('last')?'#fff':'#555'};border-radius:14px;cursor:pointer;font-weight:600;font-family:inherit">前月</button>
        <button class="home-period-btn" data-preset="this" style="padding:5px 12px;font-size:11px;border:1px solid ${presetMatch('this')?'#1a1a1a':'var(--border)'};background:${presetMatch('this')?'#1a1a1a':'#fff'};color:${presetMatch('this')?'#fff':'#555'};border-radius:14px;cursor:pointer;font-weight:600;font-family:inherit">今月</button>
        <button class="home-period-btn" data-preset="next" style="padding:5px 12px;font-size:11px;border:1px solid ${presetMatch('next')?'#1a1a1a':'var(--border)'};background:${presetMatch('next')?'#1a1a1a':'#fff'};color:${presetMatch('next')?'#fff':'#555'};border-radius:14px;cursor:pointer;font-weight:600;font-family:inherit">来月</button>
        <button class="home-period-btn" data-preset="3m" style="padding:5px 12px;font-size:11px;border:1px solid ${presetMatch('3m')?'#1a1a1a':'var(--border)'};background:${presetMatch('3m')?'#1a1a1a':'#fff'};color:${presetMatch('3m')?'#fff':'#555'};border-radius:14px;cursor:pointer;font-weight:600;font-family:inherit">前月〜来月</button>
        <span style="margin:0 4px;color:var(--text-sub)">|</span>
        <span style="font-size:11px;color:var(--text-sub)">カスタム:</span>
        <input type="month" id="home-from-month" value="${escapeHtml(monthInputValue(range.fromYM))}" style="font-size:11px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-family:inherit">
        <span style="font-size:11px;color:var(--text-sub)">〜</span>
        <input type="month" id="home-to-month" value="${escapeHtml(monthInputValue(range.toYM))}" style="font-size:11px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-family:inherit">
      </div>
      <!-- KPI 表示 (前期間比較付き) -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px">
        <div style="text-align:center;padding:10px;background:#f9fafb;border-radius:8px">
          <div style="font-size:10px;color:var(--text-sub);font-weight:600">予約</div>
          <div style="font-size:22px;font-weight:800;color:#1a1a1a">${kpiRange.booking}${fmtDelta(kpiRange.booking, kpiPrev.booking)}</div>
        </div>
        <div style="text-align:center;padding:10px;background:#eff6ff;border-radius:8px">
          <div style="font-size:10px;color:#1d4ed8;font-weight:600">来院</div>
          <div style="font-size:22px;font-weight:800;color:#1d4ed8">${kpiRange.visited}${fmtDelta(kpiRange.visited, kpiPrev.visited)}</div>
        </div>
        <div style="text-align:center;padding:10px;background:${kpiRange.visitRate>=70?'#dcfce7':kpiRange.visitRate>=50?'#fef3c7':'#fee2e2'};border-radius:8px">
          <div style="font-size:10px;color:${kpiRange.visitRate>=70?'#059669':kpiRange.visitRate>=50?'#d97706':'#dc2626'};font-weight:600">来院率</div>
          <div style="font-size:22px;font-weight:800;color:${kpiRange.visitRate>=70?'#059669':kpiRange.visitRate>=50?'#d97706':'#dc2626'}">${kpiRange.booking?kpiRange.visitRate+'%':'-'}${fmtDelta(kpiRange.visitRate, kpiPrev.visitRate)}</div>
        </div>
        <div style="text-align:center;padding:10px;background:#dcfce7;border-radius:8px">
          <div style="font-size:10px;color:#059669;font-weight:600">成約</div>
          <div style="font-size:22px;font-weight:800;color:#059669">${kpiRange.contracted}${fmtDelta(kpiRange.contracted, kpiPrev.contracted)}</div>
        </div>
        <div style="text-align:center;padding:10px;background:${kpiRange.decideRate>=40?'#dcfce7':kpiRange.decideRate>=20?'#fef3c7':'#fee2e2'};border-radius:8px">
          <div style="font-size:10px;color:${kpiRange.decideRate>=40?'#059669':kpiRange.decideRate>=20?'#d97706':'#dc2626'};font-weight:600">決定率</div>
          <div style="font-size:22px;font-weight:800;color:${kpiRange.decideRate>=40?'#059669':kpiRange.decideRate>=20?'#d97706':'#dc2626'}">${kpiRange.visited?kpiRange.decideRate+'%':'-'}${fmtDelta(kpiRange.decideRate, kpiPrev.decideRate)}</div>
        </div>
        <div style="text-align:center;padding:10px;background:#ecfeff;border-radius:8px">
          <div style="font-size:10px;color:#0891b2;font-weight:600">成約単価</div>
          <div style="font-size:18px;font-weight:800;color:#0e7490">${kpiRange.unitPrice?fmtYen(kpiRange.unitPrice):'-'}${fmtDelta(kpiRange.unitPrice, kpiPrev.unitPrice)}</div>
        </div>
        <div style="text-align:center;padding:10px;background:#ecfeff;border-radius:8px">
          <div style="font-size:10px;color:#0891b2;font-weight:600">合計金額</div>
          <div style="font-size:18px;font-weight:800;color:#0e7490">${fmtYen(kpiRange.amount)}${fmtDelta(kpiRange.amount, kpiPrev.amount)}</div>
        </div>
      </div>
      <div style="margin-top:6px;font-size:10px;color:var(--text-sub)">前期間比較: ${escapeHtml(prevFromYM === prevToYM ? ymToLabel(prevFromYM) : ymToLabel(prevFromYM)+'〜'+ymToLabel(prevToYM))}</div>
      ${weekCancel > 0 ? `<div style="margin-top:8px;font-size:11px;color:#dc2626">🚫 今週キャンセル ${weekCancel}件</div>` : ''}
    </div>

    <!-- v273: 選択期間の医院別 / 治療別 サマリー (来院タブと同じカード形式) -->
    ${facList.length > 0 ? `
      <!-- 医院別 -->
      <div style="margin-bottom:14px">
        <div style="font-size:13px;font-weight:700;color:#1a1a1a;margin-bottom:10px;display:flex;align-items:center;gap:6px">🏥 ${escapeHtml(rangeLabel)} 医院別</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
          ${facList.map(f => {
            const v = byFacMonth[f];
            const visitRate = v.booking ? Math.round(v.visited/v.booking*100) : 0;
            const decideRate = v.visited ? Math.round(v.contracted/v.visited*100) : 0;
            const amt = rangeRows.filter(d => normFac(d.facility) === f && d.status === '成約').reduce((s,d)=>s+Number(d.contractAmount||0),0);
            return `<div style="border:1px solid var(--border);border-radius:10px;padding:14px;background:#fff;transition:all .15s" onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,.08)';this.style.borderColor='#1d4ed8'" onmouseout="this.style.boxShadow='';this.style.borderColor='var(--border)'">
              <div style="font-size:13px;font-weight:700;margin-bottom:8px;color:var(--text)">${escapeHtml(f)}</div>
              <div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap">
                <div><span style="font-size:22px;font-weight:700;color:#1a1a1a">${v.booking}</span><span style="font-size:11px;color:var(--text-sub);margin-left:3px">件</span></div>
                <div style="font-size:11px;color:var(--text-sub)">来院 <span style="color:#1d4ed8;font-weight:700">${v.visited}</span> <span style="color:${visitRate>=70?'#059669':visitRate>=50?'#d97706':'#dc2626'}">(${visitRate}%)</span></div>
                <div style="font-size:11px;color:var(--text-sub)">成約 <span style="color:#059669;font-weight:700">${v.contracted}</span> <span style="color:${decideRate>=40?'#059669':decideRate>=20?'#d97706':'#dc2626'}">(${decideRate}%)</span></div>
                ${amt > 0 ? `<div style="font-size:11px;color:#0e7490;font-weight:700">${fmtYen(amt)}</div>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
      <!-- 治療別 -->
      <div style="margin-bottom:14px">
        <div style="font-size:13px;font-weight:700;color:#1a1a1a;margin-bottom:10px;display:flex;align-items:center;gap:6px">🦷 ${escapeHtml(rangeLabel)} 治療別</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
          ${treatList.map(t => {
            const v = byTreatMonth[t];
            const visitRate = v.booking ? Math.round(v.visited/v.booking*100) : 0;
            const decideRate = v.visited ? Math.round(v.contracted/v.visited*100) : 0;
            const amt = rangeRows.filter(d => (normSvc(d.service)||'-') === t && d.status === '成約').reduce((s,d)=>s+Number(d.contractAmount||0),0);
            return `<div style="border:1px solid var(--border);border-radius:10px;padding:14px;background:#fff;transition:all .15s" onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,.08)';this.style.borderColor='#059669'" onmouseout="this.style.boxShadow='';this.style.borderColor='var(--border)'">
              <div style="font-size:13px;font-weight:700;margin-bottom:8px;color:var(--text)">${escapeHtml(t)}</div>
              <div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap">
                <div><span style="font-size:22px;font-weight:700;color:#1a1a1a">${v.booking}</span><span style="font-size:11px;color:var(--text-sub);margin-left:3px">件</span></div>
                <div style="font-size:11px;color:var(--text-sub)">来院 <span style="color:#1d4ed8;font-weight:700">${v.visited}</span> <span style="color:${visitRate>=70?'#059669':visitRate>=50?'#d97706':'#dc2626'}">(${visitRate}%)</span></div>
                <div style="font-size:11px;color:var(--text-sub)">成約 <span style="color:#059669;font-weight:700">${v.contracted}</span> <span style="color:${decideRate>=40?'#059669':decideRate>=20?'#d97706':'#dc2626'}">(${decideRate}%)</span></div>
                ${amt > 0 ? `<div style="font-size:11px;color:#0e7490;font-weight:700">${fmtYen(amt)}</div>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
    ` : ''}

    <!-- v273: 時間帯別予約分布 (バーチャート) -->
    ${rangeRows.length > 0 ? `
      <div style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:14px">
        <div style="font-size:13px;font-weight:700;color:#1a1a1a;margin-bottom:10px">⏰ ${escapeHtml(rangeLabel)} 時間帯別 予約分布
          ${maxHour > 0 ? `<span style="font-size:11px;color:var(--text-sub);font-weight:500;margin-left:8px">ピーク: ${hourPeak}時 (${maxHour}件)</span>` : ''}
        </div>
        <div style="display:flex;gap:2px;align-items:flex-end;height:100px">
          ${byHour.slice(7, 21).map((count, idx) => {
            const hour = 7 + idx;
            const pct = maxHour > 0 ? (count / maxHour * 100) : 0;
            const isPeak = count === maxHour && count > 0;
            return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;cursor:default" title="${hour}時: ${count}件">
              <div style="font-size:9px;color:${count>0?'#1a1a1a':'transparent'};font-weight:600;margin-bottom:2px">${count||''}</div>
              <div style="width:100%;height:${pct}%;min-height:${count>0?'4px':'0'};background:${isPeak?'#1d4ed8':count>0?'#93c5fd':'transparent'};border-radius:3px 3px 0 0;transition:height .3s"></div>
              <div style="font-size:9px;color:var(--text-sub);margin-top:3px">${hour}</div>
            </div>`;
          }).join('')}
        </div>
        <div style="font-size:9px;color:var(--text-sub);text-align:center;margin-top:4px">時間帯 (7時〜20時)</div>
      </div>
    ` : ''}

    <!-- v273: 医院 × 治療 クロス集計 (個人名は出さず数字のみ) -->
    ${facList.length > 0 && treatList.length > 0 ? (() => {
      // 各医院 × 各治療 の予約 / 来院 / 成約 件数
      const cross = {};
      rangeRows.forEach(d => {
        const f = normFac(d.facility) || '-';
        const t = (typeof normSvc === 'function' ? normSvc(d.service) : d.service) || '-';
        const key = f + '|' + t;
        if (!cross[key]) cross[key] = { booking:0, visited:0, contracted:0 };
        cross[key].booking++;
        if (isVisited(d.status)) cross[key].visited++;
        if (d.status === '成約') cross[key].contracted++;
      });
      const cellHtml = (f, t) => {
        const v = cross[f + '|' + t];
        if (!v || v.booking === 0) return '<span style="color:#cbd5e1">-</span>';
        return `<div style="line-height:1.3">
          <div style="font-size:13px;font-weight:700;color:#1a1a1a">${v.booking}</div>
          <div style="font-size:9px;color:var(--text-sub)">来 <span style="color:#1d4ed8;font-weight:600">${v.visited}</span> / 約 <span style="color:#059669;font-weight:600">${v.contracted}</span></div>
        </div>`;
      };
      // 行/列の合計
      const colTotal = (t) => {
        const r = { booking:0, visited:0, contracted:0 };
        facList.forEach(f => {
          const v = cross[f + '|' + t];
          if (v) { r.booking+=v.booking; r.visited+=v.visited; r.contracted+=v.contracted; }
        });
        return r;
      };
      const rowTotal = (f) => {
        const r = { booking:0, visited:0, contracted:0 };
        treatList.forEach(t => {
          const v = cross[f + '|' + t];
          if (v) { r.booking+=v.booking; r.visited+=v.visited; r.contracted+=v.contracted; }
        });
        return r;
      };
      return `<div style="margin-bottom:14px">
        <div style="font-size:13px;font-weight:700;color:#1a1a1a;margin-bottom:10px;display:flex;align-items:center;gap:6px">📋 ${escapeHtml(rangeLabel)} 医院 × 治療 クロス集計</div>
        <div style="background:#fff;border:1px solid var(--border);border-radius:10px;overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:11px;min-width:560px">
            <thead>
              <tr style="background:#f9fafb">
                <th style="padding:8px;text-align:left;font-size:10px;color:var(--text-sub);font-weight:700;letter-spacing:1px;border-bottom:1px solid var(--border);position:sticky;left:0;background:#f9fafb">医院＼治療</th>
                ${treatList.map(t => `<th style="padding:8px;text-align:center;font-size:10px;color:var(--text-sub);font-weight:700;letter-spacing:1px;border-bottom:1px solid var(--border);min-width:70px">${escapeHtml(t)}</th>`).join('')}
                <th style="padding:8px;text-align:center;font-size:10px;color:#1a1a1a;font-weight:700;letter-spacing:1px;border-bottom:1px solid var(--border);background:#f3f4f6;min-width:70px">合計</th>
              </tr>
            </thead>
            <tbody>
              ${facList.map(f => {
                const tot = rowTotal(f);
                return `<tr style="border-top:1px solid #f3f4f6">
                  <td style="padding:8px;text-align:left;font-weight:600;background:#fff;position:sticky;left:0">${escapeHtml(f)}</td>
                  ${treatList.map(t => `<td style="padding:6px;text-align:center;border-left:1px solid #f3f4f6">${cellHtml(f, t)}</td>`).join('')}
                  <td style="padding:8px;text-align:center;background:#f9fafb;font-weight:700;color:#1a1a1a">
                    <div style="font-size:14px">${tot.booking}</div>
                    <div style="font-size:9px;color:var(--text-sub)">来 <span style="color:#1d4ed8">${tot.visited}</span>/約 <span style="color:#059669">${tot.contracted}</span></div>
                  </td>
                </tr>`;
              }).join('')}
              <!-- 列合計 -->
              <tr style="border-top:2px solid #d1d5db;background:#f9fafb;font-weight:700">
                <td style="padding:8px;background:#f3f4f6;color:#1a1a1a;position:sticky;left:0">合計</td>
                ${treatList.map(t => {
                  const tot = colTotal(t);
                  return `<td style="padding:6px;text-align:center;border-left:1px solid #f3f4f6">
                    <div style="font-size:14px;color:#1a1a1a">${tot.booking}</div>
                    <div style="font-size:9px;color:var(--text-sub)">来 <span style="color:#1d4ed8">${tot.visited}</span>/約 <span style="color:#059669">${tot.contracted}</span></div>
                  </td>`;
                }).join('')}
                <td style="padding:8px;text-align:center;background:#dbeafe;font-weight:700;color:#1d4ed8">
                  <div style="font-size:15px">${kpiRange.booking}</div>
                  <div style="font-size:9px">来 ${kpiRange.visited} / 約 ${kpiRange.contracted}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style="font-size:10px;color:var(--text-sub);margin-top:6px">※ 数字: 予約件数 / 「来N/約N」: 来院数・成約数</div>
      </div>`;
    })() : ''}

    <!-- ショートカット -->
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">
      <button class="home-shortcut" data-view="bookings" data-sub="bk-phone" style="padding:14px;background:linear-gradient(135deg,#fef3c7 0%,#fde68a 100%);border:1.5px solid #f59e0b;border-radius:12px;cursor:pointer;text-align:left;font-size:13px;font-weight:700;color:#b45309">📞 電話前確認へ</button>
      <button class="home-shortcut" data-view="bookings" data-sub="bk-list" style="padding:14px;background:#fff;border:1px solid var(--border);border-radius:12px;cursor:pointer;text-align:left;font-size:13px;font-weight:600;color:#1a1a1a">📋 予約一覧へ</button>
      <button class="home-shortcut" data-view="kaiin" style="padding:14px;background:#fff;border:1px solid var(--border);border-radius:12px;cursor:pointer;text-align:left;font-size:13px;font-weight:600;color:#1a1a1a">🏥 来院管理へ</button>
      <button class="home-shortcut" data-view="tc" style="padding:14px;background:#fff;border:1px solid var(--border);border-radius:12px;cursor:pointer;text-align:left;font-size:13px;font-weight:600;color:#1a1a1a">💬 TCへ</button>
    </div>
  `;

  // インタラクション
  el.querySelectorAll('.home-card, .home-alert').forEach(c => {
    c.addEventListener('click', () => {
      const action = c.dataset.action;
      switchBookingSub('bk-list');
      setTimeout(() => {
        if (action === 'today' || action === 'today-pending') {
          document.getElementById('bk-today-btn')?.click();
        } else if (action === 'pending') {
          const card = document.querySelector('[data-st="pending"]');
          if (card) card.click();
        }
      }, 100);
    });
  });
  el.querySelectorAll('.home-shortcut').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.view;
      const s = btn.dataset.sub;
      try { switchView(v); } catch(_){}
      if (s) setTimeout(() => switchBookingSub(s), 120);
    });
  });
  el.querySelectorAll('.home-link-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchBookingSub('bk-list');
      setTimeout(() => document.getElementById('bk-today-btn')?.click(), 100);
    });
  });
  // v273: 期間プリセットボタン
  el.querySelectorAll('.home-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      if (preset === 'last') _homeAnalysisRange = { fromYM: ymOffset(-1), toYM: ymOffset(-1), label: '前月' };
      else if (preset === 'this') _homeAnalysisRange = { fromYM: ymOffset(0), toYM: ymOffset(0), label: '今月' };
      else if (preset === 'next') _homeAnalysisRange = { fromYM: ymOffset(1), toYM: ymOffset(1), label: '来月' };
      else if (preset === '3m') _homeAnalysisRange = { fromYM: ymOffset(-1), toYM: ymOffset(1), label: '前月〜来月' };
      _saveHomeRange();
      renderHomeDashboard();
    });
  });
  // カスタム期間 (input type=month) の変更
  const fromEl = el.querySelector('#home-from-month');
  const toEl = el.querySelector('#home-to-month');
  const onCustomChange = () => {
    const f = (fromEl?.value || '').replace('-', '/');
    const t = (toEl?.value || '').replace('-', '/');
    if (f && t) {
      // 開始 > 終了なら入れ替え
      const [from, to] = f <= t ? [f, t] : [t, f];
      _homeAnalysisRange = { fromYM: from, toYM: to, label: null };
      _saveHomeRange();
      renderHomeDashboard();
    }
  };
  fromEl?.addEventListener('change', onCustomChange);
  toEl?.addEventListener('change', onCustomChange);
}
function switchBookingSub(subId) {
  const btn = document.querySelector(`#bk-sub-nav .sub-nav-btn[data-sub="${subId}"]`);
  if (btn) btn.click();
}

// === v262 電話前確認タブ ===
// v273: sessionStorage で状態永続化 (リロード/タブ切替で消えない)
let _phoneCheckState = (() => {
  try {
    const saved = JSON.parse(sessionStorage.getItem('phone-check-state') || 'null');
    if (saved && typeof saved === 'object') {
      return Object.assign({
        period: 'all_future',
        facilities: [],
        showCalled: true,
      }, saved);
    }
  } catch(_) {}
  return {
    period: 'all_future',
    facilities: [],
    showCalled: true,
  };
})();
function _savePhoneCheckState() {
  try { sessionStorage.setItem('phone-check-state', JSON.stringify(_phoneCheckState)); } catch(_){}
}

// v273: 既存の memo-modal close 検知用 setInterval をモジュールレベルで管理 (スタック防止)
let _phoneMemoModalCheckInterval = null;

function renderPhoneCheck() {
  const el = document.getElementById('phone-check-content');
  if (!el) return;
  // Bug fix: 再描画でスクロール位置がリセットされる問題 → 保存して復元
  const _scrollY = window.scrollY;

  // Bug fix: parseDate は YYYY-MM-DD 形式のみ。短縮形式は parseDateLoose を使う
  const _parseDateLoose = parseDateLoose;

  const data = Array.isArray(bookingsData) ? (getFilteredBookingsData ? getFilteredBookingsData() : bookingsData) : [];
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
  const todayEnd = new Date(now); todayEnd.setHours(23,59,59,999);
  const tomorrowStart = new Date(todayEnd.getTime() + 1);
  const tomorrowEnd = new Date(todayEnd.getTime() + 24*3600*1000);

  // フィルタ条件
  // v273: 今日中の過ぎた時刻も含めて表示 / all_future = 今日以降すべて
  const isInPeriod = (bd) => {
    if (!bd) return false;
    if (_phoneCheckState.period === 'today') return bd >= todayStart && bd <= todayEnd;
    if (_phoneCheckState.period === 'tomorrow') return bd >= tomorrowStart && bd <= tomorrowEnd;
    if (_phoneCheckState.period === 'all_future') return bd >= todayStart;  // 今日以降すべて
    return bd >= todayStart && bd <= tomorrowEnd;
  };
  const facSet = new Set(_phoneCheckState.facilities || []);

  let rows = data.filter(d => {
    if (d.status === '除外' || d.status === 'キャンセル') return false;
    const bd = _parseDateLoose(d.bookDate);  // Bug fix: 短縮形式対応
    if (!isInPeriod(bd)) return false;
    // 医院フィルタ (空配列なら全医院)
    if (facSet.size > 0 && !facSet.has(normFac(d.facility))) return false;
    if (!_phoneCheckState.showCalled && (d.status === '確認済' || d.status === '来院済' || d.status === '成約')) return false;
    // v273: 統計バッジ絞り込み
    if (_phoneCheckState.statusFilter) {
      const sf = _phoneCheckState.statusFilter;
      if (sf === '未対応') {
        if (d.status && d.status !== '未対応') return false;
      } else {
        if (d.status !== sf) return false;
      }
    }
    return true;
  });

  // v273: 登録日時 (applyDate) の降順 / 同登録日なら予約日時 (bookDate) 昇順
  // (Bug fix: 文字列比較だと "5/30" < "5/7" になるため Date オブジェクトで比較、短縮形式対応)
  const _toDateTime = (s) => {
    const d = _parseDateLoose(s);
    if (!d) return 0;
    const tm = String(s).match(/(\d{1,2}):(\d{2})/);
    if (tm) d.setHours(parseInt(tm[1], 10), parseInt(tm[2], 10));
    return d.getTime();
  };
  rows.sort((a,b) => {
    const adA = _toDateTime(a.applyDate);
    const adB = _toDateTime(b.applyDate);
    if (adA !== adB) return adB - adA; // applyDate DESC
    return _toDateTime(a.bookDate) - _toDateTime(b.bookDate); // bookDate ASC
  });

  // 医院リスト作成
  const allFacs = [...new Set(data.map(d => normFac(d.facility)).filter(f => f && f !== '-'))].sort();
  const stats = {
    total: rows.length,
    pending: rows.filter(d => !d.status || d.status === '未対応').length,
    rusu:  rows.filter(d => d.status === '留守電').length,
    cb:    rows.filter(d => d.status === '折り返し').length,
  };

  const canViewPII = !_isPII_MaskNeeded();
  const memos = loadData('bk-memos', {});

  el.innerHTML = `
    <!-- ヘッダー -->
    <div style="margin-bottom:12px">
      <h2 style="font-size:17px;font-weight:700;color:#1a1a1a;margin-bottom:4px">📞 電話前確認</h2>
      <p style="font-size:11px;color:var(--text-sub);margin:0">今日・明日の予約を優先度順に整理。電話後はステータス・メモを即更新。</p>
    </div>

    <!-- 統計バッジ (クリックで該当ステータスのみ絞り込み) -->
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      <button class="phone-stat-btn" data-stat="all"     style="padding:6px 12px;background:${!_phoneCheckState.statusFilter?'#1a1a1a':'#fef3c7'};color:${!_phoneCheckState.statusFilter?'#fff':'#b45309'};border:1px solid ${!_phoneCheckState.statusFilter?'#1a1a1a':'transparent'};border-radius:14px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">対象 ${stats.total}件</button>
      <button class="phone-stat-btn" data-stat="未対応"   style="padding:6px 12px;background:${_phoneCheckState.statusFilter==='未対応'?'#dc2626':'#fee2e2'};color:${_phoneCheckState.statusFilter==='未対応'?'#fff':'#dc2626'};border:1px solid ${_phoneCheckState.statusFilter==='未対応'?'#dc2626':'transparent'};border-radius:14px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">未対応 ${stats.pending}件</button>
      <button class="phone-stat-btn" data-stat="留守電"   style="padding:6px 12px;background:${_phoneCheckState.statusFilter==='留守電'?'#92400e':'#fef3c7'};color:${_phoneCheckState.statusFilter==='留守電'?'#fff':'#92400e'};border:1px solid ${_phoneCheckState.statusFilter==='留守電'?'#92400e':'transparent'};border-radius:14px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">留守電 ${stats.rusu}件</button>
      <button class="phone-stat-btn" data-stat="折り返し" style="padding:6px 12px;background:${_phoneCheckState.statusFilter==='折り返し'?'#7c3aed':'#f5f3ff'};color:${_phoneCheckState.statusFilter==='折り返し'?'#fff':'#7c3aed'};border:1px solid ${_phoneCheckState.statusFilter==='折り返し'?'#7c3aed':'transparent'};border-radius:14px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">折り返し ${stats.cb}件</button>
    </div>

    <!-- フィルタ -->
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;padding:10px;background:#fff;border:1px solid var(--border);border-radius:10px">
      <!-- 期間 -->
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span style="font-size:11px;color:var(--text-sub);font-weight:600;letter-spacing:1px;width:50px">期間</span>
        <div style="display:inline-flex;background:#f3f4f6;border-radius:8px;padding:2px;flex-wrap:wrap">
          <button type="button" class="phone-period-btn" data-period="today" style="padding:6px 14px;font-size:12px;border:none;background:${_phoneCheckState.period==='today'?'#1a1a1a':'transparent'};color:${_phoneCheckState.period==='today'?'#fff':'#555'};border-radius:6px;cursor:pointer;font-weight:600;font-family:inherit">今日</button>
          <button type="button" class="phone-period-btn" data-period="tomorrow" style="padding:6px 14px;font-size:12px;border:none;background:${_phoneCheckState.period==='tomorrow'?'#1a1a1a':'transparent'};color:${_phoneCheckState.period==='tomorrow'?'#fff':'#555'};border-radius:6px;cursor:pointer;font-weight:600;font-family:inherit">明日</button>
          <button type="button" class="phone-period-btn" data-period="today_tomorrow" style="padding:6px 14px;font-size:12px;border:none;background:${_phoneCheckState.period==='today_tomorrow'?'#1a1a1a':'transparent'};color:${_phoneCheckState.period==='today_tomorrow'?'#fff':'#555'};border-radius:6px;cursor:pointer;font-weight:600;font-family:inherit">両方</button>
          <button type="button" class="phone-period-btn" data-period="all_future" style="padding:6px 14px;font-size:12px;border:none;background:${_phoneCheckState.period==='all_future'?'#1a1a1a':'transparent'};color:${_phoneCheckState.period==='all_future'?'#fff':'#555'};border-radius:6px;cursor:pointer;font-weight:600;font-family:inherit">未来全部</button>
        </div>
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#555;cursor:pointer;margin-left:auto">
          <input type="checkbox" id="phone-show-called" ${_phoneCheckState.showCalled?'checked':''}>
          確認済も表示
        </label>
      </div>
      <!-- 医院 (複数選択) -->
      <div style="display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap">
        <span style="font-size:11px;color:var(--text-sub);font-weight:600;letter-spacing:1px;width:50px;padding-top:4px">医院</span>
        <div style="display:flex;gap:4px;flex-wrap:wrap;flex:1">
          <button type="button" class="phone-fac-btn" data-fac=""    style="padding:4px 10px;font-size:11px;border:1px solid ${_phoneCheckState.facilities.length===0?'#1a1a1a':'var(--border)'};background:${_phoneCheckState.facilities.length===0?'#1a1a1a':'#fff'};color:${_phoneCheckState.facilities.length===0?'#fff':'#555'};border-radius:14px;cursor:pointer;font-weight:600;font-family:inherit">全医院</button>
          ${allFacs.map(f => {
            const sel = facSet.has(f);
            return `<button type="button" class="phone-fac-btn" data-fac="${escapeHtml(f)}" style="padding:4px 10px;font-size:11px;border:1px solid ${sel?'#1a1a1a':'var(--border)'};background:${sel?'#1a1a1a':'#fff'};color:${sel?'#fff':'#555'};border-radius:14px;cursor:pointer;font-weight:600;font-family:inherit">${escapeHtml(f)}</button>`;
          }).join('')}
        </div>
      </div>
    </div>

    <!-- リスト (v273 テーブル形式) -->
    ${rows.length === 0 ? `
      <div style="text-align:center;padding:50px 20px;background:#f9fafb;border-radius:12px;color:var(--text-sub)">
        <div style="font-size:40px;margin-bottom:10px">📞✨</div>
        <div style="font-size:14px;font-weight:600;color:#1a1a1a">対象の予約はありません</div>
        <div style="font-size:11px;margin-top:4px">すべて確認済、またはフィルタ条件を確認してください</div>
      </div>
    ` : `
      <div style="background:#fff;border:1px solid var(--border);border-radius:10px;overflow:hidden;overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:920px;table-layout:fixed">
          <colgroup>
            <col style="width:54px">    <!-- 登録日 (05/01) -->
            <col style="width:100px">   <!-- 予約日時 (05/23 11:30) ← 切れ防止 -->
            <col style="width:120px">   <!-- 名前 -->
            <col style="width:80px">    <!-- 施術名 (ゼロベニア初 等) -->
            <col style="width:65px">    <!-- 医院 -->
            <col style="width:135px">   <!-- 連絡先 (📞 + 11桁) -->
            <col style="width:115px">   <!-- プロモ -->
            <col style="width:70px">    <!-- 状況 -->
            <col>                       <!-- メモ (残り全部) -->
            <col style="width:180px">   <!-- アクション -->
          </colgroup>
          <thead>
            <tr style="background:#f9fafb">
              <th style="padding:6px 8px;text-align:left;font-size:10px;color:var(--text-sub);font-weight:700;letter-spacing:1px;border-bottom:1px solid var(--border)">登録日</th>
              <th style="padding:6px 8px;text-align:left;font-size:10px;color:var(--text-sub);font-weight:700;letter-spacing:1px;border-bottom:1px solid var(--border)">予約日時</th>
              <th style="padding:6px 8px;text-align:left;font-size:10px;color:var(--text-sub);font-weight:700;letter-spacing:1px;border-bottom:1px solid var(--border)">名前</th>
              <th style="padding:6px 8px;text-align:left;font-size:10px;color:var(--text-sub);font-weight:700;letter-spacing:1px;border-bottom:1px solid var(--border)">施術名</th>
              <th style="padding:6px 8px;text-align:left;font-size:10px;color:var(--text-sub);font-weight:700;letter-spacing:1px;border-bottom:1px solid var(--border)">医院</th>
              <th style="padding:6px 8px;text-align:left;font-size:10px;color:var(--text-sub);font-weight:700;letter-spacing:1px;border-bottom:1px solid var(--border)">連絡先</th>
              <th style="padding:6px 8px;text-align:left;font-size:10px;color:var(--text-sub);font-weight:700;letter-spacing:1px;border-bottom:1px solid var(--border)">プロモ</th>
              <th style="padding:6px 8px;text-align:left;font-size:10px;color:var(--text-sub);font-weight:700;letter-spacing:1px;border-bottom:1px solid var(--border)">状況</th>
              <th style="padding:6px 8px;text-align:left;font-size:10px;color:var(--text-sub);font-weight:700;letter-spacing:1px;border-bottom:1px solid var(--border)">メモ</th>
              <th style="padding:6px 8px;text-align:left;font-size:10px;color:var(--text-sub);font-weight:700;letter-spacing:1px;border-bottom:1px solid var(--border)">アクション</th>
            </tr>
          </thead>
          <tbody id="phone-tbody">
            ${rows.map(d => _renderPhoneCheckRow(d, canViewPII, memos)).join('')}
          </tbody>
        </table>
      </div>
    `}
  `;

  // イベントバインド
  el.querySelectorAll('.phone-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _phoneCheckState.period = btn.dataset.period;
      _savePhoneCheckState();
      renderPhoneCheck();
    });
  });
  // v273: 医院複数選択 (チップトグル)
  el.querySelectorAll('.phone-fac-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const fac = btn.dataset.fac;
      if (!fac) {
        // 「全医院」クリック → 選択をクリア
        _phoneCheckState.facilities = [];
      } else {
        const idx = _phoneCheckState.facilities.indexOf(fac);
        if (idx >= 0) {
          _phoneCheckState.facilities.splice(idx, 1);
        } else {
          _phoneCheckState.facilities.push(fac);
        }
      }
      _savePhoneCheckState();
      renderPhoneCheck();
    });
  });
  el.querySelector('#phone-show-called')?.addEventListener('change', e => {
    _phoneCheckState.showCalled = e.target.checked;
    _savePhoneCheckState();
    renderPhoneCheck();
  });
  // v273: 統計バッジクリックで絞り込み
  el.querySelectorAll('.phone-stat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = btn.dataset.stat;
      if (s === 'all' || _phoneCheckState.statusFilter === s) {
        delete _phoneCheckState.statusFilter;
      } else {
        _phoneCheckState.statusFilter = s;
      }
      _savePhoneCheckState();
      renderPhoneCheck();
    });
  });

  _bindPhoneCheckRowEvents(el);
  // スクロール位置を復元 (rAF で次フレーム後)
  requestAnimationFrame(() => window.scrollTo(0, _scrollY));
}

// v273: テーブル行 (登録日 / 予約日時 / 名前 / 医院 / 連絡先 / 状況 / アクション)
function _renderPhoneCheckRow(d, canViewPII, memos) {
  const key = d.name + '|' + d.applyDate;
  // メモ取得: この予約専用のメモのみ表示 (削除しても他の予約から復活しないように)
  // findAnyMemo は名前ベースで全予約を横断検索するため、一つを消しても他から復活する問題があった
  const memo = (memos[key] || d._memo || '');
  // 共通フォーマッタ: Date→MM/DD (登録日・予約日で統一)
  const fmtMD = (date) => {
    if (!date || isNaN(date.getTime())) return '';
    return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
  };
  // 予約日 (parseDateLoose で短縮形式対応、時刻は別途抽出)
  const bdDate = parseDateLoose(d.bookDate);
  const bdStr = fmtMD(bdDate);
  const tm = (d.bookDate || '').match(/(\d{1,2}):(\d{2})/);
  const tstr = tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : '--:--';
  // 登録日
  const adDate = parseDateLoose(d.applyDate);
  const adStr = fmtMD(adDate);
  // ステータス色 (Bug fix: 全ステータス網羅、未網羅は灰色 default で 未対応 を上書きしないように)
  const st = d.status || '未対応';
  const stColors = {
    '未対応':         { bg:'#fee2e2', fg:'#dc2626' },
    '確認済':         { bg:'#dbeafe', fg:'#1d4ed8' },
    '留守電':         { bg:'#fef3c7', fg:'#92400e' },
    '折り返し':       { bg:'#f5f3ff', fg:'#7c3aed' },
    '後追いLINE済み': { bg:'#ecfeff', fg:'#0891b2' },
    '予約連絡待ち':   { bg:'#f5f3ff', fg:'#7c3aed' },
    '予約変更':       { bg:'#fef3c7', fg:'#b45309' },
    '来院済':         { bg:'#dbeafe', fg:'#1d4ed8' },
    '成約':           { bg:'#dcfce7', fg:'#15803d' },
    '検討中':         { bg:'#fef3c7', fg:'#b45309' },
    'P処置':          { bg:'#ccfbf1', fg:'#0f766e' },
    'C処置':          { bg:'#ccfbf1', fg:'#0d9488' },
    'CT/診断':        { bg:'#dbeafe', fg:'#3b82f6' },
    'ガイド印象':     { bg:'#cffafe', fg:'#0891b2' },
    '手術予定':       { bg:'#dbeafe', fg:'#2563eb' },
    '治癒期間':       { bg:'#dbeafe', fg:'#1d4ed8' },
    '印象':           { bg:'#cffafe', fg:'#0891b2' },
    'セット':         { bg:'#cffafe', fg:'#0e7490' },
    '完了':           { bg:'#dcfce7', fg:'#059669' },
    'キャンセル':     { bg:'#fee2e2', fg:'#dc2626' },
    'お断り':         { bg:'#f5f5f4', fg:'#78716c' },
    '除外':           { bg:'#f3f4f6', fg:'#9ca3af' },
  };
  const stClr = stColors[st] || { bg:'#f3f4f6', fg:'#6b7280' };
  const name = canViewPII ? d.name : maskName(d.name);
  const phone = canViewPII ? (d.phone ? (String(d.phone).startsWith('0') ? d.phone : '0'+d.phone) : '') : maskPhone(d.phone);
  const fac = normFac(d.facility);
  const phoneDigits = phone ? phone.replace(/[^0-9]/g,'') : '';
  // メモセル (来院タブと同じスタイル: クリックで編集モーダル、黄色ハイライト)
  // 表 layout:fixed なので幅は colgroup で制御。残り全部の幅を取る
  const memoCellHtml = `<td class="phone-memo-cell" data-name="${escapeHtml(d.name)}" data-apply="${escapeHtml(d.applyDate)}" style="cursor:pointer;padding:4px 8px;font-size:11px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:${memo?'#fff8e1':'transparent'};border:1px dashed ${memo?'#f9a825':'var(--border)'};border-radius:4px" title="${escapeHtml(memo)}">${memo ? escapeHtml(_flattenMemoForDisplay(memo, 200)) : '<span style="color:var(--text-muted)">+ メモ</span>'}</td>`;

  return `<tr class="phone-row" data-name="${escapeHtml(d.name)}" data-apply="${escapeHtml(d.applyDate)}" style="border-bottom:1px solid var(--border)">
    <td style="padding:5px 8px;font-size:11px;color:var(--text-sub);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${adStr}</td>
    <td style="padding:5px 8px;font-size:12px;font-weight:700;color:#1d4ed8;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span style="color:var(--text-sub);font-weight:500">${bdStr}</span> ${tstr}</td>
    <td style="padding:5px 8px;font-size:13px;font-weight:700;color:#1a1a1a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(name || '')}">${escapeHtml(name || '')}</td>
    <td style="padding:5px 8px;font-size:11px;color:var(--text-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(normSvc(d.service) || '-')}</td>
    <td style="padding:5px 8px;font-size:11px;color:var(--text-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(fac)}</td>
    <td style="padding:5px 8px;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${canViewPII && phone ? `<a href="tel:${phoneDigits}" style="display:inline-flex;align-items:center;gap:3px;padding:3px 7px;background:#dcfce7;color:#15803d;border-radius:5px;font-weight:700;text-decoration:none">📞 ${escapeHtml(phone)}</a>` : '<span style="color:#9ca3af">-</span>'}</td>
    <td style="padding:5px 8px;font-size:10px;color:var(--text-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(d.source || '')}">${d.source ? `<span style="display:inline-block;padding:2px 7px;background:#e0f2fe;color:#0369a1;border-radius:10px;font-size:10px;font-weight:600;border:1px solid #bae6fd">${escapeHtml(d.source.length>14 ? d.source.slice(0,14)+'…' : d.source)}</span>` : '<span style="color:#9ca3af">-</span>'}</td>
    <td style="padding:5px 8px;text-align:left"><span style="padding:2px 8px;border-radius:5px;font-size:10px;font-weight:700;background:${stClr.bg};color:${stClr.fg};white-space:nowrap">${st}</span></td>
    ${memoCellHtml}
    <td style="padding:6px 10px;text-align:left;white-space:nowrap">
      ${_phoneStatusBtn('確認済',   '✅', '確認済',     '#dbeafe', '#1d4ed8', '#bfdbfe', st)}
      ${_phoneStatusBtn('留守電',   '🎤', '留守電',     '#fef3c7', '#92400e', '#fcd34d', st)}
      ${_phoneStatusBtn('折り返し', '↩',  '折り返し',   '#f5f3ff', '#7c3aed', '#d8b4fe', st)}
      ${_phoneStatusBtn('未対応',   '↻',  '取り消し (未対応に戻す)', '#f3f4f6', '#6b7280', '#e5e7eb', st)}
    </td>
  </tr>`;
}

// v273: 状況ボタンのレンダリング (現在のステータスはハイライト表示)
function _phoneStatusBtn(targetSt, icon, title, bg, fg, border, currentSt) {
  const isActive = currentSt === targetSt;
  // アクティブ時は色反転 (背景=fg, 文字=白)、非アクティブは通常
  const style = isActive
    ? `padding:4px 7px;background:${fg};color:#fff;border:1px solid ${fg};border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;margin-right:2px;font-family:inherit;box-shadow:0 0 0 2px ${border}`
    : `padding:4px 7px;background:${bg};color:${fg};border:1px solid ${border};border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;margin-right:2px;font-family:inherit`;
  return `<button class="phone-status-btn" data-st="${escapeHtml(targetSt)}" title="${escapeHtml(title)}" style="${style}">${icon}</button>`;
}

function _bindPhoneCheckRowEvents(el) {
  el.querySelectorAll('tr.phone-row, .phone-row').forEach(row => {
    const name = row.dataset.name;
    const apply = row.dataset.apply;
    row.querySelectorAll('.phone-status-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newStatus = btn.dataset.st;
        const origText = btn.textContent;
        const origBg = btn.style.background;
        btn.disabled = true; btn.textContent = '…';
        try {
          const payload = { name, apply_date: apply, status: newStatus };
          await safeSave({ type:'upsert', table:'booking_status', payload, options: { onConflict:'name,apply_date' } });
          const match = bookingsData.find(b => b.name === name && b.applyDate === apply);
          if (match) match.status = newStatus;
          try {
            const bkEx = loadData('bk-extra', {});
            const key = name + '|' + apply;
            if (!bkEx[key]) bkEx[key] = {};
            bkEx[key].editedStatus = newStatus;
            saveData('bk-extra', bkEx);
          } catch(_){}
          showToast(`${name}: ${newStatus}に更新`);
          renderPhoneCheck();
          updateHeaderBadge();
        } catch(e) {
          showToast('保存エラー: ' + e.message, true);
          // Bug fix: エラー時にボタンの見た目を復元 (旧: disabled だけ戻して "..." のまま)
          btn.disabled = false;
          btn.textContent = origText;
          if (origBg) btn.style.background = origBg;
        }
      });
    });
    // v273: メモセルクリックで編集モーダル (来院タブと同じUX)
    const memoCell = row.querySelector('.phone-memo-cell');
    if (memoCell) {
      memoCell.addEventListener('click', () => {
        openMemoModal(memoCell.dataset.name, memoCell.dataset.apply, memoCell);
        // Bug fix: 既存の interval を停止 (連打すると setInterval が積み上がる問題を解消)
        if (_phoneMemoModalCheckInterval) {
          clearInterval(_phoneMemoModalCheckInterval);
          _phoneMemoModalCheckInterval = null;
        }
        _phoneMemoModalCheckInterval = setInterval(() => {
          const modal = document.getElementById('memo-modal');
          if (!modal || modal.hidden) {
            clearInterval(_phoneMemoModalCheckInterval);
            _phoneMemoModalCheckInterval = null;
            renderPhoneCheck();
          }
        }, 300);
      });
    }
  });
}

// === v261 ヘッダー通知バッジ (要対応件数常時表示) ===
let _badgeUpdateTimer = null;
function setupHeaderBadge() {
  const badge = document.getElementById('header-badge');
  if (!badge) return;
  // クリックで予約タブの要対応フィルタへ
  badge.addEventListener('click', () => {
    try { switchView('bookings'); } catch(_){}
    setTimeout(() => {
      // 要対応フィルタを自動セット
      const sel = document.querySelector('#bk-quick');
      if (sel) { sel.value = 'pending'; sel.dispatchEvent(new Event('change')); }
      // 数値カードの「要対応」ハイライトをクリック
      const card = document.querySelector('[data-st="pending"]');
      if (card && !card.classList.contains('active')) card.click();
    }, 200);
  });
  updateHeaderBadge();
  // bookingsData 変更を検知して更新 (polling 1秒)
  clearInterval(_badgeUpdateTimer);
  _badgeUpdateTimer = setInterval(updateHeaderBadge, 3000);
}
function updateHeaderBadge() {
  const badge = document.getElementById('header-badge');
  if (!badge || !Array.isArray(bookingsData)) return;
  const source = getFilteredBookingsData ? getFilteredBookingsData() : bookingsData;
  // 要対応: status が 未対応 or 空 で かつ 未来予約
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  let pending = 0;
  source.forEach(d => {
    if (d.status === '除外' || d.status === 'キャンセル') return;
    if (!d.status || d.status === '未対応') pending++;
  });
  if (pending <= 0) {
    badge.style.display = 'none';
    return;
  }
  badge.style.display = 'inline-flex';
  badge.textContent = '⚠️ 要対応 ' + pending + '件';
  badge.classList.toggle('urgent', pending >= 20);
}

// === v261 プルリフレッシュ (モバイルのみ) ===
let _pullRefreshActive = false;
function setupPullRefresh() {
  // v266 機能削除 — ユーザー要望「じゃま」のため何もしない
  return;
  // 以下デッドコード (将来再有効化時の参考)
  if (_pullRefreshActive) return;
  _pullRefreshActive = true;
  // インジケータ作成
  let indicator = document.getElementById('pull-refresh-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'pull-refresh-indicator';
    indicator.className = 'pull-refresh-indicator';
    indicator.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg><span id="pull-refresh-text">下に引っ張って更新</span>';
    document.body.appendChild(indicator);
  }
  let startY = 0, pulling = false, distance = 0;
  const THRESHOLD = 70;
  const scrollEl = document.scrollingElement || document.documentElement;
  document.addEventListener('touchstart', (e) => {
    // v265 ログイン画面表示中はスキップ
    if (document.getElementById('app')?.hidden) { pulling = false; return; }
    if (scrollEl.scrollTop > 0) { pulling = false; return; }
    if (document.body.classList.contains('pr-loading')) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    distance = e.touches[0].clientY - startY;
    if (distance < 0) { pulling = false; return; }
    if (distance > 10) {
      indicator.style.transform = `translate(-50%, ${Math.min(distance - 20, 30)}px)`;
      indicator.classList.add('show');
      const txt = indicator.querySelector('#pull-refresh-text');
      if (txt) txt.textContent = distance > THRESHOLD ? '離すと更新' : '下に引っ張って更新';
    }
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    const shouldRefresh = distance > THRESHOLD;
    if (shouldRefresh) {
      indicator.classList.add('loading');
      const txt = indicator.querySelector('#pull-refresh-text');
      if (txt) txt.textContent = '更新中...';
      document.body.classList.add('pr-loading');
      try {
        // 更新ボタンと同じ処理
        const btn = document.getElementById('refresh-btn');
        if (btn) btn.click();
        await new Promise(r => setTimeout(r, 800));
      } catch(_){}
      indicator.classList.remove('loading');
      document.body.classList.remove('pr-loading');
    }
    indicator.classList.remove('show');
    indicator.style.transform = '';
    distance = 0;
  }, { passive: true });
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.desktop-nav .nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.bottom-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== `view-${view}`);
  window.scrollTo(0, 0);
  const titles = {tc:'TC',sales:'売上',bookings:'予約',kaiin:'来院',adbudget:'広告',admin:'管理',reviews:'口コミ',settings:'設定'};
  document.title = '清翔会 - ' + (titles[view] || '');
  try { sessionStorage.setItem('lastView', view); } catch(_){}
  // 管理タブ切替時: 権限管理を自動で表示
  if (view === 'admin') {
    const activeAdmSub = document.querySelector('#view-admin .sub-nav-btn.active')?.dataset.sub || 'adm-auth-migration';
    if (activeAdmSub === 'adm-auth-migration') {
      setTimeout(() => { if (typeof renderAuthMigration === 'function') renderAuthMigration(); }, 50);
    }
  }
  // 来院タブ切替時にアクティブなサブの再描画
  if (view === 'kaiin') {
    const activeSub = document.querySelector('#kaiin-sub-nav .sub-nav-btn.active')?.dataset.sub || 'kaiin-all';
    if (activeSub === 'kaiin-all') {
      setTimeout(() => { if (typeof renderKaiinAll === 'function') renderKaiinAll('kaiin-all-content'); }, 50);
    } else {
      const map = {'kaiin-bf':'BF','kaiin-kyosei':'矯正','kaiin-implant':'インプラント','kaiin-labrie':'ラブリエ','kaiin-hotetsu':'自費補綴','kaiin-konchi':'自費根治','kaiin-whitening':'ホワイトニング','kaiin-lipart':'リップアート','kaiin-jewelry':'ティースジュエリー','kaiin-other':'その他'};
      const t = map[activeSub];
      if (t) setTimeout(() => renderKaiinTab(t, activeSub + '-content'), 50);
    }
  }
}

// === v264 キーボードショートカット ===
function setupKeyboardShortcuts() {
  const VIEWS = ['bookings', 'kaiin', 'tc', 'sales', 'adbudget', 'admin'];
  const VIEW_LABELS = { bookings:'予約', kaiin:'来院', tc:'TC', sales:'売上', adbudget:'広告', admin:'管理' };
  const SEARCH_TARGETS = {
    bookings: ['bk-search', 'ps-name', 'fac-search', 'bf-lc-search'],
    kaiin: ['fac-search', 'bk-search'],
    tc: [],
    sales: [],
    adbudget: [],
    admin: ['qa-search']
  };

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    for (let p = el; p; p = p.parentElement) {
      if (p.hidden) return false;
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  }

  function focusSearchOnCurrentView() {
    const view = currentView || 'bookings';
    const ids = SEARCH_TARGETS[view] || [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && isVisible(el)) { el.focus(); el.select?.(); return true; }
    }
    // フォールバック: 表示中の検索っぽい input
    const inputs = document.querySelectorAll('input[type="text"], input[type="search"]');
    for (const el of inputs) {
      if (!isVisible(el)) continue;
      const hint = (el.placeholder || '') + ' ' + (el.id || '');
      if (/検索|search|名前|キーワード/i.test(hint)) { el.focus(); el.select?.(); return true; }
    }
    return false;
  }

  function showShortcutToast(text) {
    let t = document.getElementById('kbd-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'kbd-toast';
      t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(17,17,17,.92);color:#fff;padding:10px 18px;border-radius:24px;font-size:13px;font-weight:600;z-index:99999;pointer-events:none;opacity:0;transition:opacity .18s;box-shadow:0 4px 16px rgba(0,0,0,.3)';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 1100);
  }

  function showShortcutHelp() {
    const existing = document.getElementById('kbd-help-modal');
    if (existing) { existing.remove(); return; }
    const m = document.createElement('div');
    m.id = 'kbd-help-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99998;display:flex;align-items:center;justify-content:center;padding:16px';
    const kbd = 'background:#f3f4f6;padding:3px 8px;border-radius:5px;font-family:ui-monospace,monospace;font-size:11px;border:1px solid #e5e7eb;color:#111';
    const row = (label, k) => `<tr><td style="padding:7px 0;color:#444">${label}</td><td style="text-align:right"><kbd style="${kbd}">${k}</kbd></td></tr>`;
    m.innerHTML = `
      <div style="background:#fff;border-radius:14px;padding:22px;max-width:380px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.35);font-family:inherit">
        <div style="font-size:16px;font-weight:700;margin-bottom:12px">⌨️ キーボードショートカット</div>
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          ${row('検索ボックスにフォーカス', 'Ctrl+K')}
          ${row('予約タブ', 'Alt+1')}
          ${row('来院タブ', 'Alt+2')}
          ${row('TCタブ', 'Alt+3')}
          ${row('売上タブ', 'Alt+4')}
          ${row('広告タブ', 'Alt+5')}
          ${row('管理タブ', 'Alt+6')}
          ${row('モーダルを閉じる', 'Esc')}
          ${row('このヘルプ', '?')}
        </table>
        <div style="margin-top:10px;font-size:11px;color:#999;line-height:1.5">※ Mac は Ctrl の代わりに Cmd キー<br>※ Ctrl+1〜6 はブラウザのタブ切替と競合するため Alt 推奨</div>
        <button id="kbd-help-close" style="width:100%;margin-top:14px;padding:10px;background:#111;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-family:inherit">閉じる</button>
      </div>`;
    m.addEventListener('click', (ev) => { if (ev.target === m) m.remove(); });
    m.querySelector('#kbd-help-close').addEventListener('click', () => m.remove());
    document.body.appendChild(m);
  }

  document.addEventListener('keydown', (e) => {
    const isMod = e.ctrlKey || e.metaKey;
    const inEditable = e.target?.matches?.('input, textarea, select, [contenteditable="true"]');

    // Ctrl/Cmd+K: 検索フォーカス（テキスト入力中でも有効）
    if (isMod && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      const ok = focusSearchOnCurrentView();
      if (!ok) showShortcutToast('このタブには検索ボックスがありません');
      return;
    }

    // ?: ヘルプ（テキスト入力中は除く）
    if (!inEditable && !isMod && !e.altKey && e.key === '?') {
      e.preventDefault();
      showShortcutHelp();
      return;
    }

    // Alt+1〜6 / Ctrl+1〜6: タブ切替（テキスト入力中は除く）
    if ((e.altKey || isMod) && /^[1-6]$/.test(e.key) && !inEditable) {
      e.preventDefault();
      const v = VIEWS[parseInt(e.key, 10) - 1];
      if (v) {
        switchView(v);
        showShortcutToast('▶ ' + VIEW_LABELS[v]);
      }
    }
  });
}

// === v264 スワイプアクション (モバイル) ===
// 左スワイプ → 確認済に変更 / 右スワイプ → メモ編集
function setupBookingSwipeActions() {
  const tbody = document.getElementById('bk-tbody');
  if (!tbody) return;
  // タッチ非対応(マウス主体)はスキップ
  if (!matchMedia('(pointer: coarse)').matches) return;
  if (tbody._swipeWired) return;
  tbody._swipeWired = true;

  let active = null;

  tbody.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const tr = e.target.closest('tr[data-bk-name]');
    if (!tr) return;
    // インタラクティブ要素(チェックボックス/ボタン/セレクト等)タップ時はスワイプとして扱わない
    if (e.target.closest('input,select,button,a')) return;
    active = {
      tr,
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      startT: Date.now(),
      moved: false
    };
  }, { passive: true });

  tbody.addEventListener('touchmove', (e) => {
    if (!active || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - active.startX;
    const dy = e.touches[0].clientY - active.startY;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) active.moved = true;
    // 横方向 dominant ならビジュアルフィードバック
    if (Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      active.tr.style.transform = `translateX(${dx * 0.35}px)`;
      active.tr.style.transition = 'none';
      active.tr.style.background = dx > 0
        ? 'linear-gradient(to right, #fef3c7 0%, transparent 60%)'
        : 'linear-gradient(to left, #dcfce7 0%, transparent 60%)';
    }
  }, { passive: true });

  tbody.addEventListener('touchend', (e) => {
    if (!active) return;
    const a = active; active = null;
    a.tr.style.transition = 'transform .25s ease, background .25s ease';
    a.tr.style.transform = '';
    a.tr.style.background = '';
    if (!a.moved) return;
    const ev = e.changedTouches[0];
    const dx = ev.clientX - a.startX;
    const dy = ev.clientY - a.startY;
    const dt = Date.now() - a.startT;
    if (dt > 700) return;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    const name = a.tr.dataset.bkName;
    const apply = a.tr.dataset.bkApply;
    if (dx > 0) {
      // 右 → メモ
      const cell = a.tr.querySelector('.bk-memo-cell');
      if (typeof openMemoModal === 'function') openMemoModal(name, apply, cell || null);
    } else {
      // 左 → 確認済 (クイック)
      quickSetBookingStatus(name, apply, '確認済');
    }
  }, { passive: true });

  tbody.addEventListener('touchcancel', () => {
    if (!active) return;
    active.tr.style.transition = 'transform .25s, background .25s';
    active.tr.style.transform = '';
    active.tr.style.background = '';
    active = null;
  }, { passive: true });
}

async function quickSetBookingStatus(name, apply, newStatus) {
  const match = bookingsData.find(d => d.name === name && d.applyDate === apply);
  if (!match) return;
  const oldStatus = match.status;
  if (oldStatus === newStatus) { showToast(`${name} は既に「${newStatus}」`); return; }
  match.status = newStatus;
  const bkEx = loadData('bk-extra', {});
  const key = name + '|' + apply;
  if (!bkEx[key]) bkEx[key] = {};
  bkEx[key].editedStatus = newStatus;
  saveData('bk-extra', bkEx);
  try {
    await safeSave({ type:'upsert', table:'booking_status', payload: { name, apply_date: apply, status: newStatus }, options: { onConflict:'name,apply_date' } });
    fetch(GAS_API_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, applyDate: apply, status: newStatus }) }).catch(() => {});
    showToast(`✅ ${name} → ${newStatus}`);
  } catch (e) {
    match.status = oldStatus;
    showToast('⚠ 保存失敗', true);
  }
  renderBookings();
}

// === v264 ピン留め (お気に入り) ===
function getPinnedBookings() {
  try { return new Set(JSON.parse(localStorage.getItem('bk-pins') || '[]')); }
  catch { return new Set(); }
}
function savePinnedBookings(set) {
  localStorage.setItem('bk-pins', JSON.stringify([...set]));
}
function togglePinnedBooking(name, applyDate) {
  const set = getPinnedBookings();
  const key = name + '|' + applyDate;
  if (set.has(key)) set.delete(key); else set.add(key);
  savePinnedBookings(set);
  return set.has(key);
}

// === v264 一括ステータス更新 (バルクアクション) ===
function setupBulkBookingActions() {
  const tbody = document.getElementById('bk-tbody');
  if (!tbody) return;
  const headerCheckbox = document.getElementById('bk-select-all');
  const allCbs = () => tbody.querySelectorAll('.bk-row-select');

  function getSelected() {
    return [...allCbs()].filter(cb => cb.checked).map(cb => ({ name: cb.dataset.name, applyDate: cb.dataset.apply }));
  }

  function ensureBar() {
    let bar = document.getElementById('bk-bulk-bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'bk-bulk-bar';
    bar.style.cssText = 'position:fixed;bottom:64px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:10px 14px;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.4);z-index:9998;display:none;align-items:center;gap:8px;font-family:inherit;flex-wrap:wrap;max-width:calc(100vw - 24px);font-size:13px';
    bar.innerHTML = `
      <span class="bbar-count" style="font-weight:700;font-size:13px;white-space:nowrap">0件選択中</span>
      <select class="bbar-status" style="padding:6px 8px;border-radius:6px;border:none;font-family:inherit;font-size:12px;background:#fff;color:#111;font-weight:600;min-width:140px">
        <option value="">ステータスを選択…</option>
        <option value="確認済">✅ 確認済</option>
        <option value="後追いLINE済み">💬 後追いLINE済み</option>
        <option value="予約連絡待ち">⏳ 予約連絡待ち</option>
        <option value="予約変更">📅 予約変更</option>
        <option value="来院済">🏥 来院済</option>
        <option value="キャンセル">❌ キャンセル</option>
        <option value="除外">🚫 除外</option>
      </select>
      <button class="bbar-apply" style="padding:6px 12px;background:#fff;color:#111;border:none;border-radius:6px;font-weight:700;font-family:inherit;cursor:pointer;font-size:12px">適用</button>
      <button class="bbar-cancel" style="padding:6px 10px;background:transparent;color:#fff;border:1px solid #555;border-radius:6px;font-family:inherit;cursor:pointer;font-size:12px">解除</button>
    `;
    document.body.appendChild(bar);

    bar.querySelector('.bbar-cancel').addEventListener('click', () => {
      document.getElementById('bk-tbody')?.querySelectorAll('.bk-row-select:checked').forEach(cb => cb.checked = false);
      const hcb = document.getElementById('bk-select-all'); if (hcb) { hcb.checked = false; hcb.indeterminate = false; }
      bar.style.display = 'none';
    });

    bar.querySelector('.bbar-apply').addEventListener('click', async () => {
      const newStatus = bar.querySelector('.bbar-status').value;
      if (!newStatus) { showToast('ステータスを選択してください', true); return; }
      const sel = getSelected();
      if (sel.length === 0) { showToast('対象がありません', true); return; }
      if (!confirm(`選択中の ${sel.length} 件を「${newStatus}」に変更します。よろしいですか？`)) return;

      const applyBtn = bar.querySelector('.bbar-apply');
      const orig = applyBtn.textContent;
      applyBtn.disabled = true; applyBtn.textContent = '保存中…';

      let okCount = 0, failCount = 0;
      for (const item of sel) {
        try {
          const match = bookingsData.find(d => d.name === item.name && d.applyDate === item.applyDate);
          if (!match) { failCount++; continue; }
          match.status = newStatus;
          const bkEx = loadData('bk-extra', {});
          const key = item.name + '|' + item.applyDate;
          if (!bkEx[key]) bkEx[key] = {};
          bkEx[key].editedStatus = newStatus;
          saveData('bk-extra', bkEx);
          const upsertData = { name: item.name, apply_date: item.applyDate, status: newStatus };
          if (isBFBooking(match) && typeof STATUS_TO_BF !== 'undefined' && STATUS_TO_BF[newStatus] !== undefined) {
            const targetBF = STATUS_TO_BF[newStatus];
            const curBF = bfLifecycleCache[key]?.bf_status;
            const resettable = !curBF || curBF === '離脱' || curBF === 'キャンセル';
            if ((newStatus === '成約' || newStatus === 'キャンセル' || resettable) && targetBF !== null) {
              upsertData.bf_status = targetBF;
              if (!bfLifecycleCache[key]) bfLifecycleCache[key] = { name: item.name, apply_date: item.applyDate };
              bfLifecycleCache[key].bf_status = targetBF;
            }
          }
          await safeSave({ type:'upsert', table:'booking_status', payload: upsertData, options: { onConflict:'name,apply_date' } });
          fetch(GAS_API_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: item.name, applyDate: item.applyDate, status: newStatus }) }).catch(() => {});
          okCount++;
        } catch(e) {
          console.warn('bulk update failed', item, e);
          failCount++;
        }
      }

      applyBtn.disabled = false; applyBtn.textContent = orig;
      showToast(`✅ ${okCount}件更新${failCount > 0 ? ` (失敗${failCount}件)` : ''}`, failCount > 0);
      bar.style.display = 'none';
      renderBookings();
    });

    return bar;
  }

  function updateBar() {
    const sel = getSelected();
    const bar = document.getElementById('bk-bulk-bar');
    if (sel.length === 0) {
      if (bar) bar.style.display = 'none';
      if (headerCheckbox) { headerCheckbox.checked = false; headerCheckbox.indeterminate = false; }
      return;
    }
    const b = ensureBar();
    b.style.display = 'flex';
    b.querySelector('.bbar-count').textContent = sel.length + '件選択中';
    if (headerCheckbox) {
      const total = allCbs().length;
      headerCheckbox.checked = sel.length === total && total > 0;
      headerCheckbox.indeterminate = sel.length > 0 && sel.length < total;
    }
  }

  if (headerCheckbox) {
    headerCheckbox.onchange = () => {
      allCbs().forEach(cb => cb.checked = headerCheckbox.checked);
      updateBar();
    };
  }
  allCbs().forEach(cb => cb.addEventListener('change', updateBar));
  updateBar();
}

// === Facility Tabs ===
function renderFacilityTabs(containerId, active, onChange) {
  const c = document.getElementById(containerId);
  if (!c) return;
  c.innerHTML = FACILITIES.map(f =>
    `<button class="facility-tab${f === active ? ' active' : ''}" data-f="${f}">${f}</button>`
  ).join('');
  c.querySelectorAll('.facility-tab').forEach(b => {
    b.addEventListener('click', () => {
      c.querySelectorAll('.facility-tab').forEach(t => t.classList.remove('active'));
      b.classList.add('active');
      onChange(b.dataset.f);
    });
  });
}

// === Format ===
function fmt(n) { return n ? Number(n).toLocaleString() : '0'; }
function pct(a, b) { return b > 0 ? Math.round(a / b * 100) : 0; }

// === Sales ===
function getSalesData() { return loadData('sales-data', []); }

function saveSalesEntry() {
  const month = document.getElementById('sales-month').value;
  if (!month) return;
  const entry = {
    id: Date.now(),
    facility: salesFacility === '全体' ? 'エスカ' : salesFacility,
    month,
    selfPay: Number(document.getElementById('sales-self').value) || 0,
    insurance: Number(document.getElementById('sales-insurance').value) || 0,
    product: Number(document.getElementById('sales-product').value) || 0,
    adCost: Number(document.getElementById('sales-ad').value) || 0,
  };
  const data = getSalesData();
  data.push(entry);
  saveData('sales-data', data);
  ['sales-self','sales-insurance','sales-product','sales-ad'].forEach(id => document.getElementById(id).value = '');
  renderSales();
}

function fiscalFilter(data, year) {
  const startY = parseInt(year);
  const start = `${startY}-07`;
  const end = `${startY + 1}-06`;
  return data.filter(d => d.month >= start && d.month <= end);
}

function renderSales() {
  const data = getSalesData();
  const yearData = fiscalFilter(data, salesYear);
  const filtered = salesFacility === '全体' ? yearData : yearData.filter(d => d.facility === salesFacility);

  // 前年データ
  const prevYear = String(parseInt(salesYear) - 1);
  const prevYearData = fiscalFilter(data, prevYear);
  const prevFiltered = salesFacility === '全体' ? prevYearData : prevYearData.filter(d => d.facility === salesFacility);

  const totalSelf = filtered.reduce((s, d) => s + d.selfPay, 0);
  const totalIns = filtered.reduce((s, d) => s + d.insurance, 0);
  const totalProd = filtered.reduce((s, d) => s + d.product, 0);
  const totalAd = filtered.reduce((s, d) => s + d.adCost, 0);
  const totalRev = totalSelf + totalIns + totalProd;

  // 前年同月までの累計比較: 今期のデータがある月だけを前年でも集計
  const currentMonthNums = [...new Set(filtered.map(d => d.month.slice(5)))]; // ['07','08',...]
  const prevSameMonths = prevFiltered.filter(d => currentMonthNums.includes(d.month.slice(5)));
  const prevSelf = prevSameMonths.reduce((s, d) => s + d.selfPay, 0);
  const prevIns = prevSameMonths.reduce((s, d) => s + d.insurance, 0);
  const prevRev = prevSameMonths.reduce((s, d) => s + d.selfPay + d.insurance + d.product, 0);

  const yoyStr = (cur, prev) => {
    if (!prev) return '';
    const diff = Math.round((cur / prev - 1) * 100);
    const color = diff >= 0 ? 'var(--green)' : 'var(--red)';
    return `<span style="font-size:12px;color:${color};margin-left:4px">${diff >= 0 ? '+' : ''}${diff}%</span>`;
  };

  document.getElementById('sales-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">自費売上</span><span class="stat-num">¥${fmt(totalSelf)}</span><span class="stat-yoy">${yoyStr(totalSelf, prevSelf)}</span></div>
    <div class="stat-card"><span class="stat-label">保険売上</span><span class="stat-num">¥${fmt(totalIns)}</span><span class="stat-yoy">${yoyStr(totalIns, prevIns)}</span></div>
    <div class="stat-card"><span class="stat-label">物販</span><span class="stat-num">¥${fmt(totalProd)}</span></div>
    <div class="stat-card"><span class="stat-label">広告費</span><span class="stat-num">¥${fmt(totalAd)}</span></div>
    <div class="stat-card"><span class="stat-label">売上合計</span><span class="stat-num">¥${fmt(totalRev)}</span><span class="stat-yoy">${yoyStr(totalRev, prevRev)}</span></div>
  `;

  // === スプレッドシート風 月別テーブル ===
  const monthlyTable = document.getElementById('sales-monthly-table');
  const fiscalMonths = ['07','08','09','10','11','12','01','02','03','04','05','06'];
  const fiscalLabels = ['7月','8月','9月','10月','11月','12月','1月','2月','3月','4月','5月','6月'];
  const startY = parseInt(salesYear);

  // 施設リスト（全体の場合は全施設、それ以外は選択施設のみ）
  const facilityList = salesFacility === '全体' ? FACILITIES.filter(f => f !== '全体') : [salesFacility];

  // ヘッダー
  let mtHtml = `<thead><tr><th style="position:sticky;left:0;z-index:3;background:#1a1a1a;color:white">施設</th><th style="background:#1a1a1a;color:white">項目</th>`;
  fiscalLabels.forEach(l => { mtHtml += `<th>${l}</th>`; });
  mtHtml += `<th>通期</th><th>前年比</th></tr></thead><tbody>`;

  // 全体合計行を先頭に追加（全体表示時のみ）
  if (salesFacility === '全体') {
    const allRows = [
      { label: '医院売上', calc: d => d.selfPay + d.insurance + d.product },
      { label: '自費売上', calc: d => d.selfPay },
      { label: '保険売上', calc: d => d.insurance },
      { label: '物販', calc: d => d.product },
    ];
    allRows.forEach((row, ri) => {
      const isFirst = ri === 0;
      const rowBg = isFirst ? 'background:#e2e3e5;font-weight:700' : ri % 2 === 0 ? 'background:#f0f1f3' : 'background:#f5f5f5';
      mtHtml += `<tr style="${rowBg}">`;
      if (isFirst) mtHtml += `<td rowspan="4" style="font-weight:800;font-size:14px;background:#333;color:white;position:sticky;left:0;z-index:1;border-right:2px solid var(--border);vertical-align:middle">全体</td>`;
      mtHtml += `<td style="font-size:11px;color:${isFirst ? 'var(--text)' : 'var(--text-sub)'};white-space:nowrap;${isFirst ? 'font-weight:700' : ''}">${row.label}</td>`;
      let yearTotal = 0, prevTotal = 0;
      fiscalMonths.forEach(m => {
        const monthKey = parseInt(m) >= 7 ? `${startY}-${m}` : `${startY + 1}-${m}`;
        const val = yearData.filter(d => d.month === monthKey).reduce((s, d) => s + row.calc(d), 0);
        yearTotal += val;
        if (val > 0) {
          const prevMonthKey = parseInt(m) >= 7 ? `${startY - 1}-${m}` : `${startY}-${m}`;
          prevTotal += prevYearData.filter(d => d.month === prevMonthKey).reduce((s, d) => s + row.calc(d), 0);
        }
        const fmtVal = val ? (val >= 1000000 ? `${(val/10000).toFixed(0)}万` : fmt(val)) : '-';
        mtHtml += `<td style="text-align:right;font-size:12px;font-weight:${isFirst ? '700' : '500'};${val ? '' : 'color:var(--text-muted)'}">${fmtVal}</td>`;
      });
      const fmtTotal = yearTotal ? (yearTotal >= 1000000 ? `${(yearTotal/10000).toFixed(0)}万` : fmt(yearTotal)) : '-';
      const yoy = prevTotal > 0 ? Math.round((yearTotal / prevTotal - 1) * 100) : null;
      const yoyStr = yoy !== null ? `<span style="color:${yoy >= 0 ? 'var(--green)' : 'var(--red)'}; font-weight:700">${yoy >= 0 ? '+' : ''}${yoy}%</span>` : '-';
      mtHtml += `<td style="text-align:right;font-weight:700;font-size:13px;background:#e8e9eb;border-left:2px solid var(--border)">${fmtTotal}</td>`;
      mtHtml += `<td style="text-align:center;font-size:13px;background:#e8e9eb">${yoyStr}</td></tr>`;
    });
    // 区切り線
    mtHtml += `<tr><td colspan="16" style="padding:0;height:3px;background:var(--accent)"></td></tr>`;
  }

  facilityList.forEach(fac => {
    const facData = yearData.filter(d => d.facility === fac);
    const prevFacData = prevYearData.filter(d => d.facility === fac);

    const rows = [
      { label: '医院売上', key: 'total', calc: d => d.selfPay + d.insurance + d.product },
      { label: '自費売上', key: 'selfPay', calc: d => d.selfPay },
      { label: '保険売上', key: 'insurance', calc: d => d.insurance },
      { label: '物販', key: 'product', calc: d => d.product },
    ];

    rows.forEach((row, ri) => {
      const isFirst = ri === 0;
      const rowBg = isFirst ? 'background:#f0f1f3;font-weight:600' : ri % 2 === 0 ? 'background:#fafafa' : '';
      mtHtml += `<tr style="${rowBg}">`;
      if (isFirst) mtHtml += `<td rowspan="4" style="font-weight:700;font-size:13px;background:#e8e9eb;position:sticky;left:0;z-index:1;border-right:2px solid var(--border);vertical-align:middle">${fac}</td>`;
      mtHtml += `<td style="font-size:11px;color:${isFirst ? 'var(--text)' : 'var(--text-sub)'};white-space:nowrap;${isFirst ? 'font-weight:600' : ''}">${row.label}</td>`;

      let yearTotal = 0;
      let prevTotal = 0;
      fiscalMonths.forEach(m => {
        const monthKey = parseInt(m) >= 7 ? `${startY}-${m}` : `${startY + 1}-${m}`;
        const entry = facData.find(d => d.month === monthKey);
        const val = entry ? row.calc(entry) : 0;
        yearTotal += val;

        // 前年同月は、今期にデータがある月だけ集計
        if (val > 0) {
          const prevMonthKey = parseInt(m) >= 7 ? `${startY - 1}-${m}` : `${startY}-${m}`;
          const prevEntry = prevFacData.find(d => d.month === prevMonthKey);
          prevTotal += prevEntry ? row.calc(prevEntry) : 0;
        }

        const fmtVal = val ? (val >= 1000000 ? `${(val/10000).toFixed(0)}万` : fmt(val)) : '-';
        mtHtml += `<td style="text-align:right;font-size:12px;${val ? '' : 'color:var(--text-muted)'}">${fmtVal}</td>`;
      });

      const fmtTotal = yearTotal ? (yearTotal >= 1000000 ? `${(yearTotal/10000).toFixed(0)}万` : fmt(yearTotal)) : '-';
      const yoy = prevTotal > 0 ? Math.round((yearTotal / prevTotal - 1) * 100) : null;
      const yoyStr = yoy !== null ? `<span style="color:${yoy >= 0 ? 'var(--green)' : 'var(--red)'}; font-weight:700">${yoy >= 0 ? '+' : ''}${yoy}%</span>` : '-';
      mtHtml += `<td style="text-align:right;font-weight:700;font-size:12px;background:#f5f5f5;border-left:2px solid var(--border)">${fmtTotal}</td>`;
      mtHtml += `<td style="text-align:center;font-size:12px;background:#f5f5f5">${yoyStr}</td>`;
      mtHtml += `</tr>`;
    });
  });

  mtHtml += `</tbody>`;
  monthlyTable.innerHTML = mtHtml;

  // === 従来のテーブル ===
  const tbody = document.getElementById('sales-tbody');
  // 施設別にグルーピングして月ごとに集計
  const monthlyMap = {};
  filtered.forEach(d => {
    const key = d.month;
    if (!monthlyMap[key]) monthlyMap[key] = { selfPay: 0, insurance: 0, product: 0, adCost: 0 };
    monthlyMap[key].selfPay += d.selfPay;
    monthlyMap[key].insurance += d.insurance;
    monthlyMap[key].product += d.product;
    monthlyMap[key].adCost += d.adCost;
  });
  const prevMonthlyMap = {};
  prevFiltered.forEach(d => {
    // 前年同月に変換: 2024-07 -> 2025-07
    const m = parseInt(d.month.slice(5));
    const newMonth = m >= 7 ? `${parseInt(d.month.slice(0,4))+1}-${String(m).padStart(2,'0')}` : `${d.month.slice(0,4)}-${String(m).padStart(2,'0')}`;
    // 実際は同じ月番号で比較
    const key = d.month;
    if (!prevMonthlyMap[key]) prevMonthlyMap[key] = { selfPay: 0, insurance: 0, product: 0, adCost: 0 };
    prevMonthlyMap[key].selfPay += d.selfPay;
    prevMonthlyMap[key].insurance += d.insurance;
    prevMonthlyMap[key].product += d.product;
    prevMonthlyMap[key].adCost += d.adCost;
  });

  const sorted = Object.entries(monthlyMap).sort(([a],[b]) => b.localeCompare(a));
  tbody.innerHTML = sorted.map(([month, d]) => {
    const total = d.selfPay + d.insurance + d.product;
    // 前年同月を探す
    const prevM = parseInt(month.slice(5));
    const prevMonthKey = `${parseInt(month.slice(0,4))-1}-${String(prevM).padStart(2,'0')}`;
    const p = prevMonthlyMap[prevMonthKey];
    const prevTotal = p ? p.selfPay + p.insurance + p.product : 0;
    const yoy = prevTotal ? Math.round((total / prevTotal - 1) * 100) : null;
    const yoyBadge = yoy !== null ? `<span class="badge ${yoy >= 0 ? 'badge-success' : 'badge-danger'}" style="margin-left:6px">${yoy >= 0 ? '+' : ''}${yoy}%</span>` : '';

    return `<tr>
      <td>${month}</td>
      <td>¥${fmt(d.selfPay)}</td><td>¥${fmt(d.insurance)}</td><td>¥${fmt(d.product)}</td>
      <td>¥${fmt(d.adCost)}</td><td><strong>¥${fmt(total)}</strong>${yoyBadge}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';
}

// === Patients ===
function getPatients() { return loadData('patients-data', []); }

function savePatient() {
  const name = document.getElementById('pt-name').value;
  if (!name) return;
  const entry = {
    id: Date.now(),
    facility: document.getElementById('tc-facility').value === '全体' ? 'エスカ' : document.getElementById('tc-facility').value,
    visitDate: document.getElementById('pt-date').value,
    name,
    purpose: document.getElementById('pt-purpose').value,
    source: document.getElementById('pt-source').value,
    counselor: document.getElementById('pt-counselor').value,
    doctor: document.getElementById('pt-doctor').value,
    status: document.getElementById('pt-status').value,
    amount: Number(document.getElementById('pt-amount').value) || 0,
  };
  const data = getPatients();
  data.push(entry);
  saveData('patients-data', data);
  document.getElementById('pt-name').value = '';
  document.getElementById('pt-amount').value = '';
  renderPatients();
  renderRates();
}

function renderPatients() {
  const data = getPatients();
  const ptFac = document.getElementById('tc-facility').value;
  const filtered = ptFac === '全体' ? data : data.filter(d => d.facility === ptFac);

  const reserved = filtered.filter(d => d.status !== 'キャンセル').length;
  const visited = filtered.filter(d => d.status !== '予約' && d.status !== 'キャンセル').length;
  const decided = filtered.filter(d => d.status === '成約').length;
  const totalAmt = filtered.filter(d => d.status === '成約').reduce((s, d) => s + d.amount, 0);
  const avgUnit = decided > 0 ? Math.round(totalAmt / decided) : 0;
  const ortho = filtered.filter(d => d.purpose === '矯正相談').length;
  const implant = filtered.filter(d => d.purpose === 'インプラント相談').length;
  const bf = filtered.filter(d => d.purpose === 'BF相談').length;
  const lovelier = filtered.filter(d => d.purpose === 'ラブリエ相談').length;

  document.getElementById('patients-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">予約数</span><span class="stat-num">${reserved}</span></div>
    <div class="stat-card"><span class="stat-label">矯正相談</span><span class="stat-num">${ortho}</span></div>
    <div class="stat-card"><span class="stat-label">インプラント</span><span class="stat-num">${implant}</span></div>
    <div class="stat-card"><span class="stat-label">BF相談</span><span class="stat-num">${bf}</span></div>
    <div class="stat-card"><span class="stat-label">ラブリエ</span><span class="stat-num">${lovelier}</span></div>
    <div class="stat-card"><span class="stat-label">成約数</span><span class="stat-num">${decided}</span></div>
    <div class="stat-card"><span class="stat-label">決定率</span><span class="stat-num">${pct(decided, visited)}%</span></div>
    <div class="stat-card"><span class="stat-label">決定単価</span><span class="stat-num">¥${fmt(avgUnit)}</span></div>
  `;

  const tbody = document.getElementById('patients-tbody');
  const sorted = [...filtered].sort((a, b) => (b.visitDate || '').localeCompare(a.visitDate || ''));
  const statusBadge = s => {
    const cls = s === '成約' ? 'badge-success' : s === 'キャンセル' ? 'badge-danger' : ['検査予約','診断済'].includes(s) ? 'badge-warning' : 'badge-default';
    return `<span class="badge ${cls}">${s}</span>`;
  };
  tbody.innerHTML = sorted.map(d => `<tr>
    <td>${d.visitDate || '-'}</td><td>${maskName(d.name)}</td><td>${d.purpose}</td><td>${d.source}</td>
    <td>${d.counselor || '-'}</td><td>${d.doctor || '-'}</td><td>${statusBadge(d.status)}</td>
    <td>${d.amount ? '¥' + fmt(d.amount) : '-'}</td>
  </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';
}

// === Rates ===
function renderRates() {
  const allCData = loadData('consultation-data', []);
  const pData = getPatients();
  const ratesYear = document.getElementById('tc-year').value;
  const ratesFac = document.getElementById('tc-facility').value;

  // 年度フィルター
  let cData = allCData;
  if (ratesYear !== 'all') {
    cData = allCData.filter(d => {
      const y = parseInt(ratesYear);
      return d.month >= `${y}-07` && d.month <= `${y+1}-06`;
    });
  }
  // 医院フィルター
  if (ratesFac !== '全体') {
    cData = cData.filter(d => d.facility === ratesFac);
  }

  if (cData.length === 0) {
    document.getElementById('rates-stats').innerHTML = '<div class="stat-card"><span class="stat-label">データなし</span></div>';
    document.getElementById('rates-monthly-table').innerHTML = '';
    return;
  }

  const sum = (arr, key) => arr.reduce((s, d) => s + d[key], 0);
  const totalC = sum(cData,'consult'), totalD = sum(cData,'decide');

  const krC = sum(cData,'kr_c'), krD = sum(cData,'kr_d');
  const wsC = sum(cData,'ws_c'), wsD = sum(cData,'ws_d');
  const bxC = sum(cData,'bx_c'), bxD = sum(cData,'bx_d');
  const subStat = (label, d, c) => `<div class="stat-card"><span class="stat-label">${label}</span><span class="stat-num">${pct(d,c)}%</span><span class="stat-yoy" style="color:var(--text-sub)">${d}/${c}件</span></div>`;

  document.getElementById('rates-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">相談数</span><span class="stat-num">${fmt(totalC)}</span></div>
    <div class="stat-card"><span class="stat-label">決定数</span><span class="stat-num">${fmt(totalD)}</span></div>
    <div class="stat-card"><span class="stat-label">決定率</span><span class="stat-num">${pct(totalD, totalC)}%</span></div>
    ${subStat('キレイライン', krD, krC)}
    ${subStat('ウィスマイル', wsD, wsC)}
    ${subStat('ビンクス', bxD, bxC)}
  `;

  // === 月別テーブル（スプレッドシート風） ===
  const mTable = document.getElementById('rates-monthly-table');
  const fiscalM = ['07','08','09','10','11','12','01','02','03','04','05','06'];
  const fiscalL = ['7月','8月','9月','10月','11月','12月','1月','2月','3月','4月','5月','6月'];
  const facList = [...new Set(cData.map(d => d.facility))];

  let html = `<thead><tr><th style="position:sticky;left:0;z-index:3;background:#1a1a1a;color:white">医院</th><th style="background:#1a1a1a;color:white">項目</th>`;
  fiscalL.forEach(l => { html += `<th style="background:#1a1a1a;color:white">${l}</th>`; });
  html += `<th style="background:#1a1a1a;color:white">通期</th><th style="background:#1a1a1a;color:white">決定率</th></tr></thead><tbody>`;

  // 全体行
  const allMonths = {};
  fiscalM.forEach(m => { allMonths[m] = { c: 0, d: 0 }; });
  cData.forEach(d => { const m = d.month.slice(5); if (allMonths[m]) { allMonths[m].c += d.consult; allMonths[m].d += d.decide; } });
  ['相談数','決定数'].forEach((label, ri) => {
    const bg = ri === 0 ? 'background:#e2e3e5;font-weight:700' : 'background:#f0f1f3';
    html += `<tr style="${bg}">`;
    if (ri === 0) html += `<td rowspan="2" style="font-weight:800;background:#333;color:white;position:sticky;left:0;z-index:1;vertical-align:middle">全体</td>`;
    html += `<td style="font-size:11px;${ri===0?'font-weight:700':''}">${label}</td>`;
    let total = 0;
    fiscalM.forEach(m => {
      const v = ri === 0 ? allMonths[m].c : allMonths[m].d;
      total += v;
      html += `<td style="text-align:right;font-size:12px;${v?'':'color:var(--text-muted)'}">${v || '-'}</td>`;
    });
    const rate = ri === 1 ? `${pct(total, fiscalM.reduce((s,m) => s + allMonths[m].c, 0))}%` : '';
    html += `<td style="text-align:right;font-weight:700;font-size:12px;background:#e8e9eb;border-left:2px solid var(--border)">${fmt(total)}</td>`;
    html += `<td style="text-align:center;font-size:12px;background:#e8e9eb;font-weight:700">${rate}</td></tr>`;
  });
  html += `<tr><td colspan="16" style="padding:0;height:3px;background:var(--accent)"></td></tr>`;

  // 施設別行
  facList.forEach(fac => {
    const facData = cData.filter(d => d.facility === fac);
    const mData = {};
    fiscalM.forEach(m => { mData[m] = { c: 0, d: 0 }; });
    facData.forEach(d => { const m = d.month.slice(5); if (mData[m]) { mData[m].c += d.consult; mData[m].d += d.decide; } });

    ['相談数','決定数'].forEach((label, ri) => {
      const bg = ri === 0 ? 'background:#f0f1f3;font-weight:600' : '';
      html += `<tr style="${bg}">`;
      if (ri === 0) html += `<td rowspan="2" style="font-weight:700;font-size:13px;background:#e8e9eb;position:sticky;left:0;z-index:1;border-right:2px solid var(--border);vertical-align:middle">${fac}</td>`;
      html += `<td style="font-size:11px;color:${ri===0?'var(--text)':'var(--text-sub)'};${ri===0?'font-weight:600':''}">${label}</td>`;
      let total = 0;
      fiscalM.forEach(m => {
        const v = ri === 0 ? mData[m].c : mData[m].d;
        total += v;
        html += `<td style="text-align:right;font-size:12px;${v?'':'color:var(--text-muted)'}">${v || '-'}</td>`;
      });
      const tC = fiscalM.reduce((s,m) => s + mData[m].c, 0);
      const tD = fiscalM.reduce((s,m) => s + mData[m].d, 0);
      const rate = ri === 1 ? `<span style="color:${pct(tD,tC)>=50?'var(--green)':'var(--red)'};font-weight:700">${pct(tD,tC)}%</span>` : '';
      html += `<td style="text-align:right;font-weight:700;font-size:12px;background:#f5f5f5;border-left:2px solid var(--border)">${fmt(total)}</td>`;
      html += `<td style="text-align:center;font-size:12px;background:#f5f5f5">${rate}</td></tr>`;
    });
  });
  html += '</tbody>';
  mTable.innerHTML = html;

  // === 施設別バーチャート ===
  const facGroups = {};
  cData.forEach(d => {
    if (!facGroups[d.facility]) facGroups[d.facility] = { c: 0, d: 0 };
    facGroups[d.facility].c += d.consult;
    facGroups[d.facility].d += d.decide;
  });
  renderBarChart('rates-facility', Object.entries(facGroups).map(([name, v]) => ({
    name, rate: pct(v.d, v.c), decided: v.d, consulted: v.c
  })).sort((a, b) => b.rate - a.rate));

  // === 種類別 ===
  const catData = {};
  [['キレイライン','kr_c','kr_d'],['ウィスマイル','ws_c','ws_d'],['ビンクス','bx_c','bx_d']].forEach(([cat,cK,dK]) => {
    const groups = {};
    cData.forEach(d => {
      if (!groups[d.facility]) groups[d.facility] = { c: 0, d: 0 };
      groups[d.facility].c += d[cK];
      groups[d.facility].d += d[dK];
    });
    catData[cat] = Object.entries(groups).map(([name, v]) => ({
      name, rate: pct(v.d, v.c), decided: v.d, consulted: v.c
    })).filter(d => d.consulted > 0).sort((a, b) => b.rate - a.rate);
  });

  const colors = { 'キレイライン': '', 'ウィスマイル': 'background:linear-gradient(90deg,#0ea5e9,#38bdf8)', 'ビンクス': 'background:linear-gradient(90deg,#f59e0b,#fbbf24)' };
  document.getElementById('rates-counselor').innerHTML = Object.entries(catData).map(([cat, arr]) =>
    `<div style="font-size:12px;font-weight:600;color:var(--text-sub);margin:${cat==='キレイライン'?'0':'16px'} 0 8px">${cat} 施設別</div>` +
    (arr.length ? arr.map(d => `<div class="bar-row"><div class="bar-label">${d.name}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(d.rate,5)}%;${colors[cat]}"><span>${d.rate}%</span></div></div><div class="bar-value">${d.decided}/${d.consulted}</div></div>`).join('') : '<p style="font-size:12px;color:var(--text-muted)">データなし</p>')
  ).join('');

  // ドクター月別テーブル
  const drData = loadData('doctor-data', []);
  const drTable = document.getElementById('doctor-monthly-table');
  if (drData.length > 0) {
    let filteredDr = drData;
    if (ratesYear !== 'all') {
      filteredDr = drData.filter(d => {
        const y = parseInt(ratesYear);
        return d.month >= `${y}-07` && d.month <= `${y+1}-06`;
      });
    }
    // 月リスト
    const drMonths = [...new Set(filteredDr.map(d => d.month))].sort();
    const drMonthLabels = drMonths.map(m => m.slice(5) + '月');
    // ドクターリスト（カウンセリング数10件以上）
    const drNames = {};
    filteredDr.forEach(d => {
      if (!drNames[d.name]) drNames[d.name] = { c: 0, d: 0 };
      drNames[d.name].c += d.consult;
      drNames[d.name].d += d.decide;
    });
    const activeNames = Object.entries(drNames).filter(([,v]) => v.c >= 10).sort((a,b) => pct(b[1].d,b[1].c) - pct(a[1].d,a[1].c));

    let dHtml = `<thead><tr><th style="position:sticky;left:0;z-index:3;background:#1a1a1a;color:white">ドクター</th><th style="background:#1a1a1a;color:white">項目</th>`;
    drMonthLabels.forEach(l => { dHtml += `<th style="background:#1a1a1a;color:white">${l}</th>`; });
    dHtml += `<th style="background:#1a1a1a;color:white">合計</th><th style="background:#1a1a1a;color:white">決定率</th></tr></thead><tbody>`;

    activeNames.forEach(([name, totals]) => {
      const drMonthData = {};
      drMonths.forEach(m => { drMonthData[m] = { c: 0, d: 0 }; });
      filteredDr.filter(d => d.name === name).forEach(d => {
        if (drMonthData[d.month]) { drMonthData[d.month].c += d.consult; drMonthData[d.month].d += d.decide; }
      });

      ['カウンセリング','資料取り'].forEach((label, ri) => {
        const bg = ri === 0 ? 'background:#f0f1f3;font-weight:600' : '';
        dHtml += `<tr style="${bg}">`;
        if (ri === 0) dHtml += `<td rowspan="2" style="font-weight:700;font-size:13px;background:#e8e9eb;position:sticky;left:0;z-index:1;border-right:2px solid var(--border);vertical-align:middle">${name}</td>`;
        dHtml += `<td style="font-size:11px;color:${ri===0?'var(--text)':'var(--text-sub)'};white-space:nowrap">${label}</td>`;
        drMonths.forEach(m => {
          const v = ri === 0 ? drMonthData[m].c : drMonthData[m].d;
          dHtml += `<td style="text-align:right;font-size:12px;${v?'':'color:var(--text-muted)'}">${v || '-'}</td>`;
        });
        const total = ri === 0 ? totals.c : totals.d;
        const rate = ri === 1 ? `<span style="color:${pct(totals.d,totals.c)>=50?'var(--green)':'var(--red)'};font-weight:700">${pct(totals.d,totals.c)}%</span>` : '';
        dHtml += `<td style="text-align:right;font-weight:700;font-size:12px;background:#f5f5f5;border-left:2px solid var(--border)">${total}</td>`;
        dHtml += `<td style="text-align:center;font-size:12px;background:#f5f5f5">${rate}</td></tr>`;
      });
    });
    dHtml += '</tbody>';
    drTable.innerHTML = dHtml;
  } else {
    drTable.innerHTML = '';
  }

  // ドクター別バーチャート（Excelデータ優先）
  if (drData.length > 0) {
    let filteredDr = drData;
    if (ratesYear !== 'all') {
      filteredDr = drData.filter(d => {
        const y = parseInt(ratesYear);
        return d.month >= `${y}-07` && d.month <= `${y+1}-06`;
      });
    }
    const drGroups = {};
    filteredDr.forEach(d => {
      if (!drGroups[d.name]) drGroups[d.name] = { c: 0, d: 0 };
      drGroups[d.name].c += d.consult;
      drGroups[d.name].d += d.decide;
    });
    renderBarChart('rates-doctor', Object.entries(drGroups).map(([name, v]) => ({
      name, rate: pct(v.d, v.c), decided: v.d, consulted: v.c
    })).filter(d => d.consulted >= 10).sort((a, b) => b.rate - a.rate));
  } else {
    renderBarChart('rates-doctor', groupRate(pData, 'doctor'));
  }
}

function groupRate(data, key) {
  const groups = {};
  data.forEach(d => {
    const k = d[key] || '未設定';
    if (!groups[k]) groups[k] = { consulted: 0, decided: 0 };
    if (['相談済','検査予約','診断済','成約'].includes(d.status)) groups[k].consulted++;
    if (d.status === '成約') groups[k].decided++;
  });
  return Object.entries(groups).map(([name, v]) => ({
    name, rate: pct(v.decided, v.consulted), consulted: v.consulted, decided: v.decided
  })).filter(d => d.consulted > 0).sort((a, b) => b.rate - a.rate);
}

function renderBarChart(id, data) {
  const el = document.getElementById(id);
  if (!data.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">データなし</p>'; return; }
  el.innerHTML = data.map(d => `
    <div class="bar-row">
      <div class="bar-label" title="${d.name}">${d.name}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(d.rate, 5)}%"><span>${d.rate}%</span></div></div>
      <div class="bar-value">${d.decided}/${d.consulted}</div>
    </div>
  `).join('');
}

// === Clinics (TC) ===
async function loadClinics() {
  try { const r = await fetch('data/clinics.json?v=' + Date.now(), { cache: 'no-store' }); clinics = await r.json(); } catch { clinics = []; }
  // localStorageの追加医院をマージ
  const added = loadData('added-clinics', []);
  clinics = [...clinics, ...added];
  renderCompetitors();
  renderStrategy();
}

function renderCompetitors() {
  document.getElementById('tc-total').textContent = clinics.length;
  const avgAll = clinics.length ? (clinics.reduce((s, c) => {
    const sc = c.scores;
    return s + (sc.reception + sc.counseling + sc.hospitality + sc.environment) / 4;
  }, 0) / clinics.length).toFixed(1) : '0';
  document.getElementById('tc-avg').textContent = avgAll;

  const grid = document.getElementById('clinic-grid');
  grid.innerHTML = clinics.map(c => {
    const s = c.scores;
    const avg = ((s.reception + s.counseling + s.hospitality + s.environment) / 4).toFixed(1);
    const sc = avg >= 4.5 ? 'score-high' : avg >= 3.5 ? 'score-mid' : 'score-low';
    return `
      <div class="clinic-card" data-id="${c.id}">
        <div class="clinic-card-header">
          <h3>${c.name}</h3>
          <div class="overall-score ${sc}">${avg}</div>
        </div>
        <div class="clinic-meta">${c.visitDate} &middot; ${c.address}</div>
        <div class="score-bars">
          ${[{l:'受付',v:s.reception,c:'bar-reception'},{l:'カウンセリング',v:s.counseling,c:'bar-counseling'},{l:'接遇',v:s.hospitality,c:'bar-hospitality'},{l:'院内環境',v:s.environment,c:'bar-environment'}].map(x => `
            <div class="score-row">
              <span class="label">${x.l}</span>
              <div class="score-bar"><div class="score-bar-fill ${x.c}" style="width:${x.v*20}%"></div></div>
              <span class="value">${x.v}</span>
            </div>
          `).join('')}
        </div>
        <div class="clinic-card-footer">${c.summary}</div>
        ${c.pricing ? `<div style="margin-top:10px;padding:8px 12px;background:var(--bg);border-radius:8px;font-size:12px;color:var(--text-sub)"><strong style="color:var(--text)">料金:</strong> ${c.pricing}</div>` : ''}
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-light)">
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
            <button class="btn btn-outline doc-add-btn" data-clinic="${c.name}" data-type="見積書" style="font-size:11px;padding:5px 10px;min-height:28px">+ 見積書</button>
            <button class="btn btn-outline doc-add-btn" data-clinic="${c.name}" data-type="パンフレット" style="font-size:11px;padding:5px 10px;min-height:28px">+ 資料</button>
            <button class="btn btn-outline doc-add-btn" data-clinic="${c.name}" data-type="録音" style="font-size:11px;padding:5px 10px;min-height:28px">+ 録音</button>
            <button class="btn btn-outline doc-add-btn" data-clinic="${c.name}" data-type="データ" style="font-size:11px;padding:5px 10px;min-height:28px">+ データ</button>
            <span style="font-size:11px;color:var(--text-muted)" id="doc-count-${c.id}"></span>
          </div>
          <div class="clinic-docs" id="clinic-docs-${c.id}"></div>
        </div>
      </div>`;
  }).join('');

  // 資料追加ボタン
  grid.querySelectorAll('.doc-add-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDocModal(btn.dataset.clinic, btn.dataset.type);
    });
  });

  // カード本体クリック
  grid.querySelectorAll('.clinic-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.doc-add-btn') || e.target.closest('.resource-item') || e.target.closest('.resource-delete')) return;
      openClinicDetail(clinics.find(c => c.id === parseInt(card.dataset.id)));
    });
  });

  // 各カードに資料表示
  renderClinicDocs();
}

function renderStrategy() {
  document.getElementById('suggestions-summary').innerHTML = clinics.map(c => {
    if (!c.suggestions.adopt.length) return '';
    return `<div class="suggestion-by-clinic"><h4>${c.name}</h4><ul>${c.suggestions.adopt.map(s => `<li>${s}</li>`).join('')}</ul></div>`;
  }).join('');

  document.getElementById('immediate-actions').innerHTML = [
    '担当DAが患者を待つ体制づくり','診察入ってからの患者への挨拶徹底',
    'チェアー前にティッシュ・眼鏡入れ設置','待ち時間対策（iPad雑誌の準備）',
  ].map(a => `<li>${a}</li>`).join('');
  document.getElementById('short-actions').innerHTML = [
    'パッと見て分かる端的な資料の作成','口腔写真撮影時の器具使用方法の改善',
    '受付とDAの連携強化で待ち時間削減','数値化した説明資料の導入',
  ].map(a => `<li>${a}</li>`).join('');
  document.getElementById('long-actions').innerHTML = [
    'カウンセリングの2回制導入の検討','自院の強み・差別化ポイントの明確化',
    '美容クリニック等との提携検討','成約率向上のためのクロージング研修',
  ].map(a => `<li>${a}</li>`).join('');
}

// === Clinic Detail Modal ===
function openClinicDetail(c) {
  const body = document.getElementById('modal-body');
  const s = c.scores;
  const sc = v => v >= 5 ? 'var(--text)' : v >= 4 ? 'var(--text-sub)' : 'var(--red)';
  body.innerHTML = `
    <div class="detail-header">
      <h2>${c.name}</h2>
      <div class="detail-meta">${c.visitDate} ${c.visitTime} &middot; ${c.address}</div>
    </div>
    <div class="detail-scores">
      ${[{n:'受付',v:s.reception},{n:'カウンセリング',v:s.counseling},{n:'接遇',v:s.hospitality},{n:'院内環境',v:s.environment}].map(x =>
        `<div class="detail-score-card"><div class="score-val" style="color:${sc(x.v)}">${x.v}</div><span class="score-name">${x.n}</span></div>`
      ).join('')}
    </div>
    <div class="detail-section"><h3>受付・第一印象</h3>
      <dl class="detail-grid">
        <dt>挨拶</dt><dd>${c.reception.greeting}</dd>
        <dt>身だしなみ</dt><dd>${c.reception.appearance}</dd>
        <dt>待ち時間</dt><dd>${c.reception.waitTime}</dd>
        <dt>スムーズさ</dt><dd>${c.reception.smoothness}</dd>
      </dl>
      <h4 style="margin-top:12px;font-size:11px;color:var(--text-sub);text-transform:uppercase;letter-spacing:0.5px">来院フロー</h4>
      <ol class="detail-flow">${c.reception.flow.map(f => `<li>${f}</li>`).join('')}</ol>
    </div>
    <div class="detail-section"><h3>カウンセリング</h3>
      <p style="margin-bottom:12px;font-size:13px;background:var(--bg);padding:12px;border-radius:8px">${c.counseling.impression}</p>
      <dl class="detail-grid">
        <dt>主訴深掘り</dt><dd>${c.counseling.hearing.deepDive}</dd>
        <dt>説明力</dt><dd>${c.counseling.explanation.clarity}</dd>
        <dt>専門用語</dt><dd>${c.counseling.explanation.terminology}</dd>
        <dt>治療選択肢</dt><dd>${c.counseling.proposal.options}</dd>
        <dt>メリデメ</dt><dd>${c.counseling.proposal.proscons}</dd>
        <dt>費用説明</dt><dd>${c.counseling.proposal.pricing}</dd>
        <dt>不安解消</dt><dd>${c.counseling.closing.anxietyRelief}</dd>
        <dt>意思決定</dt><dd>${c.counseling.closing.decisionPrompt}</dd>
        <dt>次回予約</dt><dd>${c.counseling.closing.nextBooking}</dd>
      </dl>
    </div>
    <div class="detail-section"><h3>接遇</h3>
      <dl class="detail-grid">
        <dt>共感力</dt><dd>${c.hospitality.empathy}</dd>
        <dt>傾聴</dt><dd>${c.hospitality.listening}</dd>
        <dt>言葉遣い</dt><dd>${c.hospitality.language}</dd>
        <dt>距離感</dt><dd>${c.hospitality.distance}</dd>
      </dl>
    </div>
    <div class="detail-section"><h3>院内環境</h3>
      <dl class="detail-grid">
        <dt>清潔感</dt><dd>${c.environment.cleanliness}</dd>
        <dt>設備</dt><dd>${c.environment.equipment}</dd>
        <dt>連携</dt><dd>${c.environment.teamwork}</dd>
      </dl>
    </div>
    <div class="detail-section"><h3>強み</h3>
      ${c.strengths.map(s => `<div class="strength-item">${s}</div>`).join('')}
      ${c.impressivePoints.length ? c.impressivePoints.map(p => `<div class="strength-item">${p}</div>`).join('') : ''}
    </div>
    <div class="detail-section"><h3>改善点</h3>
      ${c.improvements.counseling && !['特になし','1回目の段階では特になし','特に問題なし'].includes(c.improvements.counseling) ? `<div class="improve-item">${c.improvements.counseling}</div>` : ''}
      ${c.improvements.hospitality && !['特になし','特に問題なし'].includes(c.improvements.hospitality) ? `<div class="improve-item">${c.improvements.hospitality}</div>` : ''}
      ${c.improvements.operation && !['特になし','特に問題なし'].includes(c.improvements.operation) ? `<div class="improve-item">${c.improvements.operation}</div>` : ''}
    </div>
    <div class="detail-section"><h3>自院への示唆</h3>
      ${c.suggestions.adopt.map(s => `<div class="strength-item">${s}</div>`).join('')}
    </div>
    <div class="detail-section"><h3>総合評価</h3>
      <p style="font-size:14px;padding:14px;background:var(--bg);border-radius:8px;line-height:1.8">${c.summary}</p>
    </div>
  `;
  document.getElementById('clinic-modal').hidden = false;
  document.body.style.overflow = 'hidden';
}

// === Migrate localStorage to Supabase (one-time) ===
async function migrateToSupabase() {
  if (localStorage.getItem('migrated-to-supabase')) return;
  // Supabase Auth移行後はレガシーmigrationは不要。自動的に完了扱いに。
  if (window.currentSupabaseUserId || window.currentRole) {
    localStorage.setItem('migrated-to-supabase', 'true');
    return;
  }
  try {
    // Accounts
    const accounts = JSON.parse(localStorage.getItem('admin-accounts') || '[]');
    if (accounts.length) {
      for (const a of accounts) {
        // Check if already exists
        const { data: existing } = await sb.from('accounts').select('id').eq('password', a.password);
        if (!existing || !existing.length) {
          try {
            await sb.from('accounts').insert({
              name: a.name, password: a.password, role: a.role || 'view',
              permissions: a.permissions || [], promos: a.promos || [],
              services: a.services || [], facilities: a.facilities || []
            });
          } catch(_){}
        }
      }
    }
    // Documents
    const docs = JSON.parse(localStorage.getItem('documents-data') || '[]');
    if (docs.length) {
      for (const d of docs) {
        try {
          await sb.from('documents').insert({
            name: d.name, type: d.type, clinic: d.clinic || '', url: d.url
          });
        } catch(_){}
      }
    }
    // Booking extra (status, contract info)
    const bkExtra = JSON.parse(localStorage.getItem('bk-extra') || '{}');
    for (const [key, val] of Object.entries(bkExtra)) {
      const [name, apply] = key.split('|');
      if (name && apply) {
        try {
          await sb.from('booking_status').upsert({
            name, apply_date: apply,
            status: val.status || '',
            contract_service: val.contractService || '',
            contract_amount: Number(val.contractAmount) || 0,
            payment_month: val.paymentMonth || '',
            incentive_month: val.incentiveMonth || ''
          }, { onConflict: 'name,apply_date' });
        } catch(_){}
      }
    }
    // Reviews
    const reviews = JSON.parse(localStorage.getItem('reviews-data') || '[]');
    if (reviews.length) {
      for (const r of reviews) {
        try {
          await sb.from('reviews').insert({
            facility: r.facility, month: r.month, count: r.count, rating: r.rating
          });
        } catch(_){}
      }
    }
    // Review comments
    const comments = JSON.parse(localStorage.getItem('reviews-comments') || '[]');
    if (comments.length) {
      for (const c of comments) {
        try {
          await sb.from('review_comments').insert({
            facility: c.facility, rating: c.rating, text: c.text, date: c.date || ''
          });
        } catch(_){}
      }
    }
    localStorage.setItem('migrated-to-supabase', 'true');
    console.debug('Migration to Supabase complete');
    renderAccounts();
  } catch (e) {
    console.error('Migration error:', e);
  }
}

// === Admin: Account Management ===
function generatePassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 8; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

async function getAccountsFromDB() {
  const { data } = await sb.from('accounts').select('*').order('created_at', { ascending: false });
  return data || [];
}

async function createAccount() {
  const name = document.getElementById('adm-name').value.trim();
  if (!name) return;
  const perms = [];
  if (document.getElementById('adm-perm-tc').checked) perms.push('tc');
  if (document.getElementById('adm-perm-sales').checked) perms.push('sales');
  if (document.getElementById('adm-perm-bookings').checked) perms.push('bookings');
  if (document.getElementById('adm-perm-adbudget') && document.getElementById('adm-perm-adbudget').checked) perms.push('adbudget');
  if (!perms.length) { alert('閲覧タブを1つ以上選択してください'); return; }
  const selectedPromos = [...document.getElementById('adm-promos').selectedOptions].map(o => o.value);
  const selectedServices = [...document.getElementById('adm-services').selectedOptions].map(o => o.value);
  const selectedFacilities = [...document.getElementById('adm-facilities').selectedOptions].map(o => o.value);
  const role = document.getElementById('adm-role').value;
  const agency = document.getElementById('adm-agency') ? document.getElementById('adm-agency').value.trim() : '';
  const pw = generatePassword();
  await sb.from('accounts').insert({ name, password: pw, role, permissions: perms, promos: selectedPromos, services: selectedServices, facilities: selectedFacilities, agency });
  document.getElementById('adm-name').value = '';
  if (document.getElementById('adm-agency')) document.getElementById('adm-agency').value = '';
  showToast('アカウントを発行しました: ' + pw);
  renderAccounts();
}

async function deleteAccount(id) {
  if (!confirm('このアカウントを削除しますか？')) return;
  await sb.from('accounts').delete().eq('id', id);
  showToast('アカウントを削除しました');
  renderAccounts();
}

async function renderAccounts() {
  const el = document.getElementById('adm-accounts-list');
  if (!el) return;
  const accounts = await getAccountsFromDB();
  if (!accounts.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">発行済みアカウントなし</p>'; return; }
  const baseUrl = location.origin + location.pathname;
  const permLabel = p => ({tc:'TC',sales:'売上',bookings:'予約',adbudget:'広告'})[p] || p;
  el.innerHTML = `
    <div class="data-table-wrap"><table class="data-table" style="font-size:13px">
      <thead><tr>
        <th style="text-align:left">名前</th>
        <th>権限</th>
        <th>タブ</th>
        <th>代理店</th>
        <th>制限</th>
        <th>パスワード</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${accounts.map(a => {
          const restrictions = [];
          if (a.promos && a.promos.length) restrictions.push(`プロモ${a.promos.length}`);
          if (a.services && a.services.length) restrictions.push(`施術${a.services.length}`);
          if (a.facilities && a.facilities.length) restrictions.push(`店舗${a.facilities.length}`);
          return `
          <tr>
            <td style="text-align:left;font-weight:600">${a.name}</td>
            <td><span class="badge ${a.role==='edit'?'badge-success':'badge-default'}" style="font-size:10px">${a.role==='edit'?'編集':'閲覧'}</span></td>
            <td style="font-size:11px">${(a.permissions||[]).map(permLabel).join(' / ') || '-'}</td>
            <td style="font-size:11px">${a.agency || '-'}</td>
            <td style="font-size:11px;color:var(--text-sub)" title="${[...(a.promos||[]),...(a.services||[]),...(a.facilities||[])].join(', ')}">${restrictions.join(' ') || '-'}</td>
            <td><code style="font-size:11px;background:var(--bg);padding:2px 6px;border-radius:4px;user-select:all">${a.password}</code>
              <button class="copy-btn" onclick="navigator.clipboard.writeText('${a.password}');showToast('PWをコピーしました')" style="font-size:10px;padding:2px 6px;margin-left:4px">📋</button></td>
            <td><button class="resource-delete" onclick="deleteAccount(${a.id})" style="width:24px;height:24px;font-size:11px">×</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>
    <div style="margin-top:14px;padding:12px;background:var(--bg);border-radius:6px;border:1px solid var(--border-light)">
      <div style="font-size:12px;font-weight:700;margin-bottom:6px">🔗 パートナー共通ログインURL</div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <code style="font-size:12px;background:#fff;padding:6px 10px;border-radius:4px;border:1px solid var(--border);user-select:all;flex:1">${baseUrl}?view=partner</code>
        <button class="copy-btn" onclick="navigator.clipboard.writeText('${baseUrl}?view=partner');showToast('URLをコピーしました')" style="font-size:11px;padding:6px 14px;background:#111;color:#fff;border-radius:4px;border:none">URLをコピー</button>
      </div>
      <div style="font-size:11px;color:var(--text-sub);margin-top:6px">このURL(共通)とパートナーごとのパスワード(上表)を別経路で伝えてください。URL単体では何もできません。</div>
    </div>
  `;
}

function closeModal() {
  document.getElementById('clinic-modal').hidden = true;
  document.body.style.overflow = '';
}

// === Documents (Supabase) ===
async function getDocuments() {
  const { data } = await sb.from('documents').select('*').order('created_at', { ascending: false });
  return data || [];
}

function saveNewClinic() {
  // #7 連打ガード
  const btn = document.getElementById('nc-save');
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  try {
  const name = document.getElementById('nc-name').value.trim();
  if (!name) { if (btn) setTimeout(() => { btn.disabled = false; }, 600); return; }
  const newClinic = {
    id: Date.now(),
    name,
    visitDate: document.getElementById('nc-date').value,
    visitTime: document.getElementById('nc-time').value,
    address: document.getElementById('nc-address').value,
    staff: { da: document.getElementById('nc-da').value, dr: document.getElementById('nc-dr').value },
    bookingMethod: "ウェブ",
    scores: {
      reception: parseInt(document.getElementById('nc-s1').value),
      counseling: parseInt(document.getElementById('nc-s2').value),
      hospitality: parseInt(document.getElementById('nc-s3').value),
      environment: parseInt(document.getElementById('nc-s4').value)
    },
    reception: { greeting: "", appearance: "", waitTime: "", flow: [], smoothness: "" },
    counseling: { impression: "", hearing: { deepDive: "", lifestyle: "" }, explanation: { clarity: "", terminology: "", tools: [] }, proposal: { options: "", proscons: "", pricing: document.getElementById('nc-pricing').value }, closing: { anxietyRelief: "", decisionPrompt: "", nextBooking: "" } },
    hospitality: { empathy: "", listening: "", language: "", distance: "" },
    environment: { cleanliness: "", equipment: "", privacy: "", teamwork: "" },
    strengths: document.getElementById('nc-strengths').value.split('\n').filter(s => s.trim()),
    impressivePoints: [],
    improvements: { counseling: document.getElementById('nc-improvements').value, hospitality: "", operation: "" },
    suggestions: { adopt: [], immediate: "", longterm: "" },
    summary: document.getElementById('nc-summary').value,
    pricing: document.getElementById('nc-pricing').value
  };
  // localStorageに追加医院を保存
  const added = loadData('added-clinics', []);
  added.push(newClinic);
  saveData('added-clinics', added);
  // clinics配列に追加して再描画
  clinics.push(newClinic);
  renderCompetitors();
  document.getElementById('clinic-add-modal').hidden = true;
  // フォームリセット
  ['nc-name','nc-time','nc-address','nc-da','nc-dr','nc-pricing','nc-strengths','nc-improvements','nc-summary'].forEach(id => document.getElementById(id).value = '');
  } finally {
    if (btn) setTimeout(() => { btn.disabled = false; }, 600);
  }
}

function openDocModal(clinicName, type) {
  document.getElementById('doc-clinic').value = clinicName;
  document.getElementById('doc-modal-title').textContent = clinicName + ' - ' + type + 'を追加';
  document.getElementById('doc-type').value = type || '見積書';
  document.getElementById('doc-name').value = '';
  document.getElementById('doc-url').value = '';
  document.getElementById('doc-modal').hidden = false;
}

async function saveDocument() {
  const name = document.getElementById('doc-name').value.trim();
  const url = document.getElementById('doc-url').value.trim();
  if (!name || !url) return;
  await sb.from('documents').insert({
    name, type: document.getElementById('doc-type').value,
    clinic: document.getElementById('doc-clinic').value.trim(), url
  });
  document.getElementById('doc-modal').hidden = true;
  showToast('資料を登録しました');
  renderDocuments();
  renderClinicDocs();
}

async function deleteDocument(id) {
  if (!confirm('この資料を削除しますか？')) return;
  await sb.from('documents').delete().eq('id', id);
  showToast('資料を削除しました');
  renderDocuments();
  renderClinicDocs();
}

async function renderDocuments() {
  const docs = await getDocuments();
  document.getElementById('tc-docs').textContent = docs.length;
}

async function renderClinicDocs() {
  const docs = await getDocuments();
  const iconClass = (type) => ['見積書','パンフレット','カウンセリング資料'].includes(type) ? 'doc-pdf' : type === '録音' ? 'doc-audio' : type === '写真' ? 'doc-photo' : type === 'データ' ? 'doc-data' : 'doc-other';
  const iconText = (type) => ['見積書','パンフレット','カウンセリング資料'].includes(type) ? 'PDF' : type === '録音' ? '♪' : type === '写真' ? '📷' : type === 'データ' ? '📊' : '📄';

  clinics.forEach(c => {
    const el = document.getElementById('clinic-docs-' + c.id);
    const countEl = document.getElementById('doc-count-' + c.id);
    if (!el) return;
    const clinicDocs = docs.filter(d => d.clinic === c.name);
    if (countEl) countEl.textContent = clinicDocs.length > 0 ? clinicDocs.length + '件' : '';
    el.innerHTML = clinicDocs.map(d => `
      <a href="${d.url}" target="_blank" rel="noopener" class="resource-item" style="padding:8px 10px;margin-bottom:4px" onclick="event.stopPropagation()">
        <div class="resource-icon ${iconClass(d.type)}" style="width:28px;height:28px;font-size:11px">${iconText(d.type)}</div>
        <div class="resource-meta">
          <div class="doc-title" style="font-size:12px">${d.name}</div>
          <div class="doc-sub" style="font-size:10px">${d.type}</div>
        </div>
        ${d.type === '録音' ? `<button class="btn btn-outline" style="font-size:10px;padding:3px 8px;margin-right:4px;background:#7c3aed;color:#fff;border-color:#7c3aed" onclick="event.preventDefault();event.stopPropagation();openCompetitorAIModal(${d.id},'${(d.clinic||'').replace(/'/g,"&apos;")}','${(d.name||'').replace(/'/g,"&apos;")}')">🤖 AI</button>` : ''}
        <button class="resource-delete" style="width:24px;height:24px;font-size:12px" onclick="event.preventDefault();event.stopPropagation();deleteDocument(${d.id})">×</button>
      </a>
    `).join('');
  });
}

// === Bookings ===
const BK_SHEET_ID = '10misKpAtMitwIagGDUoMvQS7U9pfEQ0ODxG8A7DLzaQ';
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbw5VtL4GCD7sJgRqIKd52THJNaFCf7FNJ2UGs1HNysoJf-knYyXa7sPGj6D5p7t60Vt2A/exec';
let bookingsData = [];

async function loadBookings() {
  try {
    document.getElementById('bk-count').textContent = '読み込み中...';

    // 全シートを並列で取得（高速化）
    const selectSheets = [
      {sheet: '%E9%8A%80%E5%BA%A7%E3%82%BB%E3%83%AC%E3%82%AF%E3%83%88%E3%82%BF%E3%82%A4%E3%83%97', facility: 'BF銀座'},
      {sheet: '%E3%82%A6%E3%82%A3%E3%82%BA%E3%82%BB%E3%83%AC%E3%82%AF%E3%83%88%E3%82%BF%E3%82%A4%E3%83%97', facility: 'ウィズ'},
      {sheet: '%E4%BA%AC%E9%83%BD%E3%82%BB%E3%83%AC%E3%82%AF%E3%83%88%E3%82%BF%E3%82%A4%E3%83%97', facility: '京都'},
      {sheet: '%E3%83%AB%E3%83%9F%E3%83%8A%E3%82%B9%E3%82%BB%E3%83%AC%E3%82%AF%E3%83%88%E3%82%BF%E3%82%A4%E3%83%97', facility: 'ルミナス'},
    ];

    const allFetches = [
      fetch(`https://docs.google.com/spreadsheets/d/${BK_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=%E5%85%83%E3%83%87%E3%83%BC%E3%82%BF`).then(r => r.text()).then(csv => parseCSV(csv).map(d => ({...d, tool: 'DXHUB'}))),
      ...selectSheets.map(s => fetch(`https://docs.google.com/spreadsheets/d/${BK_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${s.sheet}`).then(r => r.text()).then(csv => parseSelectCSV(csv, s.facility)).catch(() => []))
    ];

    const results = await Promise.all(allFetches);
    bookingsData = results.flat();

    // 手動登録データをDBから読み込んで追加
    try {
      const { data: manualData } = await sb.from('manual_bookings').select('*').order('created_at', { ascending: false });
      if (manualData && manualData.length) {
        manualData.forEach(d => {
          bookingsData.push({
            applyDate: d.apply_date, bookDate: d.book_date, name: d.name,
            service: d.service, facility: d.facility, email: d.email,
            phone: d.phone, source: d.source, status: d.status, tool: '手動'
          });
        });
      }
    } catch(e) { console.warn('Manual bookings load error:', e); }

    // DBからステータス・メモを読み込んで上書き
    try {
      const { data: dbStatuses } = await sb.from('booking_status').select('*');
      if (dbStatuses && dbStatuses.length) {
        const statusMap = {};
        dbStatuses.forEach(s => {
          statusMap[s.name + '|' + s.apply_date] = s;
          if (s.updated_at) setVersion('booking_status', s.name + '|' + s.apply_date, s.updated_at);
        });
        bookingsData.forEach(d => {
          const key = d.name + '|' + d.applyDate;
          const exact = statusMap[key];
          let dbRow = exact;
          if (!dbRow) {
            const nnTarget = normName(d.name);
            const dateKey = normDateKey(d.bookDate || d.applyDate);
            const candidate = dbStatuses.find(s => normName(s.name) === nnTarget && normDateKey(s.apply_date) === dateKey);
            if (candidate) dbRow = candidate;
          }
          if (dbRow) {
            if (dbRow.status) d.status = dbRow.status;
            if (dbRow.contract_service) d.contractService = dbRow.contract_service;
            if (dbRow.contract_amount) d.contractAmount = dbRow.contract_amount;
            if (dbRow.payment_month) d.paymentMonth = dbRow.payment_month;
            if (dbRow.incentive_month) d.incentiveMonth = dbRow.incentive_month;
            if (dbRow.incentive_paid !== undefined) d.incentivePaid = dbRow.incentive_paid;
            if (dbRow.paid_at !== undefined) d.paidAt = dbRow.paid_at;
            if (dbRow.paid_by !== undefined) d.paidBy = dbRow.paid_by;
            if (dbRow.memo) d._memo = dbRow.memo;
            else if (dbRow.bf_memo) d._memo = dbRow.bf_memo;
            if (dbRow.book_date) d.bookDate = dbRow.book_date;
          }
          // メモだけは名前だけのフォールバック: 同じ正規化名+医院 の booking_status 行からメモを取得
          if (!d._memo) {
            const nnTarget = normName(d.name);
            const fTarget = normFac(d.facility);
            const fallback = dbStatuses.find(s => normName(s.name) === nnTarget && (s.memo || s.bf_memo));
            if (fallback) {
              d._memo = fallback.memo || fallback.bf_memo;
            }
          }
        });
      }
    } catch(e) { console.warn('DB status load error:', e); }

    // localStorage bk-extra からユーザー編集を反映
    try {
      const bkEx = loadData('bk-extra', {});
      bookingsData.forEach(d => {
        const key = d.name + '|' + d.applyDate;
        const ex = bkEx[key];
        if (!ex) return;
        if (ex.editedBookDate) d.bookDate = ex.editedBookDate;
        if (ex.editedApplyDate) d.applyDate = ex.editedApplyDate;
        if (ex.editedService) d.service = ex.editedService;
        if (ex.editedFacility) d.facility = ex.editedFacility;
        if (ex.editedPhone) d.phone = ex.editedPhone;
        if (ex.editedEmail) d.email = ex.editedEmail;
        if (ex.editedSource) d.source = ex.editedSource;
        if (ex.editedStatus) d.status = ex.editedStatus;
        if (ex.editedIncentivePaid !== undefined) {
          d.incentivePaid = ex.editedIncentivePaid;
          if (ex.editedPaidAt !== undefined) d.paidAt = ex.editedPaidAt;
          if (ex.editedPaidBy !== undefined) d.paidBy = ex.editedPaidBy;
        }
        // 名前はキーになっているので最後に反映
        if (ex.editedName) d.name = ex.editedName;
      });
    } catch(e) { console.warn('bk-extra apply error:', e); }

    // プロモ率を読み込み (毎ロード時に最新化)
    try {
      await loadPromoRates();
      // 成約金額が入力済みでインセが0/未設定の行は自動再計算
      const bkEx2 = loadData('bk-extra', {});
      let recalcCount = 0;
      bookingsData.forEach(d => {
        const key = d.name + '|' + d.applyDate;
        const ex = bkEx2[key] || {};
        const amt = Number(ex.contractAmount || d.contractAmount || 0);
        const curInc = Number(ex.incentiveAmount || d.incentiveAmount || 0);
        if (amt > 0 && curInc === 0) {
          const inc = calcIncentive(d.source, amt);
          if (inc) {
            if (!bkEx2[key]) bkEx2[key] = {};
            bkEx2[key].incentiveAmount = inc;
            d.incentiveAmount = inc;
            // DBにも書き戻し
            (async () => {
              const res = await safeSave({ type:'upsert', table:'booking_status', payload: { name: d.name, apply_date: d.applyDate, incentive_amount: inc }, options: { onConflict:'name,apply_date' } });
              if (res && res.ok === false) console.warn('incentive upsert queued', d.name);
            })();
            recalcCount++;
          }
        } else if (ex.incentiveAmount) {
          d.incentiveAmount = Number(ex.incentiveAmount);
        }
      });
      if (recalcCount > 0) {
        saveData('bk-extra', bkEx2);
        console.debug(`インセを${recalcCount}件自動計算しました`);
      }
    } catch(e) { console.warn('promo rate auto-calc skipped', e); }

    // BF相談のbf_status表示のためBFキャッシュもロード
    try { await loadBFLifecycleData(); } catch(_){}

    populateBookingFilters();
    renderBookings();
    renderAnalysis();
    // プロモ率のdatalistも更新
    if (document.getElementById('pr-code-options')) renderPromoRates();
    // 管理タブの選択肢を更新
    const admPromos = document.getElementById('adm-promos');
    const admServices = document.getElementById('adm-services');
    const admFacilities = document.getElementById('adm-facilities');
    if (admPromos) {
      const promos = [...new Set(bookingsData.map(d => d.source).filter(Boolean))].sort();
      admPromos.innerHTML = promos.map(p => `<option value="${p}">${p}</option>`).join('');
    }
    if (admServices) {
      const svcs = [...new Set(bookingsData.map(d => d.service).filter(Boolean))].sort();
      admServices.innerHTML = svcs.map(s => `<option value="${s}">${s.length>20?s.slice(0,20)+'…':s}</option>`).join('');
    }
    if (admFacilities) {
      const facs = [...new Set(bookingsData.map(d => d.facility).filter(Boolean))].sort();
      admFacilities.innerHTML = facs.map(f => `<option value="${f}">${f.length>15?f.slice(0,15)+'…':f}</option>`).join('');
    }
  } catch (e) {
    console.error('Bookings load error:', e);
    document.getElementById('bk-tbody').innerHTML = '<tr><td colspan="16" style="text-align:center;color:var(--red)">データ取得失敗。更新ボタンを押してください。</td></tr>';
  }
}

function parseCSV(csv) {
  const lines = csv.split('\n');
  if (lines.length < 2) return [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 5 || !cols[2]) continue;
    rows.push({
      applyDate: cols[0] || '',
      bookDate: cols[1] || '',
      name: cols[2] || '',
      service: cols[3] || '',
      facility: cols[4] || '',
      email: cols[5] || '',
      phone: cols[6] || '',
      source: cols[7] || '',
      status: cols[8] || '未対応'
    });
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; }
    else if (c === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += c; }
  }
  result.push(current.trim());
  return result;
}

function parseSelectCSV(csv, facility) {
  const lines = csv.split('\n');
  if (lines.length < 2) return [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 3 || !cols[2]) continue;
    // 電話番号フォーマット
    let phone = (cols[3] || '').replace(/[-\s]/g, '');
    rows.push({
      tool: 'セレクト',
      applyDate: cols[0] || '',
      bookDate: cols[1] || '',
      name: cols[2] || '',
      service: '矯正無料相談',
      facility: facility,
      email: cols[4] || '',
      phone: phone,
      source: 'セレクトタイプ',
      status: ''
    });
  }
  return rows;
}

function populateBookingFilters() {
  let filteredForOptions = bookingsData;
  // カスタム・プロモユーザーの場合、自分のデータのみでフィルター選択肢を作る
  if (userRole === 'custom') {
    const cPromos = JSON.parse(sessionStorage.getItem('customPromos') || '[]');
    const cServices = JSON.parse(sessionStorage.getItem('customServices') || '[]');
    const cFacilities = JSON.parse(sessionStorage.getItem('customFacilities') || '[]');
    if (cPromos.length) filteredForOptions = filteredForOptions.filter(d => d.source && cPromos.includes(d.source));
    if (cServices.length) filteredForOptions = filteredForOptions.filter(d => d.service && cServices.includes(d.service));
    if (cFacilities.length) filteredForOptions = filteredForOptions.filter(d => d.facility && cFacilities.includes(d.facility));
  } else if (_hasPromoRestriction()) {
    filteredForOptions = filteredForOptions.filter(d => _matchesAllowedPromo(d.source));
  }
  const facilities = [...new Set(filteredForOptions.map(d => normFac(d.facility)).filter(f => f && f !== '-'))].sort();
  const promos = [...new Set(filteredForOptions.map(d => d.source).filter(Boolean))].sort();
  const services = [...new Set(filteredForOptions.map(d => normSvc(d.service)).filter(s => s && s !== '-'))].sort();
  const contractServices = ['BF','矯正(表)','矯正(裏)','矯正(ﾋﾟｰｽ)','ﾗﾌﾞﾘｴ','ｲﾝﾌﾟﾗﾝﾄ'];

  // プロモを件数順にソート
  const promoCounts2 = {};
  filteredForOptions.forEach(d => { if (d.source) promoCounts2[d.source] = (promoCounts2[d.source]||0) + 1; });
  const promosSorted = promos.sort((a, b) => (promoCounts2[b]||0) - (promoCounts2[a]||0));
  const promoOpts = promosSorted.map(p => ({ value: p, label: `${p} (${promoCounts2[p]||0})` }));

  // Multi-select 初期化 (初回のみ)
  ensureBkMultiSelects();
  const dd = window._bkDD;
  dd.tool.setOptions([{value:'DXHUB',label:'DXHUB'},{value:'セレクト',label:'セレクト'}]);
  dd.facility.setOptions(facilities);
  dd.promo.setOptions(promoOpts);
  dd.service.setOptions(services);
  dd.contract.setOptions(contractServices);
  // status/contract は固定options (ensureBkMultiSelects で一度だけセット)

  // プロモ・カスタムユーザーはQuick行を非表示
  const quickEl = document.getElementById('bk-quick-promos');
  if (quickEl && (userRole === 'promo' || userRole === 'custom' || _hasPromoRestriction())) {
    quickEl.style.display = 'none';
    return;
  }
  // クイックプロモボタン（上位5件）
  const promoCounts = {};
  getFilteredBookingsData().forEach(d => { if (d.source) { promoCounts[d.source] = (promoCounts[d.source]||0) + 1; } });
  const top5 = Object.entries(promoCounts).sort((a,b) => b[1]-a[1]).slice(0, 5);
  if (quickEl) {
    quickEl.innerHTML = '<span style="font-size:11px;color:var(--text-muted);margin-right:4px">Quick:</span>' + top5.map(([name]) =>
      `<button class="btn btn-outline bk-quick-promo" style="font-size:10px;padding:3px 8px;min-height:24px">${name.length > 18 ? name.slice(0,18)+'…' : name}</button>`
    ).join('');
    quickEl.querySelectorAll('.bk-quick-promo').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        const promoSet = window._bkDD?.promo?.selected;
        if (!promoSet) return;
        const val = top5[i][0];
        const isActive = promoSet.has(val) && promoSet.size === 1;
        quickEl.querySelectorAll('.bk-quick-promo').forEach(b => { b.style.background = ''; b.style.color = ''; b.style.borderColor = ''; });
        promoSet.clear();
        if (!isActive) {
          promoSet.add(val);
          btn.style.background = '#dbeafe';
          btn.style.color = '#1d4ed8';
          btn.style.borderColor = '#93c5fd';
        }
        window._bkDD.promo.updateLabel();
        renderBookings();
      });
    });
  }
}

// Multi-select 初期化 (予約一覧)
function ensureBkMultiSelects() {
  if (window._bkDD) return;
  const triggerRedraw = () => { if (typeof renderBookings === 'function') renderBookings(); };
  const statusList = ['要対応','未対応','予約連絡待ち','後追いLINE済み','確認済','予約変更','来院済','成約','キャンセル','除外'];
  const dd = {
    tool: createMultiSelectDropdown({ label:'ツール', options:[], selected:new Set(), onChange:triggerRedraw }),
    facility: createMultiSelectDropdown({ label:'医院', options:[], selected:new Set(), onChange:triggerRedraw }),
    promo: createMultiSelectDropdown({ label:'プロモ', options:[], selected:new Set(), onChange:triggerRedraw }),
    service: createMultiSelectDropdown({ label:'相談', options:[], selected:new Set(), onChange:triggerRedraw }),
    // 既存のステータスデフォルト = 全表示 (空) なので Set は空で開始
    status: createMultiSelectDropdown({ label:'状態', options:statusList, selected:new Set(), onChange:triggerRedraw }),
    contract: createMultiSelectDropdown({ label:'成約商材', options:[], selected:new Set(), onChange:triggerRedraw }),
  };
  const fill = (id, obj) => { const s = document.getElementById(id); if (s) s.replaceWith(obj.buttonElement); };
  fill('bk-tool-slot', dd.tool);
  fill('bk-facility-slot', dd.facility);
  fill('bk-promo-slot', dd.promo);
  fill('bk-service-slot', dd.service);
  fill('bk-status-slot', dd.status);
  fill('bk-contract-slot', dd.contract);
  window._bkDD = dd;
}

function renderBookings() {
  // #13 loadData を一度だけ読み出して共有 (連打解消)
  const _bkExtra = loadData('bk-extra', {});
  const searchVal = (document.getElementById('bk-search').value || '').trim().toLowerCase();
  const dd = window._bkDD || {};
  const toolSet = dd.tool?.selected || new Set();
  const facSet = dd.facility?.selected || new Set();
  const promoSet = dd.promo?.selected || new Set();
  const svcSet = dd.service?.selected || new Set();
  const statusSet = dd.status?.selected || new Set();
  const contractSet = dd.contract?.selected || new Set();
  const monthFilter = document.getElementById('bk-month').value;

  let filtered = bookingsData;
  if (searchVal) filtered = filtered.filter(d => d.name && d.name.toLowerCase().includes(searchVal));
  if (toolSet.size) filtered = filtered.filter(d => toolSet.has(d.tool));
  // プロモユーザーの場合、許可されたプロモのみ表示
  if (_hasPromoRestriction()) {
    filtered = filtered.filter(d => _matchesAllowedPromo(d.source));
    const pbtn = window._bkDD?.promo?.buttonElement;
    if (pbtn) pbtn.style.display = 'none';
  }
  // カスタムユーザーの制限（完全一致）
  if (userRole === 'custom') {
    const cPromos = JSON.parse(sessionStorage.getItem('customPromos') || '[]');
    const cServices = JSON.parse(sessionStorage.getItem('customServices') || '[]');
    const cFacilities = JSON.parse(sessionStorage.getItem('customFacilities') || '[]');
    if (cPromos.length > 0) {
      filtered = filtered.filter(d => d.source && cPromos.includes(d.source));
    }
    if (cServices.length > 0) {
      filtered = filtered.filter(d => d.service && cServices.includes(d.service));
    }
    if (cFacilities.length > 0) {
      filtered = filtered.filter(d => d.facility && cFacilities.includes(d.facility));
    }
  }
  if (facSet.size) filtered = filtered.filter(d => facSet.has(normFac(d.facility)));
  if (promoSet.size) filtered = filtered.filter(d => promoSet.has(d.source));
  if (svcSet.size) filtered = filtered.filter(d => svcSet.has(normSvc(d.service)));
  if (statusSet.size) {
    const td = new Date(); td.setHours(0,0,0,0);
    filtered = filtered.filter(d => {
      const s = d.status || '未対応';
      for (const sel of statusSet) {
        if (sel === '要対応') {
          if ((!d.status || d.status === '未対応')) {
            const bd = parseDate(d.bookDate);
            if (bd && bd < td) return true;
          }
        } else if (sel === '未対応') {
          if (!d.status || d.status === '未対応') return true;
        } else if (s === sel) return true;
      }
      return false;
    });
  }
  if (contractSet.size) filtered = filtered.filter(d => contractSet.has(d.contractService));
  // 期間フィルター
  // v273: 予約日基準 (デフォルト) と 登録日基準 (申込) を選べるように
  const periodFilter = document.getElementById('bk-period')?.value || '';
  if (periodFilter) {
    const ymOf = (d, useApply) => {
      const src = useApply ? (d.applyDate || '') : (d.bookDate || d.applyDate || '');
      const m = String(src).match(/(\d{4})\D+(\d{1,2})/);
      return m ? m[1]+'-'+String(parseInt(m[2])).padStart(2,'0') : '';
    };
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    if (periodFilter === 'thisMonth') {
      // 予約日基準で今月
      filtered = filtered.filter(d => ymOf(d, false) === ym);
    } else if (periodFilter === 'thisMonthApply') {
      // 登録日基準で今月
      filtered = filtered.filter(d => ymOf(d, true) === ym);
    } else if (periodFilter === 'lastMonth') {
      const last = new Date(now); last.setMonth(last.getMonth()-1);
      const lym = `${last.getFullYear()}-${String(last.getMonth()+1).padStart(2,'0')}`;
      filtered = filtered.filter(d => ymOf(d, false) === lym);
    } else if (periodFilter === 'fiscal') {
      const fy = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear()-1;
      filtered = filtered.filter(d => ymOf(d, false) >= fy+'-07');
    }
  }
  if (monthFilter) {
    filtered = filtered.filter(d => getYM(d) === monthFilter);
  }
  // 除外非表示 (「除外も表示」チェックがOFFなら除外行を隠す)
  const showExcluded = document.getElementById('bk-show-excluded')?.checked;
  if (!showExcluded) {
    filtered = filtered.filter(d => d.status !== '除外');
  }
  // 重複フィルター (同一正規化名+医院 が2件以上ある行のみ表示)
  if (window._bkDupFilter) {
    const groups = {};
    filtered.forEach(d => {
      const key = normName(d.name) + '|' + normFac(d.facility);
      if (!groups[key]) groups[key] = [];
      groups[key].push(d);
    });
    const dupKeys = new Set(Object.entries(groups).filter(([k,arr]) => arr.length > 1).map(([k])=>k));
    filtered = filtered.filter(d => dupKeys.has(normName(d.name) + '|' + normFac(d.facility)));
  }
  // 今日予約フィルター（クリアするまで保持）
  if (window._bkTodayFilter) {
    const td3 = new Date(); const todayStr = `${td3.getFullYear()}-${String(td3.getMonth()+1).padStart(2,'0')}-${String(td3.getDate()).padStart(2,'0')}`;
    filtered = filtered.filter(d => {
      if (!d.bookDate) return false;
      const m = d.bookDate.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
      if (!m) return false;
      const bd = `${m[1]}-${String(parseInt(m[2])).padStart(2,'0')}-${String(parseInt(m[3])).padStart(2,'0')}`;
      return bd === todayStr;
    });
  }
  // 進捗フィルター（予約日が昨日以前の人、クリアするまで保持）
  if (window._bkProgressFilter) {
    const td2 = new Date(); td2.setHours(0,0,0,0);
    filtered = filtered.filter(d => {
      const bd = parseDate(d.bookDate);
      return bd && bd < td2;
    });
  }
  // 日付ピンポイントフィルター
  if (window._bkDateFilter) {
    const df = window._bkDateFilter;
    filtered = filtered.filter(d => {
      if (!d.bookDate) return false;
      const m = d.bookDate.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
      if (!m) return false;
      const bd = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
      return bd === df;
    });
    window._bkDateFilter = null; // 1回限り
  }

  // Stats（除外は統計から除く）
  const active = filtered.filter(d => d.status !== '除外');
  const total = active.length;
  const cancelled = active.filter(d => d.status === 'キャンセル').length;
  const pending = active.filter(d => !d.status || d.status === '未対応').length;
  const visited = active.filter(d => isVisitedStatus(d.status)).length;
  const contracted = active.filter(d => d.status === '成約').length;
  // 来院率 = 予約日が昨日以前の人の中で来院済+成約の割合
  const todayForRate = new Date(); todayForRate.setHours(0,0,0,0);
  const pastBookings = active.filter(d => { const bd = parseDate(d.bookDate); return bd && bd < todayForRate; });
  const pastVisited = pastBookings.filter(d => isVisitedStatus(d.status)).length;
  const visitRate = pastBookings.length > 0 ? Math.round(pastVisited / pastBookings.length * 100) : 0;

  // 成約金額集計（フィルター済みデータから）
  const bkExtraStats = _bkExtra;
  let totalAmount = 0;
  active.forEach(d => {
    const key = d.name + '|' + d.applyDate;
    const extra = bkExtraStats[key] || {};
    const amt = Number(extra.contractAmount) || Number(d.contractAmount) || 0;
    if (amt) totalAmount += amt;
  });

  // 未対応アラート数
  const todayCheck = new Date(); todayCheck.setHours(0,0,0,0);
  const overdueCount = filtered.filter(d => {
    if (d.status && d.status !== '未対応') return false;
    const bd = parseDate(d.bookDate);
    return bd && bd < todayCheck;
  }).length;

  document.getElementById('bk-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">予約数</span><span class="stat-num">${total}</span></div>
    ${overdueCount > 0 ? `<div class="stat-card" style="border-color:var(--red)"><span class="stat-label" style="color:var(--red)">要対応</span><span class="stat-num" style="color:var(--red)">${overdueCount}</span></div>` : ''}
    <div class="stat-card"><span class="stat-label">未対応</span><span class="stat-num">${pending}</span></div>
    <div class="stat-card"><span class="stat-label">キャンセル</span><span class="stat-num" style="color:var(--red)">${cancelled}</span></div>
    <div class="stat-card"><span class="stat-label">来院済</span><span class="stat-num">${visited}</span><span class="stat-yoy" style="color:var(--text-sub);font-size:11px">来院率 ${visitRate}%（${pastVisited}/${pastBookings.length}）</span></div>
    <div class="stat-card"><span class="stat-label">成約</span><span class="stat-num" style="color:var(--green)">${contracted}</span><span class="stat-yoy" style="color:var(--text-sub);font-size:11px">成約率 ${visited > 0 ? Math.round(contracted/visited*100) : 0}%（${contracted}/${visited}）</span></div>
    <div class="stat-card"><span class="stat-label">成約金額</span><span class="stat-num">¥${fmt(totalAmount)}</span></div>
  `;
  // インセ金額は別途集計不要（各行で入力）

  // メモデータを付与
  const memoData = loadData('bk-memos', {});
  filtered.forEach(d => { const key = d.name+'|'+d.applyDate; d._memo = memoData[key] || ''; });

  document.getElementById('bk-count').textContent = `${filtered.length}件`;

  // Table
  const tbody = document.getElementById('bk-tbody');
  // v264 ピン留めセット
  const pinnedSet = getPinnedBookings();
  const isPinned = (d) => pinnedSet.has(d.name + '|' + d.applyDate);
  // 重複モードの時は 正規化名+医院 でグルーピングして隣接表示
  const baseSorted = window._bkDupFilter
    ? [...filtered].sort((a, b) => {
        const ka = normName(a.name) + '|' + normFac(a.facility);
        const kb = normName(b.name) + '|' + normFac(b.facility);
        if (ka !== kb) return ka.localeCompare(kb);
        return (b.applyDate || '').localeCompare(a.applyDate || '');
      })
    : [...filtered].sort((a, b) => (b.applyDate || '').localeCompare(a.applyDate || ''));
  // ピン留めを先頭へ
  const sorted = [...baseSorted].sort((a, b) => (isPinned(b) ? 1 : 0) - (isPinned(a) ? 1 : 0));

  const statusBadge = (s) => {
    if (!s || s === '未対応') return '<span class="badge badge-default">未対応</span>';
    if (s === 'キャンセル') return '<span class="badge badge-danger">キャンセル</span>';
    if (s === '来院済') return '<span class="badge badge-warning">来院済</span>';
    if (s === '成約') return '<span class="badge badge-success">成約</span>';
    if (s === '確認済') return '<span class="badge badge-default" style="border-color:#6366f1;color:#6366f1">確認済</span>';
    if (s === '予約連絡待ち') return '<span class="badge badge-default" style="border-color:#a855f7;color:#7c3aed;background:#f5f3ff">予約連絡待ち</span>';
    if (s === '後追いLINE済み') return '<span class="badge badge-default" style="border-color:#06b6d4;color:#0891b2;background:#ecfeff">後追いLINE済み</span>';
    if (s === '予約変更') return '<span class="badge badge-default" style="border-color:#f59e0b;color:#b45309;background:#fef3c7">予約変更</span>';
    return `<span class="badge badge-default">${esc(s)}</span>`;
  };

  // fmtApplyDate, fmtBookDate are now global functions
  const shortService = (s) => {
    if (!s) return '-';
    if (s.includes('ラミネート') || s.includes('ブラックフィルム')) return 'BF';
    if (s.includes('矯正')) return '矯正';
    if (s.includes('セラミック')) return 'セラミック';
    if (s.includes('インプラント')) return 'インプラント';
    return s.replace(/相談|無料|　/g, '').slice(0, 6);
  };

  const shortFac = (f) => {
    if (!f) return '-';
    const map = {'BF銀座歯科・矯正歯科':'BF銀座','BF銀座歯科　矯正歯科':'BF銀座','WITH DENTAL CLINIC':'ウィズ','名古屋エスカ歯科・矯正歯科':'エスカ','名古屋アール歯科・矯正歯科':'アール','名古屋ルミナス歯科・矯正歯科':'ルミナス','名古屋茶屋歯科・矯正歯科':'茶屋','小牧歯科・矯正歯科':'小牧','知立歯科・矯正歯科':'知立','八事歯科・矯正歯科':'八事','岩田歯科・矯正歯科':'岩田','大森歯科・矯正歯科':'大森','京都歯科・矯正歯科':'京都'};
    for (const [key, val] of Object.entries(map)) { if (f.includes(key) || f.includes(val)) return val; }
    if (f.includes('BF銀座') || f.includes('銀座')) return 'BF銀座';
    if (f.includes('ウィズ') || f.includes('WITH') || f.includes('ウイズ')) return 'ウィズ';
    if (f.includes('エスカ')) return 'エスカ';
    if (f.includes('アール')) return 'アール';
    if (f.includes('ルミナス')) return 'ルミナス';
    if (f.includes('茶屋')) return '茶屋';
    if (f.includes('小牧')) return '小牧';
    if (f.includes('知立')) return '知立';
    if (f.includes('八事')) return '八事';
    if (f.includes('岩田')) return '岩田';
    if (f.includes('大森')) return '大森';
    if (f.includes('京都')) return '京都';
    return f.length > 8 ? f.slice(0, 8) + '…' : f;
  };
  const fmtPhone = (p) => {
    if (!p || p === '0') return '-';
    let s = String(p).replace(/[^0-9]/g, '');
    if (s.length >= 10 && !s.startsWith('0')) s = '0' + s;
    return s;
  };
  // 未対応アラート判定
  const today = new Date(); today.setHours(0,0,0,0);
  const isOverdue = (d) => {
    if (d.status && d.status !== '未対応') return false;
    if (!d.bookDate) return false;
    // #12 parseDate 統一 (タイムゾーン差回避)
    const bd = parseDate(d.bookDate);
    return bd ? bd < today : false;
  };

  const isAdmin = canEditContent();
  const displayLimit = window._bkDisplayLimit || 200;
  // 重複検出 (正規化名+医院 で2件以上あるもの)
  const dupCounts = {};
  sorted.forEach(d => {
    const k = normName(d.name) + '|' + normFac(d.facility);
    dupCounts[k] = (dupCounts[k] || 0) + 1;
  });
  tbody.innerHTML = sorted.slice(0, displayLimit).map((d, idx) => {
    const overdue = isOverdue(d);
    const dupKey = normName(d.name) + '|' + normFac(d.facility);
    const isDup = dupCounts[dupKey] > 1;
    const pinned = isPinned(d);
    const dupStyle = isDup ? 'border-left:3px solid #f59e0b;' : (pinned ? 'border-left:3px solid #fbbf24;' : '');
    const rowStyle = dupStyle + (d.status==='除外' ? 'background:#f5f5f5;opacity:0.4;text-decoration:line-through' : d.status==='成約' ? 'background:#f0fdf4' : d.status==='来院済' ? 'background:#eff6ff' : d.status==='キャンセル' ? 'background:#f8f8f8;color:#9ca3af' : (!d.status||d.status==='未対応') ? 'background:#fff5f5' : '');
    return `<tr style="${rowStyle}" data-bk-name="${esc(d.name)}" data-bk-apply="${esc(d.applyDate)}">
    <td class="bk-select-col" style="text-align:center;padding:4px">${isAdmin?`<input type="checkbox" class="bk-row-select" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" style="cursor:pointer;width:14px;height:14px;margin:0">`:''}</td>
    <td style="white-space:nowrap;font-size:9px"><span class="badge ${d.tool==='セレクト'?'badge-warning':'badge-default'}" style="font-size:8px;padding:1px 4px">${d.tool==='セレクト'?'セレクト':'DX'}</span></td>
    <td style="white-space:nowrap;font-size:10px;color:var(--text-sub)">${fmtApplyDate(d.applyDate)}</td>
    <td style="white-space:nowrap;font-size:10px;${isAdmin?'cursor:pointer;text-decoration:underline dotted':''}" ${isAdmin?`class="bk-edit-date" data-idx="${idx}" title="クリックで変更"`:''}>
      ${esc(fmtBookDate(d.bookDate))}</td>
    <td style="white-space:nowrap;font-size:11px;font-weight:500;text-align:left">
      <button type="button" class="bk-pin-btn" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" title="${pinned?'ピン解除':'ピン留め'}" style="background:none;border:none;cursor:pointer;padding:0 4px 0 0;font-size:13px;line-height:1;color:${pinned?'#f59e0b':'#d1d5db'};vertical-align:middle">${pinned?'★':'☆'}</button><span ${isAdmin?`class="bk-row-edit" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" title="クリックで編集" style="cursor:pointer;text-decoration:underline dotted"`:''}>${esc(maskName(d.name))}</span></td>
    <td style="font-size:10px;white-space:nowrap">${esc(normSvc(d.service))}</td>
    <td style="font-size:10px;white-space:nowrap">${esc(normFac(d.facility))}</td>
    <td style="font-size:10px;white-space:nowrap">${isAdmin ? esc(fmtPhone(d.phone)) : esc(maskPhone(d.phone) || '-')}</td>
    <td style="font-size:10px;color:var(--text-sub);white-space:nowrap;max-width:90px;overflow:hidden;text-overflow:ellipsis;text-align:left">${isAdmin ? esc(d.email || '-') : esc(maskEmail(d.email) || '-')}</td>
    <td style="font-size:9px;color:var(--text-muted);white-space:nowrap;max-width:80px;overflow:hidden;text-overflow:ellipsis">${esc(d.source || '-')}</td>
    <td style="text-align:center">${isAdmin ? (isBFBooking(d) ? (() => {
      const info = getBFInfo(d.name, d.applyDate) || {};
      const curBf = info.bf_status || '';
      const bfColor = BF_STATUSES.find(s => s.value === curBf)?.color || '';
      const bfStyle = curBf ? `background:${bfColor}22;color:${bfColor};border-color:${bfColor};font-weight:600` : '';
      return `<select class="form-select bk-bfstatus-select" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" style="font-size:10px;padding:2px 4px;width:100%;max-width:115px;text-align:center;${bfStyle}">
        <option value="">${d.status==='未対応'?'未対応':(d.status==='確認済'?'確認済':(d.status==='キャンセル'?'キャンセル':'未設定'))}</option>
        ${BF_STATUSES.map(s => `<option ${curBf===s.value?'selected':''}>${esc(s.value)}</option>`).join('')}
      </select>`;
    })() : `<select class="form-select bk-status-select" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" style="font-size:10px;padding:2px 4px;min-width:70px;text-align:center;${d.status==='来院済'?'background:#dbeafe;color:#1d4ed8':d.status==='成約'?'background:#dcfce7;color:#15803d':d.status==='キャンセル'?'background:#fee2e2;color:#b91c1c':d.status==='確認済'?'background:#f3e8ff;color:#7c3aed':d.status==='予約連絡待ち'?'background:#f5f3ff;color:#7c3aed;border-color:#a855f7':d.status==='後追いLINE済み'?'background:#ecfeff;color:#0891b2;border-color:#06b6d4':d.status==='予約変更'?'background:#fef3c7;color:#b45309;border-color:#f59e0b':d.status==='除外'?'background:#f5f5f5;color:#9ca3af':''}">
      <option ${(!d.status||d.status==='未対応')?'selected':''}>未対応</option>
      <option ${d.status==='予約連絡待ち'?'selected':''}>予約連絡待ち</option>
      <option ${d.status==='留守電'?'selected':''}>留守電</option>
      <option ${d.status==='折り返し'?'selected':''}>折り返し</option>
      <option ${d.status==='後追いLINE済み'?'selected':''}>後追いLINE済み</option>
      <option ${d.status==='確認済'?'selected':''}>確認済</option>
      <option ${d.status==='予約変更'?'selected':''}>予約変更</option>
      <option ${d.status==='来院済'?'selected':''}>来院済</option>
      ${isImplantBooking(d) ? `<option ${d.status==='検討中'?'selected':''}>検討中</option>` : ''}
      <option ${d.status==='成約'?'selected':''}>成約</option>
      ${isImplantBooking(d) ? `
        <option ${d.status==='P処置'?'selected':''}>P処置</option>
        <option ${d.status==='C処置'?'selected':''}>C処置</option>
        <option ${d.status==='CT/診断'?'selected':''}>CT/診断</option>
        <option ${d.status==='ガイド印象'?'selected':''}>ガイド印象</option>
        <option ${d.status==='手術予定'?'selected':''}>手術予定</option>
        <option ${d.status==='治癒期間'?'selected':''}>治癒期間</option>
        <option ${d.status==='印象'?'selected':''}>印象</option>
        <option ${d.status==='セット'?'selected':''}>セット</option>
        <option ${d.status==='完了'?'selected':''}>完了</option>
      ` : ''}
      <option ${d.status==='キャンセル'?'selected':''}>キャンセル</option>
      ${isImplantBooking(d) ? `<option ${d.status==='お断り'?'selected':''}>お断り</option>` : ''}
      <option ${d.status==='除外'?'selected':''}>除外</option>
    </select>`) : statusBadge(isBFBooking(d) ? (getBFInfo(d.name, d.applyDate)?.bf_status || d.status) : d.status)}</td>
    <td style="text-align:center">${(() => {
      const key = d.name + '|' + d.applyDate;
      const info = bfLifecycleCache[key] || {};
      const iso = info.bf_next_date || '';
      const mmdd = iso ? iso.substring(5).replace('-','/') : '';
      if (!isAdmin) return iso ? `<span style="font-size:10px">${mmdd}</span>` : '<span style="color:var(--text-muted)">-</span>';
      const label = mmdd || '年/月/日';
      const style = iso
        ? 'background:#dcfce7;border:1.5px solid #16a34a;color:#15803d;font-weight:600'
        : 'background:#fef3c7;border:1.5px solid #f59e0b;color:#92400e';
      return `<span style="display:inline-flex;gap:2px;align-items:center;position:relative">
        <button type="button" class="bk-next-date-btn" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-iso="${esc(iso)}" style="font-size:10px;padding:3px 6px;width:70px;text-align:center;border-radius:4px;cursor:pointer;${style}">${esc(label)}</button>
        <input type="date" class="bk-next-date-hidden" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" value="${esc(iso)}" style="position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none">
      </span>`;
    })()}</td>
    <td class="bk-memo-cell" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" title="${esc(d._memo||findAnyMemo(d.name)||'')}" style="${(() => {
      const memo = d._memo || findAnyMemo(d.name);
      // 内容を直接表示 (来院タブと同じスマートUI、次回予定とのカブり解消)
      const hasMemo = !!memo;
      return `font-size:10px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;text-align:left;padding:4px 8px;background:${hasMemo?'#fff8e1':'transparent'};border:1px dashed ${hasMemo?'#f9a825':'var(--border)'};border-radius:4px;color:${hasMemo?'#92400e':'#bbb'}`;
    })()}">${(() => {
      const memo = d._memo || findAnyMemo(d.name);
      if (!isAdmin) return memo ? '📝 ' + esc(typeof _flattenMemoForDisplay === 'function' ? _flattenMemoForDisplay(memo, 60) : memo) : '-';
      if (memo) return esc(typeof _flattenMemoForDisplay === 'function' ? _flattenMemoForDisplay(memo, 60) : memo);
      return '＋ メモ';
    })()}</td>
    <td style="text-align:center">${isAdmin ? `<select class="form-select bk-field-select" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="contractService" style="font-size:10px;padding:2px 4px;min-width:60px;text-align:center;${d.contractService?'background:#dcfce7;color:#15803d':(d.status==='成約'?'background:#fee2e2;color:#b91c1c;border-color:#ef4444;animation:pulse-red 2s ease-in-out infinite':'')}">
      <option value="">-</option>
      <option ${d.contractService==='BF'?'selected':''}>BF</option>
      <option ${d.contractService==='矯正(表)'?'selected':''}>矯正(表)</option>
      <option ${d.contractService==='矯正(裏)'?'selected':''}>矯正(裏)</option>
      <option ${d.contractService==='矯正(ﾋﾟｰｽ)'?'selected':''}>矯正(ﾋﾟｰｽ)</option>
      <option ${d.contractService==='ﾗﾌﾞﾘｴ'?'selected':''}>ﾗﾌﾞﾘｴ</option>
      <option ${d.contractService==='ｲﾝﾌﾟﾗﾝﾄ'?'selected':''}>ｲﾝﾌﾟﾗﾝﾄ</option>
    </select>` : esc(d.contractService || '-')}</td>
    <td>${isAdmin ? `<input type="text" inputmode="numeric" class="form-input bk-field-input bk-amt-input" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="contractAmount" value="${d.contractAmount?Number(d.contractAmount).toLocaleString():''}" placeholder="0" style="font-size:11px;padding:2px 6px;width:90px;text-align:right;font-variant-numeric:tabular-nums;${d.status==='成約'&&!Number(d.contractAmount)?'background:#fee2e2;color:#b91c1c;border-color:#ef4444;animation:pulse-red 2s ease-in-out infinite':''}">` : (d.contractAmount ? '¥'+fmt(d.contractAmount) : '-')}</td>
    <td style="position:relative">${isAdmin ? (() => { const v = d.paymentMonth||''; const lbl = v ? v.substring(2).replace('-','/') : 'YY/MM'; return `<button type="button" class="bk-month-btn" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="paymentMonth" data-iso="${esc(v)}" style="font-size:10px;padding:3px 6px;width:64px;background:#fff;border:1px solid var(--border);border-radius:4px;cursor:pointer;${v?'':'color:var(--text-muted)'}">${esc(lbl)}</button><input type="month" class="bk-month-hidden bk-field-input" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="paymentMonth" value="${esc(v)}" style="position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none">`; })() : esc(d.paymentMonth || '-')}</td>
    <td style="position:relative">${isAdmin ? (() => { const v = d.incentiveMonth||''; const lbl = v ? v.substring(2).replace('-','/') : 'YY/MM'; return `<button type="button" class="bk-month-btn" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="incentiveMonth" data-iso="${esc(v)}" style="font-size:10px;padding:3px 6px;width:64px;background:#fff;border:1px solid var(--border);border-radius:4px;cursor:pointer;${v?'':'color:var(--text-muted)'}">${esc(lbl)}</button><input type="month" class="bk-month-hidden bk-field-input" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="incentiveMonth" value="${esc(v)}" style="position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none">`; })() : esc(d.incentiveMonth || '-')}</td>
    <td>${isAdmin ? `<input type="text" inputmode="numeric" class="form-input bk-field-input bk-amt-input" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="incentiveAmount" value="${d.incentiveAmount?Number(d.incentiveAmount).toLocaleString():''}" placeholder="0" style="font-size:11px;padding:2px 6px;width:80px;text-align:right;font-variant-numeric:tabular-nums">` : (d.incentiveAmount ? '¥'+fmt(d.incentiveAmount) : '-')}</td>
    <td style="text-align:center;white-space:nowrap">${(() => {
      const paid = d.incentivePaid === true;
      const dateStr = d.paidAt ? (() => { const dt = new Date(d.paidAt); return isNaN(dt) ? '' : `${dt.getFullYear()}/${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`; })() : '';
      const byStr = d.paidBy ? ` by ${d.paidBy}` : '';
      const badge = paid
        ? `<span style="display:inline-block;padding:2px 8px;background:#dcfce7;color:#15803d;border:1px solid #86efac;border-radius:10px;font-size:10px;font-weight:600">🔒 請求済</span>${dateStr?`<div style="font-size:9px;color:#6b7280;margin-top:1px">${esc(dateStr)}${esc(byStr)}</div>`:''}`
        : `<span style="display:inline-block;padding:2px 8px;background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;border-radius:10px;font-size:10px;font-weight:600">未請求</span>`;
      const tip = paid ? '請求済みは管理者のみ解除可能' : 'クリックで請求済みにする';
      return `<span class="bk-incpaid-toggle" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-paid="${paid?1:0}" style="cursor:pointer;display:inline-block" title="${tip}">${badge}</span>`;
    })()}</td>
    <td>${isAdmin ? `<button class="bk-del-btn" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" title="この予約を削除" style="font-size:10px;padding:2px 6px;background:#fff;border:1px solid #fecaca;color:#c00;border-radius:4px;cursor:pointer">🗑</button>` : ''}</td>
  </tr>`}).join('') || '<tr><td colspan="20" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';

  if (sorted.length > displayLimit) {
    tbody.innerHTML += `<tr><td colspan="20" style="text-align:center;padding:12px"><button class="btn btn-outline" onclick="window._bkDisplayLimit=${displayLimit+200};renderBookings()" style="font-size:12px;padding:6px 16px;min-height:32px">さらに200件表示（全${sorted.length}件中${displayLimit}件表示中）</button></td></tr>`;
  }

  // ステータス変更イベント
  if (isAdmin) {
    tbody.querySelectorAll('.bk-status-select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        const name = sel.dataset.name;
        const applyDate = sel.dataset.apply;
        const newStatus = sel.value;
        const match = bookingsData.find(d => d.name === name && d.applyDate === applyDate);
        // キャンセル・除外は確認
        if ((newStatus === 'キャンセル' || newStatus === '除外') && !confirm(name + ' を「' + newStatus + '」に変更しますか？')) {
          sel.value = match ? match.status || '未対応' : '未対応';
          return;
        }
        if (match) match.status = newStatus;
        // bk-extra にも永続化
        const bkEx = loadData('bk-extra', {});
        const key = name + '|' + applyDate;
        if (!bkEx[key]) bkEx[key] = {};
        bkEx[key].editedStatus = newStatus;
        saveData('bk-extra', bkEx);
        // DB保存
        const upsertData = { name, apply_date: applyDate, status: newStatus };
        // === 連動: BFなら bf_status も自動設定 ===
        if (match && isBFBooking(match) && STATUS_TO_BF[newStatus] !== undefined) {
          const targetBF = STATUS_TO_BF[newStatus];
          // 成約/キャンセル系は常に上書き、来院済は進行中でなければ上書き
          const curBF = bfLifecycleCache[key]?.bf_status;
          // 来院済 の場合: 未設定 / 離脱 / キャンセル / '' は上書き可 (進行中は保護)
          const resettable = !curBF || curBF === '離脱' || curBF === 'キャンセル';
          const shouldUpdate = (newStatus === '成約' || newStatus === 'キャンセル' || resettable);
          if (shouldUpdate && targetBF !== null) {
            upsertData.bf_status = targetBF;
            if (!bfLifecycleCache[key]) bfLifecycleCache[key] = { name, apply_date: applyDate };
            bfLifecycleCache[key].bf_status = targetBF;
            // 履歴記録 (失敗時は warn のみ)
            (async () => {
              try {
                await sb.from('bf_history').insert({
                  booking_name: name, booking_apply_date: applyDate,
                  from_status: curBF || null, to_status: targetBF,
                  changed_by: getLoggedUserName() + '(自動連動:状態→BF)'
                });
              } catch(e) { console.warn('bf_history insert failed:', e); }
            })();
          }
        }
        // A2+A3: 楽観的ロック付き保存 + リトライキュー
        (async () => {
          const seen = getVersion('booking_status', key);
          const { name: _n, apply_date: _a, ...changes } = upsertData;
          if (seen) {
            const lockRes = await conditionalUpdate('booking_status', { name, apply_date: applyDate }, seen, changes);
            if (lockRes.conflict) {
              showConflictDialog(`${name} は他の人が先に変更しました。最新を読み込みます。`, () => loadBookings());
              return;
            }
            if (!lockRes.ok) {
              await safeSave({ type:'upsert', table:'booking_status', payload: upsertData, options: { onConflict:'name,apply_date' } });
            }
          } else {
            await safeSave({ type:'upsert', table:'booking_status', payload: upsertData, options: { onConflict:'name,apply_date' } });
          }
        })();
        fetch(GAS_API_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, applyDate, status: newStatus }) }).catch(() => {});
        renderBookings();
      });
    });

    // 入金月/インセ月 (カレンダーピッカー)
    tbody.querySelectorAll('.bk-month-btn').forEach(btn => {
      const hidden = btn.parentElement.querySelector('.bk-month-hidden');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!hidden) return;
        if (typeof hidden.showPicker === 'function') {
          try { hidden.showPicker(); return; } catch(_) {}
        }
        hidden.focus();
        hidden.click();
      });
      if (hidden) {
        hidden.addEventListener('change', () => {
          const v = hidden.value || '';
          btn.dataset.iso = v;
          btn.textContent = v ? v.substring(2).replace('-','/') : 'YY/MM';
          btn.style.color = v ? '' : 'var(--text-muted)';
          // bk-field-input 共通ハンドラで保存される
        });
      }
    });

    // 次回予定 (カレンダーピッカー)
    tbody.querySelectorAll('.bk-next-date-btn').forEach(btn => {
      const hidden = btn.parentElement.querySelector('.bk-next-date-hidden');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!hidden) return;
        if (typeof hidden.showPicker === 'function') {
          try { hidden.showPicker(); return; } catch(_) {}
        }
        hidden.focus();
        hidden.click();
      });
      if (hidden) {
        hidden.addEventListener('change', async () => {
          const iso = hidden.value || null;
          const name = btn.dataset.name;
          const applyDate = btn.dataset.apply;
          const ok = await saveBFLifecycleField(name, applyDate, 'bf_next_date', iso);
          if (ok) {
            btn.dataset.iso = iso || '';
            btn.textContent = iso ? iso.substring(5).replace('-','/') : '年/月/日';
            btn.style.background = iso ? '#dcfce7' : '#fef3c7';
            btn.style.borderColor = iso ? '#16a34a' : '#f59e0b';
            btn.style.color = iso ? '#15803d' : '#92400e';
            setTimeout(() => renderBookings(), 300);
          }
        });
      }
    });

    // 削除ボタン (予約一覧)
    tbody.querySelectorAll('.bk-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const n = btn.dataset.name;
        const a = btn.dataset.apply;
        if (!confirm(`${n} (${a}) を削除しますか？\n重複削除用: manual_bookings削除 + status=除外 に設定します。\n(変更履歴から復元可能)`)) return;
        await deleteBFRow(n, a);
      });
    });

    // BF相談用: BFステータスドロップダウン
    tbody.querySelectorAll('.bk-bfstatus-select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        const name = sel.dataset.name;
        const applyDate = sel.dataset.apply;
        const newBFStatus = sel.value;
        if (!newBFStatus) return; // 未設定行は何もしない
        // saveBFLifecycleField経由で bf_status 保存 + 状態への自動連動も発動
        const ok = await saveBFLifecycleField(name, applyDate, 'bf_status', newBFStatus);
        if (ok) {
          sel.style.borderColor = '#0a0';
          setTimeout(() => { sel.style.borderColor = ''; }, 1000);
          renderBookings();
        }
      });
    });

    // 追加フィールド（成約施術・金額・入金月・インセ月）のイベント
    const bkExtra = _bkExtra;
    const saveExtra = (name, apply, field, value) => {
      const key = name + '|' + apply;
      if (!bkExtra[key]) bkExtra[key] = {};
      bkExtra[key][field] = value;
      saveData('bk-extra', bkExtra);
      // DBにも保存
      const dbField = field === 'contractService' ? 'contract_service' : field === 'contractAmount' ? 'contract_amount' : field === 'paymentMonth' ? 'payment_month' : field === 'incentiveAmount' ? 'incentive_amount' : 'incentive_month';
      const update = { name, apply_date: apply };
      update[dbField] = (field === 'contractAmount' || field === 'incentiveAmount') ? Number(String(value).replace(/,/g,'')) || 0 : value;
      // A2+A3
      const bkKey = name + '|' + apply;
      const seen = getVersion('booking_status', bkKey);
      (async () => {
        if (seen) {
          const { name:_n, apply_date:_a, ...changes } = update;
          const lockRes = await conditionalUpdate('booking_status', { name, apply_date: apply }, seen, changes);
          if (lockRes.conflict) {
            showConflictDialog(`${name} は他の人が先に編集しました。最新を読み込みます。`, () => loadBookings());
            return;
          }
          if (!lockRes.ok) await safeSave({ type:'upsert', table:'booking_status', payload: update, options: { onConflict:'name,apply_date' } });
        } else {
          await safeSave({ type:'upsert', table:'booking_status', payload: update, options: { onConflict:'name,apply_date' } });
        }
      })();
    };
    // セレクト
    tbody.querySelectorAll('.bk-field-select').forEach(sel => {
      const key = sel.dataset.name + '|' + sel.dataset.apply;
      if (bkExtra[key] && bkExtra[key][sel.dataset.field]) sel.value = bkExtra[key][sel.dataset.field];
      sel.addEventListener('change', () => {
        saveExtra(sel.dataset.name, sel.dataset.apply, sel.dataset.field, sel.value);
        sel.style.borderColor = 'var(--green)';
        setTimeout(() => { sel.style.borderColor = ''; }, 1000);
      });
    });
    // インプット
    tbody.querySelectorAll('.bk-field-input').forEach(inp => {
      const key = inp.dataset.name + '|' + inp.dataset.apply;
      if (bkExtra[key] && bkExtra[key][inp.dataset.field]) {
        const v = bkExtra[key][inp.dataset.field];
        if (inp.classList.contains('bk-amt-input')) inp.value = v ? Number(String(v).replace(/,/g,'')).toLocaleString() : '';
        else inp.value = v;
      }
      // 金額系: フォーカス時はカンマ除去、blur時に再フォーマット
      if (inp.classList.contains('bk-amt-input')) {
        inp.addEventListener('focus', () => { inp.value = inp.value.replace(/,/g,''); });
        inp.addEventListener('blur', () => {
          const n = Number(inp.value.replace(/,/g,''));
          inp.value = n ? n.toLocaleString() : '';
        });
      }
      inp.addEventListener('change', () => {
        const rawVal = inp.classList.contains('bk-amt-input') ? String(inp.value).replace(/,/g,'') : inp.value;
        saveExtra(inp.dataset.name, inp.dataset.apply, inp.dataset.field, rawVal);
        inp.style.borderColor = 'var(--green)';
        setTimeout(() => { inp.style.borderColor = ''; }, 1000);
        // 成約金額変更時にインセを自動計算
        if (inp.dataset.field === 'contractAmount') {
          const name = inp.dataset.name;
          const apply = inp.dataset.apply;
          const row = bookingsData.find(b => b.name === name && b.applyDate === apply);
          if (row) {
            row.contractAmount = Number(rawVal) || 0;
            const inc = calcIncentive(row.source, row.contractAmount);
            if (inc) {
              row.incentiveAmount = inc;
              const incInp = tbody.querySelector(`input[data-field="incentiveAmount"][data-name="${CSS.escape(name)}"][data-apply="${CSS.escape(apply)}"]`);
              if (incInp) {
                incInp.value = Number(inc).toLocaleString();
                incInp.style.background = '#fef3c7';
                setTimeout(() => { incInp.style.background = ''; }, 1500);
              }
              saveExtra(name, apply, 'incentiveAmount', inc);
            }
          }
        }
      });
    });

    // メモクリックでモーダル表示
    tbody.querySelectorAll('.bk-memo-cell').forEach(td => {
      td.addEventListener('click', () => {
        if (!isAdmin) return;
        openMemoModal(td.dataset.name, td.dataset.apply, td);
      });
    });

    // 名前クリックで行編集モーダル
    tbody.querySelectorAll('.bk-row-edit').forEach(td => {
      td.addEventListener('click', () => openRowEditModal(td.dataset.name, td.dataset.apply));
    });

    // 予約日クリックで変更（インライン入力）
    tbody.querySelectorAll('.bk-edit-date').forEach(td => {
      td.addEventListener('click', () => {
        const idx = parseInt(td.dataset.idx);
        const d = sorted[idx];
        if (!d || td.querySelector('input')) return;
        const orig = td.textContent.trim();
        const input = document.createElement('input');
        input.type = 'text';
        input.value = d.bookDate || '';
        input.style.cssText = 'font-size:10px;width:100px;padding:2px 4px;border:1px solid var(--accent);border-radius:4px';
        input.placeholder = '例: 2026/4/20 15:00';
        td.innerHTML = '';
        td.appendChild(input);
        input.focus();
        input.select();
        const save = () => {
          const newDate = input.value.trim();
          if (newDate && newDate !== d.bookDate) {
            d.bookDate = newDate;
            td.innerHTML = fmtBookDate(newDate);
            showToast('予約日を変更しました');
            (async () => {
              const res = await safeSave({ type:'upsert', table:'booking_status', payload: { name: d.name, apply_date: d.applyDate, book_date: newDate }, options: { onConflict:'name,apply_date' } });
              if (res && res.ok === false) showToast('⚠ 予約日保存に失敗。再送信します', true);
            })();
          } else {
            td.innerHTML = orig;
          }
        };
        input.addEventListener('blur', save);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = d.bookDate || ''; input.blur(); } });
      });
    });

    // v264 一括選択 + バルクアクション
    setupBulkBookingActions();
  }

  // v264 ピン留めボタン (全ユーザー)
  tbody.querySelectorAll('.bk-pin-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isPinned = togglePinnedBooking(btn.dataset.name, btn.dataset.apply);
      showToast(isPinned ? '★ ピン留めしました' : '☆ ピン解除しました');
      renderBookings();
    });
  });

  // 請求トグル (admin/partner両方で操作可。請求済→未請求は admin のみ)
  tbody.querySelectorAll('.bk-incpaid-toggle').forEach(el => {
    el.addEventListener('click', async () => {
      const name = el.dataset.name;
      const applyDate = el.dataset.apply;
      const curPaid = el.dataset.paid === '1';
      const role = sessionStorage.getItem('role') || userRole || 'admin';
      const isAdminUser = (role === 'admin');
      // 請求済 → 未請求 はパートナー禁止
      if (curPaid && !isAdminUser) {
        alert('請求済みの解除は管理者のみが可能です。\n変更が必要な場合は管理者にご連絡ください。');
        return;
      }
      // 解除時は admin でも確認
      if (curPaid && isAdminUser) {
        if (!confirm(`${name} の請求済みを解除しますか？\n※パートナー側にも反映されます`)) return;
      }
      const newPaid = !curPaid;
      const nowIso = new Date().toISOString();
      const paidAt = newPaid ? nowIso : null;
      const paidBy = role === 'custom'
        ? (sessionStorage.getItem('customName') || 'partner')
        : (role === 'admin' ? 'admin' : role);
      // bookingsData に反映
      const row = bookingsData.find(b => b.name === name && b.applyDate === applyDate);
      if (row) {
        row.incentivePaid = newPaid;
        row.paidAt = paidAt;
        row.paidBy = newPaid ? paidBy : null;
      }
      // bfLifecycleCache も反映
      const key = name + '|' + applyDate;
      if (!bfLifecycleCache[key]) bfLifecycleCache[key] = { name, apply_date: applyDate };
      bfLifecycleCache[key].incentive_paid = newPaid;
      bfLifecycleCache[key].paid_at = paidAt;
      bfLifecycleCache[key].paid_by = newPaid ? paidBy : null;
      // localStorage bk-extra にも記録 (オフライン対応)
      try {
        const bkEx = loadData('bk-extra', {});
        if (!bkEx[key]) bkEx[key] = {};
        bkEx[key].editedIncentivePaid = newPaid;
        bkEx[key].editedPaidAt = paidAt;
        bkEx[key].editedPaidBy = newPaid ? paidBy : null;
        saveData('bk-extra', bkEx);
      } catch(_){}
      // DB保存 (partnerでも動くよう customEditRole に依存しない)
      try {
        const payload = { name, apply_date: applyDate, incentive_paid: newPaid, paid_at: paidAt, paid_by: newPaid ? paidBy : null };
        // #4 楽観ロック: キャッシュ済みバージョンがあれば conditionalUpdate
        const seen = getVersion('booking_status', name + '|' + applyDate);
        if (seen) {
          const changes = { incentive_paid: newPaid, paid_at: paidAt, paid_by: newPaid ? paidBy : null };
          const lockRes = await conditionalUpdate('booking_status', { name, apply_date: applyDate }, seen, changes);
          if (lockRes.conflict) {
            showConflictDialog('請求状態が他で更新されました。最新を読み込みます。', () => { if (typeof loadBookings === 'function') loadBookings(); });
            return;
          }
          if (!lockRes.ok) {
            // fallback: safeSave
            const res = await safeSave({ type:'upsert', table:'booking_status', payload, options: { onConflict:'name,apply_date' } });
            if (res && res.ok === false) showToast('⚠ 請求状態保存に失敗。再送信します', true);
            else showToast(newPaid ? '請求済みに変更しました' : '未請求に戻しました');
          } else {
            showToast(newPaid ? '請求済みに変更しました' : '未請求に戻しました');
          }
        } else {
          const res = await safeSave({ type:'upsert', table:'booking_status', payload, options: { onConflict:'name,apply_date' } });
          if (res && res.ok === false) showToast('⚠ 請求状態保存に失敗。再送信します', true);
          else showToast(newPaid ? '請求済みに変更しました' : '未請求に戻しました');
        }
      } catch(e) {
        console.warn('incentive_paid save failed', e);
        showToast('⚠ 請求状態保存でエラー', true);
      }
      renderBookings();
    });
  });
}

// === Row Edit Modal ===
let _rowEditTarget = null;
function openRowEditModal(name, applyDate) {
  const d = bookingsData.find(b => b.name === name && b.applyDate === applyDate);
  if (!d) return;
  _rowEditTarget = d;
  document.getElementById('row-edit-title').textContent = d.name + ' を編集';
  document.getElementById('re-name').value = d.name || '';
  const reApply = document.getElementById('re-applydate');
  if (reApply) reApply.value = d.applyDate || '';
  document.getElementById('re-bookdate').value = d.bookDate || '';
  document.getElementById('re-service').value = d.service || '';
  document.getElementById('re-phone').value = d.phone || '';
  document.getElementById('re-email').value = d.email || '';
  document.getElementById('re-source').value = d.source || '';
  // 医院
  const facSel = document.getElementById('re-facility');
  const facNorm = normFac(d.facility);
  for (let i = 0; i < facSel.options.length; i++) { if (facSel.options[i].value === facNorm) { facSel.selectedIndex = i; break; } }
  // ステータス
  const stSel = document.getElementById('re-status');
  const st = d.status || '未対応';
  for (let i = 0; i < stSel.options.length; i++) { if (stSel.options[i].value === st) { stSel.selectedIndex = i; break; } }
  document.getElementById('row-edit-modal').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeRowEditModal() {
  document.getElementById('row-edit-modal').hidden = true;
  document.body.style.overflow = '';
  _rowEditTarget = null;
}
function saveRowEdit() {
  if (!_rowEditTarget) return;
  const d = _rowEditTarget;
  const oldName = d.name;
  const oldApply = d.applyDate;

  // ローカルデータ更新
  d.name = document.getElementById('re-name').value.trim() || d.name;
  const reApplyEl = document.getElementById('re-applydate');
  if (reApplyEl) d.applyDate = reApplyEl.value.trim() || d.applyDate;
  d.bookDate = document.getElementById('re-bookdate').value || d.bookDate;
  d.service = document.getElementById('re-service').value || d.service;
  d.facility = document.getElementById('re-facility').value;
  d.status = document.getElementById('re-status').value;
  d.phone = document.getElementById('re-phone').value;
  d.email = document.getElementById('re-email').value;
  d.source = document.getElementById('re-source').value;

  // bk-extraにも保存（全編集項目をローカル永続化）
  const bkEx = loadData('bk-extra', {});
  const key = oldName + '|' + oldApply;
  if (!bkEx[key]) bkEx[key] = {};
  bkEx[key].editedName = d.name;
  bkEx[key].editedApplyDate = d.applyDate;
  bkEx[key].editedBookDate = d.bookDate;
  bkEx[key].editedService = d.service;
  bkEx[key].editedFacility = d.facility;
  bkEx[key].editedPhone = d.phone;
  bkEx[key].editedEmail = d.email;
  bkEx[key].editedSource = d.source;
  bkEx[key].editedStatus = d.status;
  saveData('bk-extra', bkEx);

  // DB保存（バックグラウンド：ステータス・予約日のみ。他編集項目はlocalStorage）
  (async () => {
    const res = await safeSave({ type:'upsert', table:'booking_status', payload: { name: oldName, apply_date: oldApply, status: d.status, book_date: d.bookDate }, options: { onConflict:'name,apply_date' } });
    if (res && res.ok === false) showToast('⚠ 行編集の保存に失敗。再送信します', true);
  })();
  if (d.tool === '手動') {
    sb.from('manual_bookings').update({ name: d.name, book_date: d.bookDate, service: d.service, facility: d.facility, phone: d.phone, email: d.email, source: d.source, status: d.status }).eq('name', oldName).eq('apply_date', oldApply).then(() => {});
  }
  fetch(GAS_API_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: oldName, applyDate: oldApply, status: d.status }) }).catch(() => {});

  showToast(d.name + ' を更新しました');
  closeRowEditModal();
  renderBookings();
}

// === Memo Modal ===
let _memoTarget = null;
function openMemoModal(name, apply, tdEl) {
  const key = name + '|' + apply;
  const memos = loadData('bk-memos', {});
  // 優先順位: localStorage 完全一致 → bookingsData._memo → BFキャッシュ(同患者なら日付跨ぎでもOK) → localStorage ファジー
  let current = memos[key] || '';
  const nn = normName(name);
  const nfac = normFac((bookingsData||[]).find(b => b.name===name && b.applyDate===apply)?.facility || '');
  if (!current) {
    const d = (bookingsData || []).find(b => b.name === name && b.applyDate === apply);
    if (d && d._memo) current = d._memo;
  }
  if (!current) {
    // BFキャッシュから 正規化名(+医院が一致する)のメモを検索 (日付は問わない)
    for (const k in bfLifecycleCache) {
      const info = bfLifecycleCache[k];
      if (!info) continue;
      if (normName(info.name) !== nn) continue;
      // 医院が指定されていれば一致確認、なければ名前一致のみ
      if (nfac && info.bf_cs_facility && parseCsFac(info.bf_cs_facility).map(normFac).indexOf(nfac) < 0) continue;
      const m = info.bf_memo || info.memo || '';
      if (m) { current = m; break; }
    }
  }
  if (!current) {
    // localStorage の bk-memos をファジー検索 (名前のみで)
    for (const k in memos) {
      const kName = k.split('|')[0];
      if (normName(kName) === nn && memos[k]) { current = memos[k]; break; }
    }
  }
  if (!current) {
    // bookingsData 全走査 (同名別表記)
    for (const b of (bookingsData || [])) {
      if (normName(b.name) === nn && b._memo) { current = b._memo; break; }
    }
  }
  _memoTarget = { name, apply, key, tdEl };
  document.getElementById('memo-modal-title').textContent = name + ' のメモ';
  const ta = document.getElementById('memo-modal-text');
  ta.value = current;
  // v261: テンプレートボタンを描画
  _renderMemoTemplates(ta);
  document.getElementById('memo-modal').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => ta.focus(), 100);
}

// メモテンプレート (よく使う定型文)
const MEMO_TEMPLATES = [
  { label: '📞 連絡取れず', text: '連絡取れず、再架電予定' },
  { label: '✅ 来院確認済', text: '来院確認済み' },
  { label: '📅 予約変更', text: '予約変更希望あり、次回日程調整中' },
  { label: '💭 検討中', text: '検討中とのこと。1週間後に再連絡' },
  { label: '❌ キャンセル希望', text: 'キャンセル希望あり、理由: ' },
  { label: '💰 見積もり送付', text: '見積もりメール送付済み' },
  { label: '🔁 再予約', text: '再予約手配済み' },
];
function _renderMemoTemplates(textarea) {
  const wrap = document.getElementById('memo-templates');
  if (!wrap) return;
  wrap.innerHTML = MEMO_TEMPLATES.map((t, i) =>
    `<button type="button" class="memo-tpl-btn" data-idx="${i}" style="padding:5px 10px;border:1px solid #d4d4d8;background:#f9fafb;border-radius:14px;font-size:11px;cursor:pointer;color:#3a3a3a;white-space:nowrap;transition:all 0.15s" onmouseover="this.style.background='#fef3c7';this.style.borderColor='#f59e0b'" onmouseout="this.style.background='#f9fafb';this.style.borderColor='#d4d4d8'">${t.label}</button>`
  ).join('');
  wrap.querySelectorAll('.memo-tpl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tpl = MEMO_TEMPLATES[Number(btn.dataset.idx)];
      if (!tpl) return;
      const cur = textarea.value.trim();
      const today = new Date().toLocaleDateString('ja-JP', {month:'2-digit',day:'2-digit'});
      const newLine = `[${today}] ${tpl.text}`;
      textarea.value = cur ? cur + '\n' + newLine : newLine;
      textarea.focus();
      // 末尾にカーソル
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  });
}
function closeMemoModal() {
  document.getElementById('memo-modal').hidden = true;
  document.body.style.overflow = '';
  _memoTarget = null;
}
async function saveMemoModal() {
  if (!_memoTarget) return;
  const val = document.getElementById('memo-modal-text').value.trim();
  const memos = loadData('bk-memos', {});
  if (val) {
    memos[_memoTarget.key] = val;
  } else {
    // v273: 空文字なら entry を完全削除 (空文字残置でゾンビ化を防ぐ)
    delete memos[_memoTarget.key];
  }
  saveData('bk-memos', memos);
  if (_memoTarget.tdEl) {
    // Bug fix: 6文字省略 → _flattenMemoForDisplay で 200文字、再描画と整合性
    const flat = val ? (typeof _flattenMemoForDisplay === 'function' ? _flattenMemoForDisplay(val, 200) : val.slice(0,200)) : '';
    _memoTarget.tdEl.innerHTML = val ? escapeHtml(flat) : '<span style="color:var(--text-muted)">+ メモ</span>';
    _memoTarget.tdEl.title = val;
    // 視覚的にもメモ有無で背景切替
    if (val) {
      _memoTarget.tdEl.style.background = '#fff8e1';
      _memoTarget.tdEl.style.borderColor = '#f9a825';
    } else {
      _memoTarget.tdEl.style.background = 'transparent';
      _memoTarget.tdEl.style.borderColor = 'var(--border)';
    }
  }
  // 予約一覧メモとBFメモを連動 (v273: 空時も bf_memo を上書きする — 削除を反映するため)
  const payload = { name: _memoTarget.name, apply_date: _memoTarget.apply, memo: val, bf_memo: val };
  // Bug fix: await して保存完了を確認
  await safeSave({ type:'upsert', table:'booking_status', payload, options: { onConflict:'name,apply_date' } });
  // BFライフサイクルキャッシュも同期 (空でも反映)
  if (bfLifecycleCache[_memoTarget.key]) {
    bfLifecycleCache[_memoTarget.key].bf_memo = val;
    bfLifecycleCache[_memoTarget.key].memo = val;
  }
  // bookingsData の _memo も同期 (findAnyMemo がここから探すため)
  const targetBooking = (bookingsData || []).find(b => b.name === _memoTarget.name && b.applyDate === _memoTarget.apply);
  if (targetBooking) targetBooking._memo = val;
  showToast(val ? 'メモを保存しました' : 'メモを削除しました');
  closeMemoModal();
}

function exportCSV() {
  // プロモユーザーでも自分の権限範囲のデータのみCSV出力可能に。
  // 個人情報(名前・電話・メール)は画面表示と同様にマスク。
  const bkExtra = loadData('bk-extra', {});
  const memos = loadData('bk-memos', {});
  const headers = ['申込日','予約日','名前','相談','医院','電話番号','メール','流入元','ステータス','成約施術','成約金額','メモ','ツール'];
  // 権限フィルタ適用
  let source = bookingsData.filter(d => d.status !== '除外');
  if (_hasPromoRestriction()) source = source.filter(d => _matchesAllowedPromo(d.source));
  const rows = source.map(d => {
    const key = d.name+'|'+d.applyDate;
    const extra = bkExtra[key] || {};
    // 非adminは個人情報マスク
    const name = _isPII_MaskNeeded() ? maskName(d.name) : d.name;
    const phoneRaw = d.phone ? (String(d.phone).startsWith('0') ? d.phone : '0'+d.phone) : '';
    const phone = _isPII_MaskNeeded() ? (phoneRaw ? maskPhone(phoneRaw) : '') : phoneRaw;
    const email = _isPII_MaskNeeded() ? (d.email ? maskEmail(d.email) : '') : (d.email || '');
    return [
      d.applyDate, d.bookDate, name, normSvc(d.service), normFac(d.facility),
      phone, email, d.source, d.status || '未対応',
      extra.contractService || d.contractService || '',
      extra.contractAmount || d.contractAmount || '',
      memos[key] || d._memo || '',
      d.tool || 'DX'
    ];
  });
  const bom = '\uFEFF';
  const csv = bom + [headers.join(','), ...rows.map(r => r.map(c => '"'+String(c==null?'':c).replace(/"/g,'""')+'"').join(','))].join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `予約データ_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// === Facility Tab ===
let currentFacTab = '';

function renderFacTab(facility) {
  currentFacTab = facility;
  document.getElementById('fac-title').textContent = facility;

  let data = bookingsData.filter(d => d.status !== '除外' && normFac(d.facility) === facility);
  // 権限フィルタ
  if (_hasPromoRestriction()) data = data.filter(d => _matchesAllowedPromo(d.source));

  // フィルター
  const facPeriod = document.getElementById('fac-period')?.value || '';
  const facMonth = document.getElementById('fac-month')?.value || '';
  const facStatusF = document.getElementById('fac-status-filter')?.value || '';
  const facSearch = (document.getElementById('fac-search')?.value || '').trim().toLowerCase();
  const getApplyYM = (d) => { const m = (d.applyDate||'').match(/(\d{4})\D+(\d{1,2})/); return m ? m[1]+'-'+String(parseInt(m[2])).padStart(2,'0') : ''; };
  if (facPeriod === 'thisMonth') { const now = new Date(); const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`; data = data.filter(d => getApplyYM(d) === ym); }
  else if (facPeriod === 'lastMonth') { const now = new Date(); now.setMonth(now.getMonth()-1); const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`; data = data.filter(d => getApplyYM(d) === ym); }
  else if (facPeriod === 'fiscal') { const now = new Date(); const fy = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear()-1; data = data.filter(d => { const ym = getApplyYM(d); return ym >= fy+'-07'; }); }
  if (facMonth) { data = data.filter(d => getApplyYM(d) === facMonth); }
  if (facStatusF) { if (facStatusF === '未対応') data = data.filter(d => !d.status || d.status === '未対応'); else data = data.filter(d => d.status === facStatusF); }
  if (facSearch) data = data.filter(d => d.name && d.name.toLowerCase().includes(facSearch));

  const total = data.length;
  const cancelled = data.filter(d => d.status === 'キャンセル').length;
  const visited = data.filter(d => isVisitedStatus(d.status)).length;
  const contracted = data.filter(d => d.status === '成約').length;
  const todayR = new Date(); todayR.setHours(0,0,0,0);
  const past = data.filter(d => { const m = (d.bookDate||'').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); return m && new Date(parseInt(m[1]),parseInt(m[2])-1,parseInt(m[3])) < todayR; });
  const pastV = past.filter(d => isVisitedStatus(d.status)).length;
  const vr = past.length > 0 ? Math.round(pastV/past.length*100) : 0;

  // #19 要対応カウント
  const facOverdue = data.filter(d => {
    if (d.status && d.status !== '未対応') return false;
    if (!d.bookDate) return false;
    const m = (d.bookDate||'').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    return m && new Date(parseInt(m[1]),parseInt(m[2])-1,parseInt(m[3])) < todayR;
  }).length;

  document.getElementById('fac-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">予約数</span><span class="stat-num">${total}</span></div>
    ${facOverdue > 0 ? `<div class="stat-card" style="border-color:var(--red)"><span class="stat-label" style="color:var(--red)">要対応</span><span class="stat-num" style="color:var(--red)">${facOverdue}</span></div>` : ''}
    <div class="stat-card"><span class="stat-label">キャンセル</span><span class="stat-num" style="color:var(--red)">${cancelled}</span></div>
    <div class="stat-card"><span class="stat-label">来院済</span><span class="stat-num">${visited}</span></div>
    <div class="stat-card"><span class="stat-label">来院率</span><span class="stat-num">${vr}%</span></div>
    <div class="stat-card"><span class="stat-label">成約</span><span class="stat-num" style="color:var(--green)">${contracted}</span></div>
  `;
  document.getElementById('fac-count').textContent = total + '件';

  const statusBadge = (s) => !s||s==='未対応' ? '<span class="badge badge-default">未対応</span>' : s==='キャンセル' ? '<span class="badge badge-danger">キャンセル</span>' : s==='来院済' ? '<span class="badge badge-warning">来院済</span>' : s==='成約' ? '<span class="badge badge-success">成約</span>' : s==='確認済' ? '<span class="badge badge-default" style="border-color:#7c3aed;color:#7c3aed">確認済</span>' : `<span class="badge badge-default">${s}</span>`;

  const sorted = [...data].sort((a,b) => (b.applyDate||'').localeCompare(a.applyDate||''));
  const memos = loadData('bk-memos', {});
  const bkExtra = loadData('bk-extra', {});

  document.getElementById('fac-tbody').innerHTML = sorted.slice(0,200).map(d => {
    const key = d.name+'|'+d.applyDate;
    const memo = d._memo || memos[key] || '';
    const extra = bkExtra[key] || {};
    const rs = d.status==='成約'?'background:#f0fdf4':d.status==='来院済'?'background:#eff6ff':d.status==='キャンセル'?'background:#f8f8f8;color:#9ca3af':(!d.status||d.status==='未対応')?'background:#fff5f5':'';
    return `<tr style="${rs}">
      <td style="font-size:10px">${d.applyDate ? d.applyDate.match(/(\d{1,2})\D+(\d{1,2})/) ? RegExp.$1+'/'+RegExp.$2 : '-' : '-'}</td>
      <td style="font-size:10px">${fmtBookDate(d.bookDate)}</td>
      <td style="font-size:11px;font-weight:500;cursor:pointer;text-decoration:underline dotted" class="fac-row-edit" data-name="${d.name}" data-apply="${d.applyDate}" title="クリックで編集">${maskName(d.name)}</td>
      <td style="font-size:10px">${normSvc(d.service)}</td>
      <td style="font-size:10px">${maskPhone(d.phone)||'-'}</td>
      <td style="font-size:10px;max-width:100px;overflow:hidden;text-overflow:ellipsis">${maskEmail(d.email)||'-'}</td>
      <td style="font-size:9px;color:var(--text-sub)">${(d.source||'-').slice(0,12)}</td>
      <td style="text-align:center">${statusBadge(d.status)}</td>
      <td style="font-size:10px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer" class="fac-memo-cell" data-name="${d.name}" data-apply="${d.applyDate}" title="${(memo||'').replace(/"/g,'&quot;')}">${memo ? esc(_flattenMemoForDisplay(memo, 30)) : '<span style="color:var(--text-muted)">+</span>'}</td>
      <td style="font-size:10px;text-align:center;${extra.contractService?'background:#dcfce7;color:#15803d;font-weight:600':''}">${extra.contractService||d.contractService||'-'}</td>
      <td style="font-size:10px;text-align:center">${extra.contractAmount||d.contractAmount?'¥'+fmt(extra.contractAmount||d.contractAmount):'-'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="11" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';

  // 名前クリックで行編集
  document.querySelectorAll('#fac-tbody .fac-row-edit').forEach(td => {
    td.addEventListener('click', () => {
      openRowEditModal(td.dataset.name, td.dataset.apply);
      // 保存後にこの医院タブを再描画
      const origSave = document.getElementById('re-save').onclick;
      document.getElementById('re-save').onclick = null;
      const handler = () => { saveRowEdit(); renderFacTab(currentFacTab); document.getElementById('re-save').removeEventListener('click', handler); };
      document.getElementById('re-save').addEventListener('click', handler, { once: true });
    });
  });

  // メモクリック
  document.querySelectorAll('#fac-tbody .fac-memo-cell').forEach(td => {
    td.addEventListener('click', () => openMemoModal(td.dataset.name, td.dataset.apply, td));
  });
}

// === 一括貼付け ===
function parseBulkText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const today = new Date();
  const year = today.getFullYear();
  return lines.map((line, idx) => {
    // タブ優先、次にカンマ
    const cols = line.includes('\t') ? line.split('\t') : line.split(',');
    const parts = cols.map(c => (c || '').trim());
    const [rawDate, name, source, svc, status] = parts;
    // 日付パース: "4/13", "2026/4/13", "4/13 10:00" 等
    let dateStr = '';
    if (rawDate) {
      const m = rawDate.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/) || rawDate.match(/(\d{1,2})\D+(\d{1,2})/);
      if (m) {
        if (m.length === 4) dateStr = `${m[1]}/${String(m[2]).padStart(2,'0')}/${String(m[3]).padStart(2,'0')}`;
        else dateStr = `${year}/${String(m[1]).padStart(2,'0')}/${String(m[2]).padStart(2,'0')}`;
        // 時刻部分があれば維持
        const timeM = rawDate.match(/(\d{1,2}:\d{2})/);
        dateStr += timeM ? ' ' + timeM[1] : ' ' + String(10 + (idx % 6)).padStart(2,'0') + ':00';
      }
    }
    return { lineNo: idx+1, rawLine: line, dateStr, name: name||'', source: source||'', svc: svc||'', status: status||'' };
  });
}

async function runBulkInsert(previewOnly) {
  const fac = currentFacTab;
  if (!fac) { showToast('医院タブを選択してください', true); return; }
  const text = document.getElementById('fac-bulk-text').value.trim();
  if (!text) return;
  const sameDate = document.getElementById('fac-bulk-samedate').checked;
  const defSvc = document.getElementById('fac-bulk-default-svc').value;
  const defStatus = document.getElementById('fac-bulk-default-status').value;
  const resultEl = document.getElementById('fac-bulk-result');

  const rows = parseBulkText(text);
  if (!rows.length) { resultEl.innerHTML = '<span style="color:#c00">入力が空です</span>'; return; }

  // 重複チェック (manual_bookings + 現在のbookingsData)
  const { data: existing } = await sb.from('manual_bookings').select('name,facility').eq('facility', fac);
  const existNames = new Set((existing || []).map(e => e.name));
  (bookingsData || []).forEach(b => { if (normFac(b.facility) === fac) existNames.add(b.name); });

  const toInsert = [];
  const dupLines = [];
  const errLines = [];
  rows.forEach(r => {
    if (!r.name) { errLines.push(r); return; }
    if (!r.dateStr) { errLines.push(r); return; }
    if (existNames.has(r.name)) { dupLines.push(r); return; }
    toInsert.push({
      apply_date: r.dateStr,
      book_date: sameDate ? r.dateStr : '',
      name: r.name,
      service: (r.svc || defSvc) + (r.svc && r.svc.endsWith('相談') ? '' : '相談'),
      facility: fac,
      source: r.source || '',
      status: r.status || defStatus,
      tool: '手動'
    });
  });

  // プレビュー表示
  const previewHtml = `
    <div style="padding:10px;background:var(--bg);border-radius:6px;margin-bottom:8px">
      <div>📊 解析結果: <b>${rows.length}</b>行 / 登録対象 <b style="color:#0a0">${toInsert.length}</b>件 / 重複除外 <b style="color:#f90">${dupLines.length}</b>件 / エラー <b style="color:#c00">${errLines.length}</b>件</div>
    </div>
    ${toInsert.length ? `<details open style="margin-bottom:8px"><summary style="cursor:pointer;font-size:12px;font-weight:600">➕ 登録対象 ${toInsert.length}件</summary><div style="max-height:200px;overflow-y:auto;margin-top:6px;border:1px solid var(--border-light);border-radius:4px;padding:6px">${toInsert.map(x=>`<div style="font-size:11px;padding:3px 0;border-bottom:1px dotted var(--border-light)">${x.apply_date} / ${x.name} / ${x.source||'-'} / ${x.service} / ${x.status}</div>`).join('')}</div></details>` : ''}
    ${dupLines.length ? `<details style="margin-bottom:8px"><summary style="cursor:pointer;font-size:12px;font-weight:600;color:#f90">⚠ 重複スキップ ${dupLines.length}件</summary><div style="max-height:150px;overflow-y:auto;margin-top:6px;padding:6px">${dupLines.map(x=>`<div style="font-size:11px;color:#f90">${x.name}</div>`).join('')}</div></details>` : ''}
    ${errLines.length ? `<details style="margin-bottom:8px"><summary style="cursor:pointer;font-size:12px;font-weight:600;color:#c00">❌ エラー ${errLines.length}件 (日付or名前なし)</summary><div style="max-height:150px;overflow-y:auto;margin-top:6px;padding:6px">${errLines.map(x=>`<div style="font-size:11px;color:#c00">Line ${x.lineNo}: ${x.rawLine}</div>`).join('')}</div></details>` : ''}
  `;

  if (previewOnly) {
    resultEl.innerHTML = previewHtml + '<div style="font-size:12px;color:var(--text-sub);margin-top:6px">問題なければ「登録実行」をクリック</div>';
    return;
  }

  if (!toInsert.length) { resultEl.innerHTML = previewHtml + '<div style="color:#c00;margin-top:6px">登録対象がありません</div>'; return; }
  if (!confirm(`${toInsert.length}件を登録します。よろしいですか？`)) return;

  const { error } = await sb.from('manual_bookings').insert(toInsert);
  if (error) { resultEl.innerHTML = previewHtml + '<div style="color:#c00;margin-top:6px">登録エラー: '+error.message+'</div>'; return; }
  resultEl.innerHTML = previewHtml + `<div style="color:#0a0;margin-top:6px;font-weight:600">✓ ${toInsert.length}件登録完了</div>`;
  showToast(`${toInsert.length}件を登録しました`);
  // 画面更新
  setTimeout(() => { document.getElementById('fac-bulk-modal').hidden = true; loadBookings(); }, 1200);
}

async function saveFacNewPatient() {
  const name = document.getElementById('fac-new-name').value.trim();
  if (!name) { showToast('名前を入力してください', true); return; }
  // 重複チェック
  const dup = bookingsData.find(d => d.name === name && normFac(d.facility) === currentFacTab);
  if (dup && !confirm('⚠️ 「' + name + '」は既に' + currentFacTab + 'に登録されています。それでも登録しますか？')) return;
  const now = new Date();
  const applyDate = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const entry = {
    apply_date: applyDate, book_date: document.getElementById('fac-new-bookdate').value || '', name,
    service: document.getElementById('fac-new-svc').value + '相談',
    facility: currentFacTab,
    email: document.getElementById('fac-new-email').value.trim(),
    phone: document.getElementById('fac-new-phone').value.trim(),
    source: document.getElementById('fac-new-source').value.trim(),
    status: document.getElementById('fac-new-status').value,
    tool: '手動'
  };
  const { error } = await sb.from('manual_bookings').insert(entry);
  if (error) { showToast('登録エラー', true); return; }
  bookingsData.push({ applyDate: entry.apply_date, bookDate: entry.book_date, name, service: entry.service, facility: currentFacTab, email: entry.email, phone: entry.phone, source: entry.source, status: entry.status, tool: '手動' });
  ['fac-new-name','fac-new-phone','fac-new-email','fac-new-source','fac-new-bookdate'].forEach(id => document.getElementById(id).value = '');
  showToast(name + ' を追加しました');
  renderFacTab(currentFacTab);
}

// === Mail Paste Register ===
async function parseMailAndRegister() {
  const text = document.getElementById('mail-paste').value.trim();
  if (!text) { showToast('メール内容を貼り付けてください', true); return; }

  const resultEl = document.getElementById('mail-parse-result');
  resultEl.textContent = '読み取り中...';

  // パース
  const extract = (patterns) => {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].trim();
    }
    return '';
  };

  const name = extract([/お名前[:：]\s*(.+)/i, /名前[:：]\s*(.+)/i, /氏名[:：]\s*(.+)/i]);
  const email = extract([/メール[:：]\s*(.+)/i, /メールアドレス[:：]\s*(.+)/i, /email[:：]\s*(.+)/i, /E-mail[:：]\s*(.+)/i]);
  const phone = extract([/電話番号[:：]\s*(.+)/i, /電話[:：]\s*(.+)/i, /TEL[:：]\s*(.+)/i, /携帯[:：]\s*(.+)/i]);
  const service = extract([/施術[:：]\s*(.+)/i, /メニュー[:：]\s*(.+)/i, /サービス[:：]\s*(.+)/i]);
  const facility = extract([/クリニック[:：]\s*(.+)/i, /医院[:：]\s*(.+)/i, /店舗[:：]\s*(.+)/i]);
  const dateTime = extract([/日時[:：]\s*(.+)/i, /予約日時[:：]\s*(.+)/i, /予約日[:：]\s*(.+)/i]);
  const promo = extract([/プロモーションコード[:：]\s*(.+)/i, /プロモ[:：]\s*(.+)/i, /流入元[:：]\s*(.+)/i]);

  // 登録日（メール冒頭の日付ヘッダーから取得）
  let mailDate = '';
  // メール本文を「新規予約」や「■」の前で分割して、ヘッダー部分だけから日付を探す
  const headerPart = text.split(/新規予約|━━/)[0] || text.slice(0, 200);
  const mdMatch1 = headerPart.match(/(\d{1,2})月(\d{1,2})日[^\d]*?(\d{1,2}):(\d{2})/);
  if (mdMatch1) {
    const now2 = new Date();
    // #5 年またぎ補正: 受信月と抽出月の差で前後年を推定
    const nowM = now2.getMonth() + 1;
    let year = now2.getFullYear();
    const mm = Number(mdMatch1[1]);
    const dd = Number(mdMatch1[2]);
    if (nowM === 12 && mm <= 3) year = year + 1;       // 12月受信で1-3月 → 翌年
    else if (nowM <= 3 && mm >= 10) year = year - 1;    // 1-3月受信で10-12月 → 前年
    // 日付妥当性検証 (閏年外の2/29等を排除)
    const dt = new Date(year, mm - 1, dd);
    if (dt.getMonth() !== mm - 1 || dt.getDate() !== dd) {
      console.warn('invalid date parsed from mail', year, mm, dd);
      mailDate = '';
    } else {
      mailDate = `${year}/${String(mm).padStart(2,'0')}/${String(dd).padStart(2,'0')} ${mdMatch1[3]}:${mdMatch1[4]}`;
    }
  } else {
    const mdMatch2 = headerPart.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
    if (mdMatch2) {
      mailDate = `${mdMatch2[1]}/${String(parseInt(mdMatch2[2])).padStart(2,'0')}/${String(parseInt(mdMatch2[3])).padStart(2,'0')} ${mdMatch2[4]}:${mdMatch2[5]}`;
    }
  }

  if (!name) { resultEl.textContent = '名前が読み取れませんでした'; showToast('名前が見つかりません', true); return; }

  // 重複チェック（名前＋予約日）
  const duplicate = bookingsData.find(d => d.name === name && d.bookDate && dateTime && d.bookDate.includes(dateTime.split(' ')[0]));
  if (duplicate) {
    if (!confirm('⚠️ 同じ名前・予約日のデータが既に存在します。\n\n名前: ' + name + '\n予約: ' + dateTime + '\n\nそれでも登録しますか？')) {
      resultEl.textContent = '重複のためキャンセル';
      return;
    }
  }

  // 確認表示
  const parsed = `登録日: ${mailDate || '今日'}\n名前: ${name}\n医院: ${normFac(facility) || facility}\n施術: ${service}\n予約: ${dateTime}\n電話: ${phone}\nメール: ${email}\nプロモ: ${promo}`;
  if (!confirm('以下の内容で登録しますか？\n\n' + parsed)) { resultEl.textContent = 'キャンセルしました'; return; }

  // 登録日
  let applyDate;
  if (mailDate) {
    applyDate = mailDate;
  } else {
    const now = new Date();
    applyDate = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  }

  const entry = {
    apply_date: applyDate,
    book_date: dateTime || '',
    name,
    service: service || '',
    facility: normFac(facility) || facility || '',
    email: email || '',
    phone: (phone || '').replace(/[-\s]/g, ''),
    source: promo || '',
    status: '未対応',
    tool: '手動'
  };

  const { error } = await sb.from('manual_bookings').insert(entry);
  if (error) { resultEl.textContent = '登録エラー'; showToast('登録エラー: ' + error.message, true); return; }

  // ローカルデータにも追加
  bookingsData.push({
    applyDate: entry.apply_date, bookDate: entry.book_date, name: entry.name,
    service: entry.service, facility: entry.facility, email: entry.email,
    phone: entry.phone, source: entry.source, status: entry.status, tool: '手動'
  });

  document.getElementById('mail-paste').value = '';
  resultEl.textContent = '';
  showToast(name + ' を登録しました');
  renderBookings();
}

// === Patient Search & Register ===
function searchPatients() {
  const sName = (document.getElementById('ps-name').value || '').trim().toLowerCase();
  const sPhone = (document.getElementById('ps-phone').value || '').trim().replace(/[-\s]/g, '');
  const sEmail = (document.getElementById('ps-email').value || '').trim().toLowerCase();
  const sFacility = document.getElementById('ps-facility').value;

  if (!sName && !sPhone && !sEmail && !sFacility) {
    document.getElementById('ps-result-count').textContent = '検索条件を入力してください';
    document.getElementById('ps-tbody').innerHTML = '';
    return;
  }

  let results = bookingsData;
  if (sName) results = results.filter(d => d.name && d.name.toLowerCase().includes(sName));
  if (sPhone) results = results.filter(d => d.phone && String(d.phone).replace(/[-\s]/g, '').includes(sPhone));
  if (sEmail) results = results.filter(d => d.email && d.email.toLowerCase().includes(sEmail));
  if (sFacility) results = results.filter(d => normFac(d.facility) === sFacility);

  document.getElementById('ps-result-count').textContent = results.length + '件';

  const statusBadge = (s) => !s||s==='未対応' ? '<span class="badge badge-default">未対応</span>' : s==='キャンセル' ? '<span class="badge badge-danger">キャンセル</span>' : s==='来院済' ? '<span class="badge badge-warning">来院済</span>' : s==='成約' ? '<span class="badge badge-success">成約</span>' : s==='除外' ? '<span class="badge badge-default" style="opacity:0.5">除外</span>' : `<span class="badge badge-default">${s}</span>`;

  const sorted = [...results].sort((a, b) => (b.applyDate || '').localeCompare(a.applyDate || ''));
  document.getElementById('ps-tbody').innerHTML = sorted.slice(0, 100).map(d => `<tr>
    <td style="font-size:10px">${d.applyDate ? d.applyDate.match(/(\d{1,2})\D+(\d{1,2})/) ? RegExp.$1+'/'+RegExp.$2 : d.applyDate.slice(5) : '-'}</td>
    <td style="font-size:10px">${fmtBookDate(d.bookDate)}</td>
    <td style="font-size:11px;font-weight:500">${maskName(d.name)}</td>
    <td style="font-size:10px">${normSvc(d.service)}</td>
    <td style="font-size:10px">${normFac(d.facility)}</td>
    <td style="font-size:10px">${maskPhone(d.phone) || '-'}</td>
    <td style="font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis">${maskEmail(d.email) || '-'}</td>
    <td style="font-size:9px;color:var(--text-sub)">${(d.source||'-').slice(0,15)}</td>
    <td>${statusBadge(d.status)}</td>
    <td style="font-size:9px"><span class="badge ${d.tool==='手動'?'badge-warning':'badge-default'}" style="font-size:8px">${d.tool||'DX'}</span></td>
  </tr>`).join('') || '<tr><td colspan="10" style="text-align:center;color:var(--text-muted)">該当なし</td></tr>';
}

async function registerNewPatient() {
  const name = document.getElementById('np-name').value.trim();
  if (!name) { showToast('名前を入力してください', true); return; }
  // 重複チェック
  const dup = bookingsData.find(d => d.name === name);
  if (dup && !confirm('⚠️ 「' + name + '」は既に登録されています。それでも登録しますか？')) return;

  const now = new Date();
  const applyDate = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  const entry = {
    apply_date: applyDate,
    book_date: document.getElementById('np-bookdate').value || '',
    name,
    service: document.getElementById('np-service').value,
    facility: document.getElementById('np-facility').value,
    email: document.getElementById('np-email').value.trim(),
    phone: document.getElementById('np-phone').value.trim(),
    source: document.getElementById('np-source').value.trim(),
    status: document.getElementById('np-status').value,
    tool: '手動'
  };

  const { error } = await sb.from('manual_bookings').insert(entry);
  if (error) { showToast('登録エラー: ' + error.message, true); return; }

  // ローカルのbookingsDataにも追加（リロードまで反映）
  bookingsData.push({
    applyDate: entry.apply_date,
    bookDate: entry.book_date,
    name: entry.name,
    service: entry.service,
    facility: entry.facility,
    email: entry.email,
    phone: entry.phone,
    source: entry.source,
    status: entry.status,
    tool: '手動'
  });

  // フォームクリア
  ['np-name','np-phone','np-email','np-bookdate','np-source'].forEach(id => document.getElementById(id).value = '');
  showToast(name + ' を登録しました');
  renderBookings();
}

// === BF Tab ===
const BF_SHEET_ID = '19mSXbPIvDSjck7Pq0MHh9M2YIK5SASbC7mgxl5zKpD8';
let bfUnlocked = false;
let bfPatientData = [];
let bfContractData = [];

async function loadBFSheetData() {
  try {
    const [patRes, conRes] = await Promise.all([
      fetch(`https://docs.google.com/spreadsheets/d/${BF_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('患者様リスト환자 목록')}`).then(r => r.text()),
      fetch(`https://docs.google.com/spreadsheets/d/${BF_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('成約リスト 예약 목록')}`).then(r => r.text())
    ]);
    bfPatientData = parseBFCSV(patRes);
    bfContractData = parseBFContractCSV(conRes);
  } catch(e) { console.warn('BF sheet load error:', e); }
}

function parseBFCSV(csv) {
  const lines = csv.split('\n');
  if (lines.length < 2) return [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (!cols[2]) continue; // 名前なし
    rows.push({
      no: cols[0]||'', date: cols[1]||'', name: cols[2]||'', route: cols[3]||'',
      promo: cols[4]||'', facility: cols[5]||'', dr: cols[6]||'',
      age: cols[7]||'', gender: cols[8]||'', area: cols[9]||'', job: cols[10]||'',
      status: cols[11]||'', treatReserve: cols[12]||'', impressReserve: cols[13]||'',
      setDate: cols[14]||'', teeth: cols[15]||'', sales: cols[16]||'',
      payment: cols[17]||'', completed: cols[18]||'',
      refClinic: cols[19]||'', referrer: cols[20]||'', refFee: cols[21]||'', refPaid: cols[22]||''
    });
  }
  return rows;
}

function parseBFContractCSV(csv) {
  const lines = csv.split('\n');
  if (lines.length < 2) return [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (!cols[1]) continue;
    rows.push({
      date: cols[0]||'', name: cols[1]||'', route: cols[2]||'',
      facility: cols[3]||'', age: cols[4]||'', gender: cols[5]||'',
      area: cols[6]||'', job: cols[7]||'', status: cols[8]||'',
      treatReserve: cols[9]||'', impressReserve: cols[10]||'',
      payment: cols[11]||'', completed: cols[12]||'',
      setFacility: cols[13]||'', refClinic: cols[14]||'',
      sales: cols[15]||'', referrer: cols[16]||''
    });
  }
  return rows;
}
async function unlockBF() {
  if (bfUnlocked) { renderBF('all'); return; }
  const pw = prompt('BFタブのパスワードを入力してください');
  if (pw === 'black') {
    bfUnlocked = true;
    document.getElementById('bf-tab-btn').style.display = '';
    await loadBFSheetData();
    // サブタブ切替
    document.querySelectorAll('.sub-nav-btn').forEach(s => s.classList.remove('active'));
    document.getElementById('bf-tab-btn').classList.add('active');
    const mainEl = document.getElementById('bf-tab-btn').closest('main');
    if (mainEl) mainEl.querySelectorAll('[id^="sub-"]').forEach(s => s.hidden = s.id !== 'sub-bk-bf');
    renderBF('all');
  } else if (pw !== null) {
    showToast('パスワードが正しくありません', true);
  }
}

function renderBF(period) {
  period = period || 'all';
  const bkExtraBF = loadData('bk-extra', {});
  let data = bookingsData.filter(d => {
    if (d.status === '除外') return false;
    // 権限フィルタ
    if (_hasPromoRestriction() && !_matchesAllowedPromo(d.source)) return false;
    if (normSvc(d.service) === 'BF') return true;
    // 成約施術がBFの人も含める
    const key = d.name + '|' + d.applyDate;
    const extra = bkExtraBF[key];
    if (extra && extra.contractService === 'BF') return true;
    if (d.contractService === 'BF') return true;
    return false;
  });

  // 期間フィルター
  const now = new Date();
  const todayStr = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')}`;
  const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate()-7);
  const monthStart = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/01`;
  const getDateStr = (d) => { const m = (d.applyDate||'').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); return m ? `${m[1]}/${String(parseInt(m[2])).padStart(2,'0')}/${String(parseInt(m[3])).padStart(2,'0')}` : ''; };

  if (period === 'today') data = data.filter(d => getDateStr(d) === todayStr);
  else if (period === 'week') data = data.filter(d => getDateStr(d) >= `${weekAgo.getFullYear()}/${String(weekAgo.getMonth()+1).padStart(2,'0')}/${String(weekAgo.getDate()).padStart(2,'0')}`);
  else if (period === 'month') data = data.filter(d => getDateStr(d) >= monthStart);

  const total = data.length;
  const cancelled = data.filter(d => d.status === 'キャンセル').length;
  const visited = data.filter(d => isVisitedStatus(d.status)).length;
  const contracted = data.filter(d => d.status === '成約').length;
  const todayForRate = new Date(); todayForRate.setHours(0,0,0,0);
  const pastBk = data.filter(d => { const m = (d.bookDate||'').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); return m && new Date(parseInt(m[1]),parseInt(m[2])-1,parseInt(m[3])) < todayForRate; });
  const pastVisited = pastBk.filter(d => isVisitedStatus(d.status)).length;
  const vr = pastBk.length > 0 ? Math.round(pastVisited/pastBk.length*100) : 0;
  const cr = visited > 0 ? pct(contracted, visited) : 0;

  document.getElementById('bf-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">BF予約数</span><span class="stat-num">${total}</span></div>
    <div class="stat-card"><span class="stat-label">キャンセル</span><span class="stat-num" style="color:var(--red)">${cancelled}</span></div>
    <div class="stat-card"><span class="stat-label">来院済</span><span class="stat-num">${visited}</span></div>
    <div class="stat-card"><span class="stat-label">来院率</span><span class="stat-num">${vr}%</span></div>
    <div class="stat-card"><span class="stat-label">成約</span><span class="stat-num" style="color:var(--green)">${contracted}</span></div>
    <div class="stat-card"><span class="stat-label">成約率</span><span class="stat-num">${cr}%</span></div>
  `;

  // 医院別
  const facG = {}; data.forEach(d => { const f = normFac(d.facility); if (!facG[f]) facG[f]={t:0,v:0,c:0}; facG[f].t++; if(isVisitedStatus(d.status)) facG[f].v++; if(d.status==='成約') facG[f].c++; });
  document.getElementById('bf-facility-chart').innerHTML = Object.entries(facG).sort((a,b)=>b[1].t-a[1].t).map(([name,v]) =>
    `<div class="bar-row"><div class="bar-label">${name}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(Math.round(v.t/total*100),3)}%"><span>${Math.round(v.t/total*100)}%</span></div></div><div class="bar-value" style="min-width:100px;font-size:10px">${v.t}件 来院${v.v} 成約${v.c}</div></div>`
  ).join('') || '<p style="color:var(--text-muted)">データなし</p>';

  // プロモ別
  const promoG = {}; data.forEach(d => { const p = d.source||'(なし)'; promoG[p] = (promoG[p]||0)+1; });
  renderBarChart('bf-promo-chart', Object.entries(promoG).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([name,count]) => ({ name: name.length>20?name.slice(0,20)+'…':name, rate: Math.round(count/total*100), decided: count, consulted: total })));

  // 日別
  const daily = {}; data.forEach(d => { const ds = getDateStr(d); if (ds) { const short = ds.slice(5); daily[short] = (daily[short]||0)+1; } });
  const dailySorted = Object.entries(daily).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,14);
  const maxD = Math.max(...dailySorted.map(([,v])=>v),1);
  document.getElementById('bf-daily-chart').innerHTML = dailySorted.map(([day,count]) =>
    `<div class="bar-row"><div class="bar-label">${day}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(Math.round(count/maxD*100),5)}%"><span>${count}</span></div></div><div class="bar-value">${count}件</div></div>`
  ).join('') || '<p style="color:var(--text-muted)">データなし</p>';

  // スプレッドシート患者リスト
  document.getElementById('bf-sheet-count').textContent = bfPatientData.length + '件';
  document.getElementById('bf-sheet-tbody').innerHTML = bfPatientData.map(d => {
    const st = d.completed ? 'background:#f0fdf4' : d.status && d.status.includes('検討') ? 'background:#fffbeb' : '';
    return `<tr style="${st}">
      <td style="font-size:10px">${d.date||'-'}</td>
      <td style="font-size:11px;font-weight:500">${d.name}</td>
      <td style="font-size:10px">${d.route||'-'}</td>
      <td style="font-size:10px">${d.facility||'-'}</td>
      <td style="font-size:10px">${d.dr||'-'}</td>
      <td style="font-size:10px">${d.gender||'-'}</td>
      <td style="font-size:10px">${d.area||'-'}</td>
      <td style="font-size:10px">${d.status||'-'}</td>
      <td style="font-size:10px;text-align:center">${d.teeth||'-'}</td>
      <td style="font-size:10px">${d.sales?'¥'+d.sales:'-'}</td>
      <td style="font-size:10px;text-align:center">${d.payment||'-'}</td>
      <td style="font-size:10px;text-align:center">${d.completed||'-'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="12" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';

  // 成約リスト
  document.getElementById('bf-contract-count').textContent = bfContractData.length + '件';
  document.getElementById('bf-contract-tbody').innerHTML = bfContractData.map(d => {
    return `<tr>
      <td style="font-size:10px">${d.date||'-'}</td>
      <td style="font-size:11px;font-weight:500">${d.name}</td>
      <td style="font-size:10px">${d.route||'-'}</td>
      <td style="font-size:10px">${d.facility||'-'}</td>
      <td style="font-size:10px">${d.treatReserve||'-'}</td>
      <td style="font-size:10px">${d.impressReserve||'-'}</td>
      <td style="font-size:10px">${d.payment||'-'}</td>
      <td style="font-size:10px">${d.completed||'-'}</td>
      <td style="font-size:10px">${d.sales?'¥'+d.sales:'-'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';

  // 予約ツールデータ
  // BF予約一覧（メイン予約一覧と同じ機能）
  _bfAllData = data;
  renderBFBookings(data);
}

// === BF セット進捗 (lifecycle) ===
// インプラント用拡張ステータス (予約と来院で共通)
// v269: 検討中 / お断り / P処置 / C処置 / ガイド印象 を追加
const IMPLANT_STATUSES_ORDERED = [
  '未対応','予約連絡待ち','後追いLINE済み','確認済','予約変更','来院済','検討中','成約',
  'P処置','C処置','CT/診断','ガイド印象','手術予定','治癒期間','印象','セット','完了',
  'キャンセル','お断り','除外'
];
// 治療ステージ (来院済+αとして扱う) - インプラント用
// v269: P処置 / C処置 / ガイド印象 を治療ステージに追加 (来院済としてカウント)
const IMPLANT_TREATMENT_STAGES = ['P処置','C処置','CT/診断','ガイド印象','手術予定','治癒期間','印象','セット','完了'];
// 来院済としてカウントするステータス (インプラントの治療ステージも含む)
// v269: 検討中 も来院済として扱う (来院後の検討中であるため)
function isVisitedStatus(s) {
  return s === '来院済' || s === '検討中' || s === '成約' || IMPLANT_TREATMENT_STAGES.includes(s);
}
// 成約済としてカウントするステータス (成約 + 治療継続ステージ)
function isContractedStatus(s) {
  return s === '成約' || IMPLANT_TREATMENT_STAGES.includes(s);
}
// インプラントか判定
function isImplantBooking(d) {
  try { return getTreatmentCategory(d) === 'インプラント'; } catch(_) { return false; }
}

const BF_STATUSES = [
  { value: '予約連絡待ち', color: '#a855f7' },
  { value: '後追いLINE済み', color: '#06b6d4' },
  { value: '予約変更', color: '#f59e0b' },
  { value: '離脱', color: '#9ca3af' },
  { value: '検討中', color: '#f59e0b' },
  { value: '成約', color: '#10b981' },
  { value: 'ローン審査中', color: '#eab308' },
  { value: 'ローン審査落', color: '#b91c1c' },
  { value: '矯正決定(BF保留)', color: '#8b5cf6' },
  { value: 'ラブリエ決定(BF保留)', color: '#a855f7' },
  { value: 'インプラント決定(BF保留)', color: '#c026d3' },
  { value: '印象待ち(治療無)', color: '#3b82f6' },
  { value: '印象待ち(治療有)', color: '#2563eb' },
  { value: '治療中', color: '#1d4ed8' },
  { value: 'セット日確定待ち', color: '#0891b2' },
  { value: 'セット待ち', color: '#0e7490' },
  { value: 'セット完了', color: '#059669' },
  { value: 'キャンセル', color: '#dc2626' }
];
let bfLifecycleCache = {}; // key: name|applyDate → {bf_status, bf_next_date, ...}
let bfHistoryCache = {}; // key: name|applyDate → [events]

async function loadBFLifecycleData() {
  try {
    // edited_book_date / edited_name / edited_service を含めて読み込み
    // ※ DBにカラム未追加の環境では select が失敗する場合があるのでフォールバック付き
    let data;
    try {
      const r1 = await sb.from('booking_status').select('name, apply_date, bf_status, bf_next_date, bf_next_fixed, bf_cs_facility, bf_cs_doctor, bf_set_facility, bf_memo, contract_amount, bf_travel_cost, memo, edited_book_date, edited_name, edited_service, incentive_paid, paid_at, paid_by, updated_at');
      data = r1.data;
      if (r1.error) throw r1.error;
    } catch(eCol) {
      console.warn('edited_*/incentive_paid columns missing, falling back', eCol);
      try {
        const r2 = await sb.from('booking_status').select('name, apply_date, bf_status, bf_next_date, bf_next_fixed, bf_cs_facility, bf_cs_doctor, bf_set_facility, bf_memo, contract_amount, bf_travel_cost, memo, edited_book_date, edited_name, edited_service, updated_at');
        data = r2.data;
        if (r2.error) throw r2.error;
      } catch(eCol2) {
        console.warn('edited_* columns missing, falling back further', eCol2);
        const r3 = await sb.from('booking_status').select('name, apply_date, bf_status, bf_next_date, bf_next_fixed, bf_cs_facility, bf_cs_doctor, bf_set_facility, bf_memo, contract_amount, bf_travel_cost, memo, updated_at');
        data = r3.data;
      }
    }
    bfLifecycleCache = {};
    (data || []).forEach(r => {
      // 両方のキー (生の name+date と 正規化 name+date) にマップ → ルックアップ時にスペース差を吸収
      // ※ key / normKey は同一オブジェクト r への参照を共有するため、どちらを更新しても整合する。
      //   名前変更 (editPatientName) 時は両キーを明示的に掃除する必要がある (#11)
      const key = r.name + '|' + r.apply_date;
      const normKey = normName(r.name) + '|' + (r.apply_date||'').substring(0,10);
      bfLifecycleCache[key] = r;
      // 正規化キーでも引ける (空白有無どちらでもヒット) - 同一参照 r を共有
      if (!bfLifecycleCache[normKey]) bfLifecycleCache[normKey] = r;
      if (r.updated_at) setVersion('booking_status', key, r.updated_at);
      // edited_* がDB側にあれば bk-extra にマージ (DB優先、ローカルを更新)
      try {
        if (r.edited_book_date || r.edited_name || r.edited_service) {
          const bkEx = loadData('bk-extra', {});
          if (!bkEx[key]) bkEx[key] = {};
          if (r.edited_book_date != null) bkEx[key].editedBookDate = r.edited_book_date;
          if (r.edited_name != null) bkEx[key].editedName = r.edited_name;
          if (r.edited_service != null) bkEx[key].editedService = r.edited_service;
          saveData('bk-extra', bkEx);
        }
      } catch(_){}
    });
  } catch(e) { console.warn('BF lifecycle load', e); }
}

// BFキャッシュから正規化キーでも引くヘルパー
function getBFInfo(name, applyDate) {
  const k1 = name + '|' + applyDate;
  if (bfLifecycleCache[k1]) return bfLifecycleCache[k1];
  const k2 = normName(name) + '|' + (applyDate||'').substring(0,10);
  return bfLifecycleCache[k2] || null;
}

async function loadBFHistory(names) {
  try {
    const { data } = await sb.from('bf_history').select('*').in('booking_name', names).order('created_at', { ascending: false });
    bfHistoryCache = {};
    (data || []).forEach(h => {
      const key = h.booking_name + '|' + h.booking_apply_date;
      if (!bfHistoryCache[key]) bfHistoryCache[key] = [];
      bfHistoryCache[key].push(h);
    });
  } catch(e) { console.warn('BF history load', e); }
}

function getLoggedUserName() {
  const role = sessionStorage.getItem('role') || 'admin';
  if (role === 'custom') return sessionStorage.getItem('customName') || 'custom';
  return role;
}

async function saveBFLifecycleField(name, applyDate, field, value) {
  const key = name + '|' + applyDate;
  const current = bfLifecycleCache[key] || {};
  const fromStatus = current.bf_status || null;
  const update = { name, apply_date: applyDate };
  update[field] = value;
  // メモ連動: 空値で上書きしないよう条件付き
  if (field === 'bf_memo' && value) update.memo = value;
  if (field === 'memo' && value) update.bf_memo = value;

  // === 連動: BFステータス変更時、予約一覧の状態も自動更新 ===
  // BF_TO_STATUS にマッピングが無い場合も、editedStatus に value を直接書く
  // (矯正/インプラント等の非BF治療でもステータスが予約一覧と同期するように)
  if (field === 'bf_status' && value) {
    const mapped = BF_TO_STATUS[value];
    if (mapped) {
      // マッピング有: DBとメモリの両方に正規化された status を設定
      update.status = mapped;
      const nnTarget = normName(name);
      const dateKey = normDateKey(applyDate);
      (bookingsData || []).forEach(b => {
        if (normName(b.name) === nnTarget && normDateKey(b.bookDate || b.applyDate) === dateKey) {
          b.status = mapped;
        }
      });
    }
    // マッピング有無に関わらず、bk-extra.editedStatus は常に value で上書き (クリア含む)
    try {
      const bkEx = loadData('bk-extra', {});
      if (!bkEx[key]) bkEx[key] = {};
      bkEx[key].editedStatus = mapped || value;
      saveData('bk-extra', bkEx);
    } catch(_){}
  }
  // === 金額連動: contract_amount は bookingsData.contractAmount と同期 ===
  if (field === 'contract_amount') {
    const nnTarget = normName(name);
    const dateKey = normDateKey(applyDate);
    (bookingsData || []).forEach(b => {
      if (normName(b.name) === nnTarget && normDateKey(b.bookDate || b.applyDate) === dateKey) {
        b.contractAmount = Number(value) || 0;
      }
    });
  }


  // A2: 楽観的ロック - 既存行は updated_at チェック付きで更新
  const seenVersion = getVersion('booking_status', key);
  if (seenVersion) {
    // 既存行がある → 条件付き更新
    const { ...changes } = update;
    delete changes.name; delete changes.apply_date;
    const lockRes = await conditionalUpdate('booking_status', { name, apply_date: applyDate }, seenVersion, changes);
    if (lockRes.conflict) {
      showConflictDialog(
        `${name} のデータが他の人によって先に更新されました。最新を読み込んでから編集してください。`,
        async () => { await loadBFLifecycleData(); renderBFLifecycle(); }
      );
      return false;
    }
    if (!lockRes.ok) {
      // ネットワークエラー等 → safeSave でリトライ
      const res = await safeSave({ type:'upsert', table:'booking_status', payload: update, options: { onConflict:'name,apply_date' } });
      if (!res.ok) showToast('⚠ 一時保存に失敗。自動再送信します', true);
    }
  } else {
    // 新規 → 通常 upsert (safeSaveでリトライ付き)
    const res = await safeSave({ type:'upsert', table:'booking_status', payload: update, options: { onConflict:'name,apply_date' } });
    if (!res.ok) showToast('⚠ 一時保存に失敗。自動再送信します', true);
  }
  // キャッシュ更新
  if (!bfLifecycleCache[key]) bfLifecycleCache[key] = { name, apply_date: applyDate };
  bfLifecycleCache[key][field] = value;
  // メモ連動: 予約一覧の d._memo も更新 (スペース差含めた同名患者も対応)
  if (field === 'bf_memo' || field === 'memo') {
    const nnTarget = normName(name);
    const dateKey = (applyDate || '').substring(0,10);
    (bookingsData || []).forEach(b => {
      if (normName(b.name) === nnTarget && (b.applyDate||'').substring(0,10) === dateKey) {
        b._memo = value;
      }
    });
    const bk = (bookingsData || []).find(b => b.name === name && b.applyDate === applyDate);
    try {
      const memos = loadData('bk-memos', {});
      memos[key] = value;
      saveData('bk-memos', memos);
    } catch(_){}
    bfLifecycleCache[key].memo = value;
    bfLifecycleCache[key].bf_memo = value;
  }
  // ステータス変更時は履歴記録
  if (field === 'bf_status' && fromStatus !== value) {
    const hist = {
      booking_name: name,
      booking_apply_date: applyDate,
      from_status: fromStatus,
      to_status: value,
      next_date: current.bf_next_date || null,
      next_fixed: current.bf_next_fixed || false,
      cs_facility: current.bf_cs_facility || null,
      cs_doctor: current.bf_cs_doctor || null,
      memo: current.bf_memo || null,
      changed_by: getLoggedUserName()
    };
    try { await sb.from('bf_history').insert(hist); } catch(e) { console.warn('bf_history insert failed:', e); }
    if (!bfHistoryCache[key]) bfHistoryCache[key] = [];
    bfHistoryCache[key].unshift({ ...hist, created_at: new Date().toISOString() });
  }
  return true;
}

async function renderBFLifecycle() {
  await loadBFLifecycleData();
  // ヘッダー折りたたみトグル (1回だけバインド)
  const collapseBtn = document.getElementById('bf-lc-collapse');
  const expandBtn = document.getElementById('bf-lc-expand');
  const applyCollapse = (collapsed) => {
    const hdr = document.querySelector('.header'); // 上部ナビ
    const bfSubNav = document.querySelector('#sub-bk-bf > div'); // BF一覧/進捗/… タブ
    const bfLcHdr = document.getElementById('bf-lc-header-wrap');
    const expandWrap = document.getElementById('bf-lc-expand-wrap');
    const tableWrap = document.querySelector('#bf-lifecycle .data-table-wrap');
    if (collapsed) {
      if (hdr) hdr.style.display = 'none';
      if (bfSubNav) bfSubNav.style.display = 'none';
      if (bfLcHdr) bfLcHdr.style.display = 'none';
      if (expandWrap) expandWrap.style.display = 'block';
      if (tableWrap) tableWrap.style.maxHeight = 'calc(100vh - 80px)';
    } else {
      if (hdr) hdr.style.display = '';
      if (bfSubNav) bfSubNav.style.display = '';
      if (bfLcHdr) bfLcHdr.style.display = '';
      if (expandWrap) expandWrap.style.display = 'none';
      if (tableWrap) tableWrap.style.maxHeight = '';
    }
  };
  if (collapseBtn && !collapseBtn._bound) {
    collapseBtn._bound = true;
    collapseBtn.addEventListener('click', () => applyCollapse(true));
  }
  if (expandBtn && !expandBtn._bound) {
    expandBtn._bound = true;
    expandBtn.addEventListener('click', () => applyCollapse(false));
  }
  // BF相談のデータを抽出 (予約日が今日以前のみ、未来分/除外 は非表示)
  const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
  let bfRowsRaw = (bookingsData || []).filter(d => {
    const svc = (d.service || '').toLowerCase();
    if (!(svc.includes('bf') || svc.includes('ブラック'))) return false;
    if (d.status === '除外') return false;
    const bd = parseDate(d.bookDate);
    if (bd && bd > todayEnd) return false;
    return true;
  });
  // 同一人物(名前スペース差)を重複排除
  const bfRows = dedupBFRows(bfRowsRaw);

  // 既存データの状態→BFステータス 一括同期 (重複防止のため1セッションに1回のみ実行)
  if (!window._bfSyncDone) {
    window._bfSyncDone = true;
    await syncStatusToBFStatus(bfRows);
  }

  // 履歴読み込み
  await loadBFHistory(bfRows.map(r => r.name));

  // ファネル
  const counts = {};
  BF_STATUSES.forEach(s => counts[s.value] = 0);
  let noStatus = 0;
  bfRows.forEach(d => {
    const info = bfLifecycleCache[d.name + '|' + d.applyDate];
    const st = info?.bf_status;
    if (st && counts[st] !== undefined) counts[st]++;
    else noStatus++;
  });
  const funnelEl = document.getElementById('bf-lc-funnel');
  if (funnelEl) {
    funnelEl.innerHTML = `
      <div style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;padding:4px 10px;background:var(--card);border:1px solid var(--border);border-radius:6px;min-width:60px"><span style="font-size:9px;color:var(--text-sub)">総計</span><span style="font-size:16px;font-weight:700">${bfRows.length}</span></div>
      <div style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;padding:4px 10px;background:var(--card);border:1px solid #ccc;border-radius:6px;min-width:60px"><span style="font-size:9px;color:var(--text-sub)">未設定</span><span style="font-size:16px;font-weight:700">${noStatus}</span></div>
      ${BF_STATUSES.map(s => `<div style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;padding:4px 10px;background:var(--card);border-left:3px solid ${s.color};border-top:1px solid var(--border-light);border-right:1px solid var(--border-light);border-bottom:1px solid var(--border-light);border-radius:6px;min-width:60px"><span style="font-size:9px;color:var(--text-sub);white-space:nowrap">${s.value}</span><span style="font-size:15px;font-weight:700;color:${s.color}">${counts[s.value]}</span></div>`).join('')}
    `;
  }

  // フィルター選択肢
  const stSel = document.getElementById('bf-lc-filter-status');
  if (stSel) stSel.innerHTML = '<option value="">BFステータス:全て</option><option value="__none">未設定</option>' + BF_STATUSES.map(s => `<option value="${s.value}">${s.value}</option>`).join('');
  const csFacSel = document.getElementById('bf-lc-filter-fac');
  // 配列保存されたCS医院を個別に展開
  const csFacSet = new Set();
  Object.values(bfLifecycleCache).forEach(v => {
    parseCsFac(v.bf_cs_facility).forEach(f => { if (f) csFacSet.add(f); });
  });
  const csFacs = [...csFacSet].sort();
  if (csFacSel) csFacSel.innerHTML = '<option value="">CS医院:全て</option>' + csFacs.map(f => `<option>${f}</option>`).join('');
  const drSel = document.getElementById('bf-lc-filter-dr');
  const drsFromDB = [...new Set(Object.values(bfLifecycleCache).map(v => v.bf_cs_doctor).filter(Boolean))];
  const allDrs = [...new Set([...getCSDRList(), ...drsFromDB])].sort();
  if (drSel) drSel.innerHTML = '<option value="">CSDR:全て</option>' + allDrs.map(d => `<option>${d}</option>`).join('');
  // datalist (一覧の入力候補)
  const dl = document.getElementById('bf-lc-dr-options');
  if (dl) dl.innerHTML = allDrs.map(d => `<option value="${d}">`).join('');
  const setFacSel = document.getElementById('bf-lc-filter-setfac');
  if (setFacSel) setFacSel.innerHTML = '<option value="">セット医院:全て</option>' + ['BF銀座','ルミナス','中日'].map(f => `<option>${f}</option>`).join('');

  // 一覧描画
  drawBFLifecycleTable(bfRows);

  // イベント
  ['bf-lc-filter-status','bf-lc-filter-fac','bf-lc-filter-dr','bf-lc-filter-setfac','bf-lc-filter-next'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el._bound) { el.addEventListener('change', () => drawBFLifecycleTable(bfRows)); el._bound = true; }
  });
  const searchEl = document.getElementById('bf-lc-search');
  if (searchEl && !searchEl._bound) { searchEl.addEventListener('input', () => drawBFLifecycleTable(bfRows)); searchEl._bound = true; }
}

const BF_SET_FACS = ['','BF銀座','ルミナス','中日'];

// BF行を削除 (重複行を消す用途)
// - manual_bookings から削除 (手動登録分のみ)
// - booking_status を除外ステータスに
// - bk-extra に editedStatus=除外
// → 予約一覧にも表示されなくなる
async function deleteBFRow(name, applyDate) {
  try {
    // manual_bookings 削除 (手動登録されたもの)
    try {
      await sb.from('manual_bookings').delete().eq('name', name).eq('apply_date', applyDate);
    } catch(e) { console.warn('manual_bookings delete skip', e); }
    // booking_status を除外に
    try {
      await sb.from('booking_status').upsert({ name, apply_date: applyDate, status: '除外' }, { onConflict: 'name,apply_date' });
    } catch(e) { console.warn('booking_status upsert skip', e); }
    // bk-extra にも
    const bkEx = loadData('bk-extra', {});
    const key = name + '|' + applyDate;
    if (!bkEx[key]) bkEx[key] = {};
    bkEx[key].editedStatus = '除外';
    saveData('bk-extra', bkEx);
    // キャッシュ反映
    const idx = bookingsData.findIndex(b => b.name === name && b.applyDate === applyDate);
    if (idx >= 0) bookingsData[idx].status = '除外';
    showToast(name + ' を削除しました');
    if (document.getElementById('bf-lifecycle') && !document.getElementById('bf-lifecycle').hidden) {
      renderBFLifecycle();
    }
    if (typeof renderBookings === 'function') renderBookings();
  } catch(e) {
    console.error(e);
    showToast('削除エラー: ' + e.message, true);
  }
}

// 患者名を編集 (予約一覧と双方向同期)
async function editPatientName(oldName, applyDate, newName, bfRows) {
  if (!newName) return;
  try {
    // bookingsDataのキャッシュ更新
    const d = bookingsData.find(b => b.name === oldName && b.applyDate === applyDate);
    if (d) d.name = newName;

    // bk-extra (localStorage) 更新
    try {
      const bkEx = loadData('bk-extra', {});
      const key = oldName + '|' + applyDate;
      if (!bkEx[key]) bkEx[key] = {};
      bkEx[key].editedName = newName;
      saveData('bk-extra', bkEx);
    } catch(_){}

    // booking_status を name update (同じ apply_date で新しい name に)
    await sb.from('booking_status').update({ name: newName }).eq('name', oldName).eq('apply_date', applyDate);
    // manual_bookings も (手動登録分)
    await sb.from('manual_bookings').update({ name: newName }).eq('name', oldName).eq('apply_date', applyDate).catch(()=>{});
    // bfLifecycleCacheキー付け替え (#11: normKey キャッシュも同期削除/付け替え)
    const oldKey = oldName + '|' + applyDate;
    const newKey = newName + '|' + applyDate;
    const dateSuffix = (applyDate || '').substring(0,10);
    const oldNormKey = normName(oldName) + '|' + dateSuffix;
    const newNormKey = normName(newName) + '|' + dateSuffix;
    if (bfLifecycleCache[oldKey]) {
      bfLifecycleCache[newKey] = { ...bfLifecycleCache[oldKey], name: newName };
      delete bfLifecycleCache[oldKey];
    }
    // normKey 側のキャッシュ (loadBFLifecycleData が 2キー登録する実装に対応)
    // 元の normKey は必ず掃除、新しい normKey は newKey と同一参照になるよう再登録
    if (bfLifecycleCache[oldNormKey] && oldNormKey !== oldKey) delete bfLifecycleCache[oldNormKey];
    if (bfLifecycleCache[newKey] && newNormKey !== newKey) bfLifecycleCache[newNormKey] = bfLifecycleCache[newKey];
    // GAS (Google Sheets) にも反映
    fetch(GAS_API_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ oldName, applyDate, newName }) }).catch(()=>{});

    showToast(`${oldName} → ${newName} に変更`);
    // 予約一覧とBFセット進捗 両方再描画
    if (typeof renderBookings === 'function') renderBookings();
    if (bfRows) updateBFFunnelAndTable(bfRows);
  } catch(e) {
    console.error(e);
    showToast('名前変更エラー: ' + e.message, true);
  }
}

// 既存のBF予約データで 予約状態 → BFステータス を同期
async function syncStatusToBFStatus(bfRows) {
  const tasks = [];
  bfRows.forEach(d => {
    const key = d.name + '|' + d.applyDate;
    const info = bfLifecycleCache[key] || {};
    const curBF = info.bf_status;
    const status = d.status;
    const mappedBF = STATUS_TO_BF[status];
    if (!mappedBF) return;
    // 上書き条件: 成約/キャンセルは常に、来院済は未設定時のみ
    let shouldUpdate = false;
    if (status === 'キャンセル') shouldUpdate = (curBF !== 'キャンセル');
    else if (status === '成約') shouldUpdate = (!curBF || (curBF === '離脱' || curBF === '検討中'));
    else if (status === '来院済') shouldUpdate = !curBF || curBF === '離脱' || curBF === 'キャンセル';
    if (!shouldUpdate) return;
    // サイレント更新 (履歴は自動連動として残す)
    if (!bfLifecycleCache[key]) bfLifecycleCache[key] = { name: d.name, apply_date: d.applyDate };
    bfLifecycleCache[key].bf_status = mappedBF;
    tasks.push((async () => {
      const res = await safeSave({ type:'upsert', table:'booking_status', payload: { name: d.name, apply_date: d.applyDate, bf_status: mappedBF }, options: { onConflict:'name,apply_date' } });
      if (res && res.ok === false) { console.warn('sync status->bf queued', d.name); return; }
      try {
        await sb.from('bf_history').insert({
          booking_name: d.name, booking_apply_date: d.applyDate,
          from_status: curBF || null, to_status: mappedBF,
          changed_by: 'システム(一括連動)'
        });
      } catch(e) { console.warn('bf_history insert failed:', e); }
    })());
  });
  if (tasks.length) {
    console.debug(`[BF Sync] 状態→BFステータス 一括連動: ${tasks.length}件`);
    await Promise.allSettled(tasks);
  }
}

// フィルターを維持してファネルと一覧だけ更新 (フィルターリセット防止)
function updateBFFunnelAndTable(bfRows) {
  // ファネル再計算
  const counts = {};
  BF_STATUSES.forEach(s => counts[s.value] = 0);
  let noStatus = 0;
  bfRows.forEach(d => {
    const info = bfLifecycleCache[d.name + '|' + d.applyDate];
    const st = info?.bf_status;
    if (st && counts[st] !== undefined) counts[st]++;
    else noStatus++;
  });
  const funnelEl = document.getElementById('bf-lc-funnel');
  if (funnelEl) {
    funnelEl.innerHTML = `
      <div style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;padding:4px 10px;background:var(--card);border:1px solid var(--border);border-radius:6px;min-width:60px"><span style="font-size:9px;color:var(--text-sub)">総計</span><span style="font-size:16px;font-weight:700">${bfRows.length}</span></div>
      <div style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;padding:4px 10px;background:var(--card);border:1px solid #ccc;border-radius:6px;min-width:60px"><span style="font-size:9px;color:var(--text-sub)">未設定</span><span style="font-size:16px;font-weight:700">${noStatus}</span></div>
      ${BF_STATUSES.map(s => `<div style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;padding:4px 10px;background:var(--card);border-left:3px solid ${s.color};border-top:1px solid var(--border-light);border-right:1px solid var(--border-light);border-bottom:1px solid var(--border-light);border-radius:6px;min-width:60px"><span style="font-size:9px;color:var(--text-sub);white-space:nowrap">${s.value}</span><span style="font-size:15px;font-weight:700;color:${s.color}">${counts[s.value]}</span></div>`).join('')}
    `;
  }
  // 一覧だけ再描画 (フィルター値は保持)
  drawBFLifecycleTable(bfRows);
}
const CSDR_DEFAULTS = ['小池','鶴田','立松','原','西村','山田'];
function getCSDRList() {
  const saved = loadData('csdr-extra-list', []);
  return [...new Set([...CSDR_DEFAULTS, ...saved])];
}
function addCSDR(name) {
  name = (name||'').trim();
  if (!name) return;
  const saved = loadData('csdr-extra-list', []);
  if (!CSDR_DEFAULTS.includes(name) && !saved.includes(name)) {
    saved.push(name);
    saveData('csdr-extra-list', saved);
  }
}

// === 全体連動マッピング ===
// 予約一覧の状態 → BFステータスの初期値 (BF相談のみ適用)
const STATUS_TO_BF = {
  '来院済': '検討中',       // 来院したら検討中スタート (BF未設定時のみ)
  '成約': '成約',
  'キャンセル': 'キャンセル',
  '除外': null
};
// BFステータス → 予約一覧の状態 (上書き)
const BF_TO_STATUS = {
  '離脱': '来院済',
  '検討中': '来院済',
  '成約': '成約',
  'ローン審査中': '成約',
  'ローン審査落': '成約',
  '矯正決定(BF保留)': '成約',
  '印象待ち(治療無)': '成約',
  '印象待ち(治療有)': '成約',
  '治療中': '成約',
  'セット日確定待ち': '成約',
  'セット待ち': '成約',
  'セット完了': '成約',
  'キャンセル': 'キャンセル'
};

// 名前正規化: 全空白(半角/全角)除去+小文字化 で一致判定
function normName(n) {
  return (n || '').replace(/[\s\u3000]+/g, '').toLowerCase();
}
// 日付正規化: "2026/04/13"/"2026/4/13"/"4/13" 等を yyyy-mm-dd に統一
function normDateKey(s) {
  if (!s) return '';
  const s2 = String(s);
  const m3 = s2.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m3) return `${m3[1]}-${String(m3[2]).padStart(2,'0')}-${String(m3[3]).padStart(2,'0')}`;
  const m2 = s2.match(/(\d{1,2})\D+(\d{1,2})/);
  if (m2) { const y = new Date().getFullYear(); return `${y}-${String(m2[1]).padStart(2,'0')}-${String(m2[2]).padStart(2,'0')}`; }
  return s2;
}
// 同一正規化名の患者のメモをどこからでも探す (bfLifecycleCache/bk-memos/bookingsData全走査)
function findAnyMemo(name) {
  if (!name) return '';
  const nn = normName(name);
  // BF lifecycle cache (bf_memo or memo)
  for (const k in bfLifecycleCache) {
    const info = bfLifecycleCache[k];
    if (!info) continue;
    if (normName(info.name) === nn) {
      const m = info.bf_memo || info.memo || '';
      if (m) return m;
    }
  }
  // localStorage bk-memos
  try {
    const memos = loadData('bk-memos', {});
    for (const k in memos) {
      if (normName(k.split('|')[0]) === nn && memos[k]) return memos[k];
    }
  } catch(_){}
  // bookingsData 他の行
  for (const b of (bookingsData || [])) {
    if (normName(b.name) === nn && b._memo) return b._memo;
  }
  return '';
}

// BF用: 同一人物を名前正規化でグルーピング (同じ facility かつ同日)
// 生存ルール: メモ/BF進捗がある方を優先で残す (情報を失わない)
function dedupBFRows(rows) {
  const seen = new Map();
  // スコア: メモ > BFステータス設定 > 成約ステータス > 金額 の順で価値判定
  const scoreRow = (d) => {
    const info = getBFInfo(d.name, d.applyDate) || {};
    let s = 0;
    if (d._memo) s += 100;
    if (info.bf_memo) s += 100;
    if (info.bf_status) s += 50;
    if (info.bf_cs_facility) s += 10;
    if (info.bf_cs_doctor) s += 10;
    if (d.status === '成約') s += 30;
    else if (d.status === '来院済') s += 10;
    if (d.contractAmount) s += 5;
    if (d.contractService) s += 5;
    return s;
  };
  rows.forEach(d => {
    const nn = normName(d.name);
    const fac = normFac(d.facility);
    // #3/#6 対策: 同名者を誤マージしないよう、電話下4桁/メール/申込日 を複合キーに
    const phone4 = (d.phone || '').toString().replace(/\D/g,'').slice(-4);
    const emailKey = (d.email || '').toLowerCase().trim();
    const dk = (d.applyDate || '').substring(0,10) || normDateKey(d.bookDate || '');
    const idKey = phone4 || emailKey || 'X';
    const key = nn + '|' + fac + '|' + dk + '|' + idKey;
    if (!seen.has(key)) {
      seen.set(key, d);
      return;
    }
    const existing = seen.get(key);
    // スコアが高い方を"生存行"にし、もう片方の情報も吸収
    const existingScore = scoreRow(existing);
    const newScore = scoreRow(d);
    const survivor = newScore > existingScore ? d : existing;
    const loser = newScore > existingScore ? existing : d;
    // 片方にしかない情報を生存側に合わせて転送 (破壊的変更をしない前提で補完のみ)
    if (!survivor._memo && loser._memo) survivor._memo = loser._memo;
    if (!survivor.contractAmount && loser.contractAmount) survivor.contractAmount = loser.contractAmount;
    if (!survivor.contractService && loser.contractService) survivor.contractService = loser.contractService;
    if (!survivor.phone && loser.phone) survivor.phone = loser.phone;
    if (!survivor.email && loser.email) survivor.email = loser.email;
    if (!survivor.source && loser.source) survivor.source = loser.source;
    // 成約の昇格のみ (降格はしない)
    if (loser.status === '成約' && survivor.status !== '成約') survivor.status = '成約';
    else if (loser.status === '来院済' && !survivor.status) survivor.status = '来院済';
    seen.set(key, survivor);
  });
  return [...seen.values()];
}

// BFか判定
function isBFBooking(d) {
  const svc = d?.service || '';
  // ラミネート / ブラックフィルム / BF を含めてBF相談として扱う
  return /bf|ブラック|ラミネート/i.test(svc);
}

// === 治療カテゴリー判定 (来院タブ用) ===
// 優先順位: BFステータス(転向) > 成約施術 > 相談内容
function getTreatmentCategory(d) {
  if (!d) return 'その他';
  const info = getBFInfo(d.name, d.applyDate) || {};
  const bfSt = info.bf_status || '';
  // BF→他治療へ確定したケース
  if (bfSt === '矯正決定(BF保留)') return '矯正';
  if (bfSt === 'ラブリエ決定(BF保留)') return 'ラブリエ';
  if (bfSt === 'インプラント決定(BF保留)') return 'インプラント';
  // BF系ステータスが設定されているならBF
  if (bfSt && !['キャンセル', '離脱'].includes(bfSt)) return 'BF';
  const cs = (d.contractService || '').toLowerCase();
  const sv = (d.service || '').toLowerCase();
  const both = cs + ' ' + sv;
  // 成約→相談の順で判定 (より確定度の高い方優先)
  if (/bf|ブラック/i.test(both)) return 'BF';
  if (/矯正|インビザ|ワイヤー|ﾋﾟｰｽ|マウスピース/i.test(both)) return '矯正';
  if (/インプラント|ｲﾝﾌﾟﾗﾝﾄ/i.test(both)) return 'インプラント';
  if (/ラブリエ|ﾗﾌﾞﾘｴ/i.test(both)) return 'ラブリエ';
  if (/セラミック|補綴|クラウン|ベニア/i.test(both)) return '自費補綴';
  if (/根治|根管|endo/i.test(both)) return '自費根治';
  if (/ホワイトニング|ホワイト/i.test(both)) return 'ホワイトニング';
  if (/リップ/i.test(both)) return 'リップアート';
  if (/ジュエリー/i.test(both)) return 'ティースジュエリー';
  return 'その他';
}

// 治療別のステータス選択肢
const TREATMENT_STATUSES = {
  'BF': BF_STATUSES, // 既存15段階
  '矯正': [
    { value: '予約連絡待ち', color: '#a855f7' },
    { value: '後追いLINE済み', color: '#06b6d4' },
    { value: '予約変更', color: '#f59e0b' },
    { value: '検討中', color: '#f59e0b' },
    { value: '成約', color: '#10b981' },
    { value: '光学印象', color: '#3b82f6' },
    { value: '治療中', color: '#1d4ed8' },
    { value: '保定', color: '#0891b2' },
    { value: '完了', color: '#059669' },
    { value: 'キャンセル', color: '#dc2626' }
  ],
  'インプラント': [
    { value: '未対応', color: '#9ca3af' },
    { value: '予約連絡待ち', color: '#a855f7' },
    { value: '後追いLINE済み', color: '#06b6d4' },
    { value: '確認済', color: '#6366f1' },
    { value: '予約変更', color: '#f59e0b' },
    { value: '来院済', color: '#1d4ed8' },
    { value: '検討中', color: '#f59e0b' },
    { value: '成約', color: '#10b981' },
    { value: 'P処置', color: '#14b8a6' },
    { value: 'C処置', color: '#0d9488' },
    { value: 'CT/診断', color: '#3b82f6' },
    { value: 'ガイド印象', color: '#0891b2' },
    { value: '手術予定', color: '#2563eb' },
    { value: '治癒期間', color: '#1d4ed8' },
    { value: '印象', color: '#0891b2' },
    { value: 'セット', color: '#0e7490' },
    { value: '完了', color: '#059669' },
    { value: 'キャンセル', color: '#dc2626' },
    { value: 'お断り', color: '#78716c' },
    { value: '除外', color: '#6b7280' }
  ],
  'デフォルト': [
    { value: '予約連絡待ち', color: '#a855f7' },
    { value: '後追いLINE済み', color: '#06b6d4' },
    { value: '予約変更', color: '#f59e0b' },
    { value: '検討中', color: '#f59e0b' },
    { value: '成約', color: '#10b981' },
    { value: '治療中', color: '#1d4ed8' },
    { value: '完了', color: '#059669' },
    { value: 'キャンセル', color: '#dc2626' }
  ]
};
function getStatusesForTreatment(treatment) {
  return TREATMENT_STATUSES[treatment] || TREATMENT_STATUSES['デフォルト'];
}

// 来院タブ「一覧」レンダラー (全治療タイプまとめて表示)
// v273: 来院一覧の期間フィルタ状態 (デフォルト今月、来院日基準)
let _kaiinAllPeriodState = { period: 'thisMonth' };

async function renderKaiinAll(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
  // 全治療タイプの来院対象行を集計
  let allRows = (bookingsData || []).filter(d => {
    if (d.status === '除外') return false;
    const bd = parseDate(d.bookDate);
    if (bd && bd > todayEnd) return false;
    if (_hasPromoRestriction() && !_matchesAllowedPromo(d.source)) return false;
    return true;
  });
  // 期間フィルタ
  const period = _kaiinAllPeriodState.period;
  if (period) {
    const ymOf = (d, useApply) => {
      const src = useApply ? (d.applyDate||'') : (d.bookDate || d.applyDate || '');
      const m = String(src).match(/(\d{4})\D+(\d{1,2})/);
      return m ? m[1]+'-'+String(parseInt(m[2])).padStart(2,'0') : '';
    };
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    if (period === 'thisMonth') allRows = allRows.filter(d => ymOf(d, false) === ym);
    else if (period === 'thisMonthApply') allRows = allRows.filter(d => ymOf(d, true) === ym);
    else if (period === 'lastMonth') {
      const last = new Date(now); last.setMonth(last.getMonth()-1);
      const lym = `${last.getFullYear()}-${String(last.getMonth()+1).padStart(2,'0')}`;
      allRows = allRows.filter(d => ymOf(d, false) === lym);
    }
  }
  // 治療タイプ別カウント
  const byCat = {};
  allRows.forEach(d => {
    const cat = getTreatmentCategory(d) || 'その他';
    if (!byCat[cat]) byCat[cat] = { count: 0, contracted: 0, contractAmt: 0 };
    byCat[cat].count++;
    if (d.status === '成約') {
      byCat[cat].contracted++;
      byCat[cat].contractAmt += Number(d.contractAmount || 0);
    }
  });
  const catOrder = ['BF','矯正','インプラント','ラブリエ','自費補綴','自費根治','ホワイトニング','リップアート','ティースジュエリー','その他'];
  const subNavMap = {'BF':'kaiin-bf','矯正':'kaiin-kyosei','インプラント':'kaiin-implant','ラブリエ':'kaiin-labrie','自費補綴':'kaiin-hotetsu','自費根治':'kaiin-konchi','ホワイトニング':'kaiin-whitening','リップアート':'kaiin-lipart','ティースジュエリー':'kaiin-jewelry','その他':'kaiin-other'};
  const catCards = catOrder
    .filter(c => byCat[c])
    .map(c => {
      const info = byCat[c];
      const rate = info.count ? Math.round(info.contracted / info.count * 100) : 0;
      const targetSub = subNavMap[c];
      return `<div class="kaiin-all-card" data-target="${targetSub}" style="border:1px solid var(--border);border-radius:10px;padding:14px;cursor:pointer;background:#fff;transition:all .15s" onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,.08)';this.style.borderColor='#6366f1'" onmouseout="this.style.boxShadow='';this.style.borderColor='var(--border)'">
        <div style="font-size:13px;font-weight:700;margin-bottom:8px;color:var(--text)">${c}</div>
        <div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap">
          <div><span style="font-size:22px;font-weight:700;color:#111">${info.count}</span><span style="font-size:11px;color:var(--text-sub);margin-left:3px">件</span></div>
          <div style="font-size:11px;color:var(--text-sub)">成約 <span style="color:#059669;font-weight:600">${info.contracted}</span></div>
          <div style="font-size:11px;color:var(--text-sub)">率 <span style="color:${rate>=30?'#059669':'#d97706'};font-weight:600">${rate}%</span></div>
          <div style="font-size:11px;color:var(--text-sub)">¥${fmt(info.contractAmt)}</div>
        </div>
      </div>`;
    }).join('');
  const totalCount = allRows.length;
  const totalContracted = allRows.filter(d => d.status==='成約').length;
  const totalAmt = allRows.filter(d => d.status==='成約').reduce((s,d)=>s+Number(d.contractAmount||0),0);
  const totalRate = totalCount ? Math.round(totalContracted / totalCount * 100) : 0;

  // 期間ラベル
  const periodLabel = {
    'thisMonth': '今月（来院日基準）',
    'thisMonthApply': '今月（登録日基準）',
    'lastMonth': '先月',
    '': '全期間'
  }[period] || '全期間';

  el.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--text-sub);font-weight:600;letter-spacing:1px">期間</span>
      <select id="kaiin-all-period" style="font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:#fff;cursor:pointer;font-family:inherit">
        <option value="" ${period===''?'selected':''}>全期間</option>
        <option value="thisMonth" ${period==='thisMonth'?'selected':''}>今月（来院日基準）</option>
        <option value="thisMonthApply" ${period==='thisMonthApply'?'selected':''}>今月（登録日基準）</option>
        <option value="lastMonth" ${period==='lastMonth'?'selected':''}>先月</option>
      </select>
      <span style="font-size:11px;color:var(--text-sub)">表示中: <strong style="color:var(--text)">${periodLabel}</strong></span>
    </div>
    <div style="margin-bottom:14px;padding:14px;background:linear-gradient(135deg,#f9fafb 0%,#f3f4f6 100%);border-radius:10px;border:1px solid var(--border)">
      <div style="font-size:12px;color:var(--text-sub);margin-bottom:6px">全治療合計（${escapeHtml(periodLabel)}）</div>
      <div style="display:flex;gap:24px;align-items:baseline;flex-wrap:wrap">
        <div><span style="font-size:28px;font-weight:700;color:#111">${totalCount}</span><span style="font-size:12px;color:var(--text-sub);margin-left:3px">件</span></div>
        <div><span style="font-size:12px;color:var(--text-sub)">成約</span> <span style="font-size:18px;font-weight:700;color:#059669">${totalContracted}</span></div>
        <div><span style="font-size:12px;color:var(--text-sub)">成約率</span> <span style="font-size:18px;font-weight:700;color:${totalRate>=30?'#059669':'#d97706'}">${totalRate}%</span></div>
        <div><span style="font-size:12px;color:var(--text-sub)">成約金額</span> <span style="font-size:18px;font-weight:700;color:#111">¥${fmt(totalAmt)}</span></div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:20px">
      ${catCards}
    </div>
    <div style="font-size:11px;color:var(--text-sub);text-align:center;padding:10px">
      ↑ 治療タイプをクリックで詳細一覧へ
    </div>`;

  // 期間フィルタ変更で再描画
  el.querySelector('#kaiin-all-period')?.addEventListener('change', (e) => {
    _kaiinAllPeriodState.period = e.target.value;
    renderKaiinAll(containerId);
  });

  // カードクリック → 該当サブタブへ遷移
  el.querySelectorAll('.kaiin-all-card').forEach(card => {
    card.addEventListener('click', () => {
      const target = card.dataset.target;
      if (target) {
        document.querySelector(`#kaiin-sub-nav .sub-nav-btn[data-sub="${target}"]`)?.click();
      }
    });
  });
}

// 来院タブの共通レンダラー (治療種別で絞り込み)
async function renderKaiinTab(treatment, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  // 高速表示: まずキャッシュで即描画、その後バックグラウンドで最新化
  const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
  let rows = (bookingsData || []).filter(d => {
    if (getTreatmentCategory(d) !== treatment) return false;
    if (d.status === '除外') return false;
    const bd = parseDate(d.bookDate);
    if (bd && bd > todayEnd) return false;
    // 予約変更で次回予定(未来)が入っているものは来院管理から除外 (予約管理のみで追跡)
    if (d.status === '予約変更') {
      const info = (typeof bfLifecycleCache === 'object' && bfLifecycleCache) ? bfLifecycleCache[d.name + '|' + d.applyDate] : null;
      const nextIso = info && info.bf_next_date;
      if (nextIso) {
        const nd = parseDate(nextIso.replace(/-/g, '/'));
        if (nd && nd > todayEnd) return false;
      }
    }
    // staff_promo / agency の権限フィルタ
    if (_hasPromoRestriction() && !_matchesAllowedPromo(d.source)) return false;
    return true;
  });
  if (treatment === 'BF') rows = dedupBFRows(rows);

  // 1. まずキャッシュで即表示 (待たない)
  renderKaiinSimpleList(treatment, rows, containerId);

  // 2. バックグラウンドでBFキャッシュ更新→履歴取得→必要なら再描画
  (async () => {
    const before = JSON.stringify(bfLifecycleCache);
    await loadBFLifecycleData();
    if (treatment === 'BF') {
      await loadBFHistory(rows.map(r => r.name));
    }
    if (before !== JSON.stringify(bfLifecycleCache)) {
      // 変化あれば再描画
      const el = document.getElementById(containerId);
      if (el) {
        const tbody = el.querySelector('.kaiin-tbody');
        if (tbody) drawKaiinRows(treatment, rows, el);
      }
    }
  })();
}

function renderKaiinSimpleList(treatment, rows, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const statuses = getStatusesForTreatment(treatment);
  // カウント
  const byStatus = {};
  statuses.forEach(s => byStatus[s.value] = 0);
  let noSt = 0;
  rows.forEach(d => {
    const info = getBFInfo(d.name, d.applyDate) || {};
    const st = info.bf_status;
    if (st && byStatus[st] !== undefined) byStatus[st]++;
    else noSt++;
  });

  const facs = ['全て','BF銀座','エスカ','アール','ウィズ','ルミナス','茶屋','知立','小牧','八事','大森','京都'];
  const FACS_OPTS = ['','BF銀座','エスカ','アール','ウィズ','ルミナス','茶屋','知立','小牧','八事','大森','京都'];

  // CS医院・セット医院・相談のユニーク値を算出
  const csFacSet = new Set();
  rows.forEach(d => {
    const info = getBFInfo(d.name, d.applyDate) || {};
    const csFac = info.bf_cs_facility || normFac(d.facility) || '';
    parseCsFac(csFac).forEach(f => f && csFacSet.add(f));
  });
  const csFacOpts = [...csFacSet].sort();
  const setFacOpts = ['BF銀座','ルミナス','中日'];
  const CONSULT_TYPES = ['BF相談','矯正相談','インプラント相談','ラブリエ相談','自費補綴相談','自費根治相談','ホワイトニング','リップアート','ティースジュエリー','その他'];

  el.innerHTML = `
    <button class="kaiin-header-toggle" style="padding:4px 10px;font-size:11px;background:var(--bg);border:1px solid var(--border);border-radius:4px;cursor:pointer;white-space:nowrap">▼ ヘッダーを表示</button>
    <div class="kaiin-topbar" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-bottom:10px;padding:4px 6px;background:var(--card);border:1px solid var(--border);border-radius:6px">
      <input type="text" class="form-input kaiin-filter-search" data-treatment="${treatment}" placeholder="🔍 名前検索" style="width:140px;padding:5px 8px;font-size:12px">
      <select class="form-select kaiin-filter-period" data-treatment="${treatment}" style="font-size:12px;padding:5px 8px;width:auto">
        <option value="">期間:全て</option>
        <option value="thisMonth" selected>今月（来院日基準）</option>
        <option value="thisMonthApply">今月（登録日基準）</option>
        <option value="lastMonth">先月</option>
      </select>
      <span class="kaiin-filter-tool-slot"></span>
      <span class="kaiin-filter-promo-slot"></span>
      <span class="kaiin-filter-csfac-slot"></span>
      <span class="kaiin-filter-setfac-slot"></span>
      <span class="kaiin-filter-consult-slot"></span>
      <span class="kaiin-filter-status-slot"></span>
      <select class="form-select kaiin-sort" data-treatment="${treatment}" style="font-size:12px;padding:5px 8px;width:auto">
        <option value="date-desc" selected>ソート:来院日(新→古)</option>
        <option value="date-asc">来院日(古→新)</option>
        <option value="status">ステータス順</option>
        <option value="name">名前順</option>
      </select>
      <button class="btn btn-outline kaiin-pdf-btn" data-treatment="${treatment}" style="font-size:11px;padding:5px 8px;min-height:28px;white-space:nowrap">📄 PDF出力</button>
    </div>
    <div class="kaiin-header-wrap" style="display:none">
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;overflow-x:auto;align-items:center">
        <div style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;padding:4px 10px;background:var(--card);border:1px solid var(--border);border-radius:6px;min-width:60px"><span style="font-size:9px;color:var(--text-sub)">総計</span><span style="font-size:16px;font-weight:700" class="kaiin-count-total">${rows.length}</span></div>
        <div style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;padding:4px 10px;background:var(--card);border:1px solid #ccc;border-radius:6px;min-width:60px"><span style="font-size:9px;color:var(--text-sub)">未設定</span><span style="font-size:16px;font-weight:700" class="kaiin-count-unset">${noSt}</span></div>
        ${statuses.map(s => `<div style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;padding:4px 10px;background:var(--card);border-left:3px solid ${s.color};border-top:1px solid var(--border-light);border-right:1px solid var(--border-light);border-bottom:1px solid var(--border-light);border-radius:6px;min-width:60px"><span style="font-size:9px;color:var(--text-sub);white-space:nowrap">${s.value}</span><span style="font-size:15px;font-weight:700;color:${s.color}" class="kaiin-count-st" data-st="${s.value}">${byStatus[s.value]}</span></div>`).join('')}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
        <select class="form-select kaiin-filter-fac" data-treatment="${treatment}" style="font-size:12px;padding:6px 10px;width:auto"><option value="">医院(旧):全て</option>${FACS_OPTS.slice(1).map(f => `<option>${f}</option>`).join('')}</select>
      </div>
    </div>
    <div class="card" style="padding:6px">
      <div style="font-size:11px;color:var(--text-sub);margin-bottom:4px">一覧 <span class="kaiin-count">${rows.length}件</span></div>
      <div class="data-table-wrap kaiin-table-wrap" style="max-height:calc(100vh - 320px);overflow-y:auto">
        <table class="data-table compact">
          <thead><tr>
            <th style="width:55px">来院</th>
            <th style="text-align:left;width:130px">名前</th>
            <th style="width:90px">ツール/プロモ</th>
            <th style="width:85px">CS医院</th>
            <th style="width:85px">相談</th>
            <th style="width:130px">ステータス</th>
            <th style="width:75px">次回予定</th>
            ${treatment === 'BF' ? '<th style="width:75px">セット医院</th>' : ''}
            <th style="width:85px">売上</th>
            ${treatment === 'BF' ? '<th style="width:70px">交通費</th>' : ''}
            <th>メモ</th>
          </tr></thead>
          <tbody class="kaiin-tbody"></tbody>
        </table>
      </div>
    </div>
  `;

  // トグル + フィルター群を page-header に移動してタイトル横に1行で並べる
  let toggleBtn = el.querySelector('.kaiin-header-toggle');
  let topbar = el.querySelector('.kaiin-topbar');
  try {
    const parentSub = el.closest('[id^="sub-kaiin-"]');
    const pageHeader = parentSub?.querySelector('.page-header');
    if (pageHeader) {
      pageHeader.style.display = 'flex';
      pageHeader.style.alignItems = 'center';
      pageHeader.style.gap = '8px';
      pageHeader.style.flexWrap = 'nowrap';
      pageHeader.style.overflowX = 'auto';
      pageHeader.style.padding = '6px 8px';
      pageHeader.querySelectorAll('.kaiin-header-toggle, .kaiin-topbar').forEach(n => {
        if (n !== toggleBtn && n !== topbar) n.remove();
      });
      const h2 = pageHeader.querySelector('h2');
      if (h2) { h2.style.margin = '0'; h2.style.flex = '0 0 auto'; h2.style.whiteSpace = 'nowrap'; h2.style.fontSize = '16px'; }
      if (toggleBtn) pageHeader.appendChild(toggleBtn);
      if (topbar) {
        topbar.style.margin = '0';
        topbar.style.padding = '0';
        topbar.style.background = 'transparent';
        topbar.style.border = 'none';
        topbar.style.flexWrap = 'nowrap';
        topbar.style.flex = '1';
        topbar.style.minWidth = '0';
        pageHeader.appendChild(topbar);
      }
    }
  } catch(_){}

  // ヘッダー (サマリーカウント) の表示トグル + トップナビ圧縮
  const topHdr = document.querySelector('.header');
  const subNav = document.getElementById('kaiin-sub-nav');
  const applyCompact = (compact) => {
    if (compact) {
      if (topHdr) topHdr.style.display = 'none';
      if (subNav) subNav.style.display = 'none';
      const tw = el.querySelector('.kaiin-table-wrap'); if (tw) tw.style.maxHeight = 'calc(100vh - 110px)';
    } else {
      if (topHdr) topHdr.style.display = '';
      if (subNav) subNav.style.display = '';
      const tw = el.querySelector('.kaiin-table-wrap'); if (tw) tw.style.maxHeight = 'calc(100vh - 260px)';
    }
  };
  // 初期はヘッダー非表示(コンパクト)
  applyCompact(true);
  toggleBtn?.addEventListener('click', () => {
    const w = el.querySelector('.kaiin-header-wrap');
    const shown = w.style.display !== 'none';
    if (shown) {
      w.style.display = 'none';
      toggleBtn.textContent = '▼ ヘッダーを表示';
      applyCompact(true);
    } else {
      w.style.display = '';
      toggleBtn.textContent = '▲ ヘッダーを隠す';
      applyCompact(false);
    }
  });
  // === マルチセレクトフィルター初期化 ===
  // プロモの値をrowsから抽出
  const promoList = [...new Set(rows.map(d => d.source).filter(p => p && p.trim() && p.trim() !== '?'))].sort();
  // ステータスフィルター: キャンセル除外をデフォルトにするため、キャンセル以外の全ステータス + 未設定 を初期選択
  const statusValues = statuses.map(s => s.value);
  const defaultStatusSelected = new Set(statusValues.filter(v => v !== 'キャンセル'));
  defaultStatusSelected.add('__UNSET__'); // 未設定も含める

  const state = {
    tool: new Set(),
    promo: new Set(),
    csfac: new Set(),
    setfac: new Set(),
    consult: new Set(),
    status: defaultStatusSelected,
  };
  el._kaiinFilterState = state;

  const triggerRedraw = () => drawKaiinRows(treatment, rows, el);

  const toolDD = createMultiSelectDropdown({ label: 'ツール', options: ['DXHUB','セレクト','手動'], selected: state.tool, onChange: triggerRedraw });
  const promoDD = createMultiSelectDropdown({ label: 'プロモ', options: promoList, selected: state.promo, onChange: triggerRedraw });
  const csfacDD = createMultiSelectDropdown({ label: 'CS医院', options: csFacOpts, selected: state.csfac, onChange: triggerRedraw });
  const setfacDD = createMultiSelectDropdown({ label: 'セット医院', options: setFacOpts, selected: state.setfac, onChange: triggerRedraw });
  const consultDD = createMultiSelectDropdown({ label: '相談', options: CONSULT_TYPES, selected: state.consult, onChange: triggerRedraw });
  const statusOpts = [...statusValues.map(v => ({ value: v, label: v })), { value: '__UNSET__', label: '未設定' }];
  const statusDD = createMultiSelectDropdown({ label: 'ｽﾃｰﾀｽ', options: statusOpts, selected: state.status, onChange: triggerRedraw });

  const filterScopeInit = el.closest('[id^="sub-kaiin-"]') || el;
  const fillSlot = (sel, dd) => { const s = filterScopeInit.querySelector(sel); if (s) s.replaceWith(dd.buttonElement); };
  fillSlot('.kaiin-filter-tool-slot', toolDD);
  fillSlot('.kaiin-filter-promo-slot', promoDD);
  fillSlot('.kaiin-filter-csfac-slot', csfacDD);
  fillSlot('.kaiin-filter-setfac-slot', setfacDD);
  fillSlot('.kaiin-filter-consult-slot', consultDD);
  fillSlot('.kaiin-filter-status-slot', statusDD);

  drawKaiinRows(treatment, rows, el);
  // フィルターイベント (topbar は page-header に移動済み → 親 sub-kaiin-* から取る)
  const filterScope = el.closest('[id^="sub-kaiin-"]') || el;
  filterScope.querySelector('.kaiin-filter-fac')?.addEventListener('change', () => drawKaiinRows(treatment, rows, el));
  filterScope.querySelector('.kaiin-filter-search')?.addEventListener('input', () => drawKaiinRows(treatment, rows, el));
  filterScope.querySelector('.kaiin-filter-period')?.addEventListener('change', () => drawKaiinRows(treatment, rows, el));
  filterScope.querySelector('.kaiin-sort')?.addEventListener('change', () => drawKaiinRows(treatment, rows, el));
  filterScope.querySelector('.kaiin-pdf-btn')?.addEventListener('click', () => {
    const prevTitle = document.title;
    const today = new Date().toISOString().slice(0,10);
    printTable(
      () => { document.title = `来院管理_${treatment}_${today}`; },
      () => { document.title = prevTitle; }
    );
  });
}

function drawKaiinRows(treatment, rows, container) {
  // フィルター群は page-header 側に移動しているため、親 sub-kaiin-* から取得
  const scope = container.closest('[id^="sub-kaiin-"]') || container;
  const fac = scope.querySelector('.kaiin-filter-fac')?.value || '';
  const q = (scope.querySelector('.kaiin-filter-search')?.value || '').trim().toLowerCase();
  const state = container._kaiinFilterState || {};
  const toolSet = state.tool || new Set();
  const promoSet = state.promo || new Set();
  const csFacSet = state.csfac || new Set();
  const setFacSet = state.setfac || new Set();
  const consultSet = state.consult || new Set();
  const statusSet = state.status || new Set();
  const sortBy = scope.querySelector('.kaiin-sort')?.value || 'date-desc';
  const statuses = getStatusesForTreatment(treatment);
  // v273: 期間フィルタ (デフォルト 今月 来院日基準)
  const period = scope.querySelector('.kaiin-filter-period')?.value || '';
  let filtered = rows.slice();
  if (period) {
    const ymOf = (d, useApply) => {
      const src = useApply ? (d.applyDate||'') : (d.bookDate || d.applyDate || '');
      const m = String(src).match(/(\d{4})\D+(\d{1,2})/);
      return m ? m[1]+'-'+String(parseInt(m[2])).padStart(2,'0') : '';
    };
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    if (period === 'thisMonth') filtered = filtered.filter(d => ymOf(d, false) === ym);
    else if (period === 'thisMonthApply') filtered = filtered.filter(d => ymOf(d, true) === ym);
    else if (period === 'lastMonth') {
      const last = new Date(now); last.setMonth(last.getMonth()-1);
      const lym = `${last.getFullYear()}-${String(last.getMonth()+1).padStart(2,'0')}`;
      filtered = filtered.filter(d => ymOf(d, false) === lym);
    }
  }
  if (fac) filtered = filtered.filter(d => normFac(d.facility) === fac);
  if (q) filtered = filtered.filter(d => (d.name||'').toLowerCase().includes(q));
  if (toolSet.size) filtered = filtered.filter(d => toolSet.has(d.tool));
  if (promoSet.size) filtered = filtered.filter(d => promoSet.has(d.source));
  if (csFacSet.size) filtered = filtered.filter(d => {
    const info = getBFInfo(d.name, d.applyDate) || {};
    const csFac = info.bf_cs_facility || normFac(d.facility) || '';
    return parseCsFac(csFac).some(f => csFacSet.has(f));
  });
  if (setFacSet.size) filtered = filtered.filter(d => setFacSet.has((getBFInfo(d.name, d.applyDate)||{}).bf_set_facility));
  if (consultSet.size) filtered = filtered.filter(d => {
    const s = d.service || '';
    const c = (() => {
      if (/ラミネート|ブラックフィルム|BF/i.test(s)) return 'BF相談';
      if (/矯正|インビザ|ワイヤー/.test(s)) return '矯正相談';
      if (/インプラント/.test(s)) return 'インプラント相談';
      if (/ラブリエ/.test(s)) return 'ラブリエ相談';
      if (/セラミック|補綴/.test(s)) return '自費補綴相談';
      if (/根治|根管/.test(s)) return '自費根治相談';
      if (/ホワイトニング/.test(s)) return 'ホワイトニング';
      if (/リップ/.test(s)) return 'リップアート';
      if (/ジュエリー/.test(s)) return 'ティースジュエリー';
      return ['BF相談','矯正相談','インプラント相談','ラブリエ相談','自費補綴相談','自費根治相談','ホワイトニング','リップアート','ティースジュエリー'].includes(s) ? s : 'その他';
    })();
    return consultSet.has(c);
  });
  // ステータスフィルター (multi-select)
  const getSt = (d) => (getBFInfo(d.name, d.applyDate)||{}).bf_status || '';
  if (statusSet.size) {
    filtered = filtered.filter(d => {
      const s = getSt(d);
      if (!s) return statusSet.has('__UNSET__');
      return statusSet.has(s);
    });
  }
  // ソート (来院日 = bookDate を使う。parseDateでISO化して比較)
  const statusOrder = (s) => { const i = statuses.findIndex(x => x.value === s); return i < 0 ? 999 : i; };
  const bookKey = (d) => {
    const pd = parseDate(d.bookDate);
    if (pd && !isNaN(pd)) return pd.getTime();
    // fallback: applyDate
    const pa = parseDate(d.applyDate);
    return pa && !isNaN(pa) ? pa.getTime() : 0;
  };
  if (sortBy === 'date-asc') filtered.sort((a,b) => bookKey(a) - bookKey(b));
  else if (sortBy === 'status') filtered.sort((a,b) => statusOrder(getSt(a)) - statusOrder(getSt(b)) || bookKey(b) - bookKey(a));
  else if (sortBy === 'name') filtered.sort((a,b) => (a.name||'').localeCompare(b.name||'','ja'));
  else filtered.sort((a,b) => bookKey(b) - bookKey(a));
  container.querySelector('.kaiin-count').textContent = filtered.length + '件';
  // サマリー数値もフィルター結果で更新
  (function updateSummary(){
    const byStatusF = {};
    statuses.forEach(s => byStatusF[s.value] = 0);
    let unsetF = 0;
    filtered.forEach(d => {
      const info = getBFInfo(d.name, d.applyDate) || {};
      const st = info.bf_status;
      if (st && byStatusF[st] !== undefined) byStatusF[st]++; else unsetF++;
    });
    const elTotal = container.querySelector('.kaiin-count-total');
    const elUnset = container.querySelector('.kaiin-count-unset');
    if (elTotal) elTotal.textContent = filtered.length;
    if (elUnset) elUnset.textContent = unsetF;
    container.querySelectorAll('.kaiin-count-st').forEach(el => {
      const v = el.dataset.st;
      el.textContent = byStatusF[v] || 0;
    });
  })();
  container.querySelector('.kaiin-tbody').innerHTML = filtered.map(d => {
    const info = getBFInfo(d.name, d.applyDate) || {};
    // インプラントは予約タブと完全統合: d.status を使用 (既存ステータスを維持)
    const st = (treatment === 'インプラント') ? (d.status || '') : (info.bf_status || '');
    const stColor = statuses.find(s => s.value === st)?.color || '';
    const stStyle = st ? `background:${stColor}22;color:${stColor};border:1px solid ${stColor};font-weight:700` : '';
    const memo = d._memo || findAnyMemo(d.name);
    // プロモ表示: 統一スタイル (バッジ風) + 手動はクリックで編集
    let promoBadge = '';
    if (d.tool === '手動') {
      // 手動 = 値があれば青バッジ風、なければ点線で入力促す
      promoBadge = `<input type="text" class="kaiin-promo-input" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" value="${esc(d.source||'')}" placeholder="プロモ入力" title="手動登録: 編集可 (クリックで入力)" style="width:100%;padding:3px 8px;font-size:10px;border:1px dashed ${d.source?'#0369a1':'#cbd5e1'};border-radius:12px;box-sizing:border-box;background:${d.source?'#e0f2fe':'#fff'};color:${d.source?'#0369a1':'#94a3b8'};font-weight:${d.source?'600':'400'};text-align:center">`;
    } else if (d.tool === 'セレクト') {
      const lbl = d.source || 'ｾﾚｸﾄﾀｲﾌﾟ';
      promoBadge = `<span title="セレクトタイプ予約 (変更不可)" style="display:inline-block;padding:3px 8px;background:#fef3c7;color:#b45309;border-radius:12px;font-size:10px;font-weight:600;cursor:help;border:1px solid #fde68a;white-space:nowrap">${esc(lbl.length>14?lbl.slice(0,14)+'…':lbl)}</span>`;
    } else if (d.source) {
      promoBadge = `<span title="DXHUB予約 (自動取得・変更不可)" style="display:inline-block;padding:3px 8px;background:#e0f2fe;color:#0369a1;border-radius:12px;font-size:10px;font-weight:600;cursor:help;border:1px solid #bae6fd">${esc(d.source.length>14?d.source.slice(0,14)+'…':d.source)}</span>`;
    } else {
      promoBadge = '<span style="font-size:10px;color:var(--text-muted)">-</span>';
    }
    // 次回予定日の色分け (BFと同じ)
    const nextDate = info.bf_next_date || '';
    const nextDateStyle = nextDate ? 'background:#dcfce7;border:1.5px solid #16a34a;color:#15803d;font-weight:600' : 'background:#fef3c7;border:1.5px solid #f59e0b;color:#92400e';
    // 丸いステータスバッジ
    const stRound = st ? `border-radius:20px;background:${stColor}22;color:${stColor};border:1.5px solid ${stColor};font-weight:700;padding:4px 10px` : 'border-radius:20px;padding:4px 10px';
    // CS医院 (複数選択可)
    const csFac = info.bf_cs_facility || normFac(d.facility) || '';
    const csFacList = parseCsFac(csFac);
    const csFacDisplay = csFacList.length ? esc(csFacList.join(', ')) : '<span style="color:var(--text-muted)">未選択</span>';
    // セット医院
    const setFac = info.bf_set_facility || '';
    // 来院日 (編集可, bookDate を YYYY-MM-DD 化)
    const bookDateISO = (() => {
      const b = d.bookDate || '';
      const m = String(b).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
      if (m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
      // 「4/18」のような短縮形式は今年の日付として扱う
      const m2 = String(b).match(/^(\d{1,2})\/(\d{1,2})/);
      if (m2) return `${new Date().getFullYear()}-${String(m2[1]).padStart(2,'0')}-${String(m2[2]).padStart(2,'0')}`;
      return '';
    })();
    // 相談種別 (編集可)
    const CONSULT_TYPES = ['BF相談','矯正相談','インプラント相談','ラブリエ相談','自費補綴相談','自費根治相談','ホワイトニング','リップアート','ティースジュエリー','その他'];
    const curConsult = (() => {
      const s = d.service || '';
      if (/ラミネート|ブラックフィルム|BF/i.test(s)) return 'BF相談';
      if (/矯正|インビザ|ワイヤー/.test(s)) return '矯正相談';
      if (/インプラント/.test(s)) return 'インプラント相談';
      if (/ラブリエ/.test(s)) return 'ラブリエ相談';
      if (/セラミック|補綴/.test(s)) return '自費補綴相談';
      if (/根治|根管/.test(s)) return '自費根治相談';
      if (/ホワイトニング/.test(s)) return 'ホワイトニング';
      if (/リップ/.test(s)) return 'リップアート';
      if (/ジュエリー/.test(s)) return 'ティースジュエリー';
      return CONSULT_TYPES.includes(s) ? s : 'その他';
    })();
    // 来院日 MM/DD 表示
    const bookMMDD = bookDateISO ? bookDateISO.substring(5).replace('-','/') : '';
    const bookDateBtnStyle = bookDateISO
      ? 'background:#eff6ff;border:1px solid #3b82f6;color:#1d4ed8;font-weight:600'
      : 'background:#fff;border:1px solid var(--border);color:var(--text-muted)';
    return `<tr>
      <td style="position:relative"><button type="button" class="kaiin-bookdate-mmdd" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-iso="${bookDateISO}" style="font-size:11px;padding:3px 4px;width:100%;box-sizing:border-box;border-radius:4px;text-align:center;cursor:pointer;${bookDateBtnStyle}">${bookMMDD||'年/月/日'}</button><input type="date" class="kaiin-bookdate-hidden" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" value="${bookDateISO}" style="position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none"></td>
      <td>${_isPII_MaskNeeded()
        ? `<span style="font-weight:500;text-align:left;font-size:11px;padding:3px 6px;display:inline-block">${esc(maskName(d.name))}</span>`
        : `<input type="text" class="kaiin-name" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" value="${esc(d.name)}" style="font-weight:500;text-align:left;font-size:11px;padding:3px 6px;width:100%;box-sizing:border-box;border:1px solid transparent;border-radius:4px;background:transparent" onfocus="this.style.border='1px solid var(--border)';this.style.background='#fff'" onblur="this.style.border='1px solid transparent';this.style.background='transparent'">`}</td>
      <td style="text-align:left">${promoBadge}</td>
      <td><button type="button" class="kaiin-csfac-btn" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" style="font-size:11px;padding:3px 6px;width:100%;text-align:center;background:transparent;border:none;cursor:pointer;color:var(--text)">${csFacDisplay}</button></td>
      <td><select class="kaiin-consult-sel kaiin-plain-sel" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" style="font-size:11px;padding:3px 4px;width:100%;background:transparent;border:none;cursor:pointer;appearance:none;-webkit-appearance:none;text-align:center;text-align-last:center">
        ${CONSULT_TYPES.map(t => `<option ${curConsult===t?'selected':''}>${t}</option>`).join('')}
      </select></td>
      <td><select class="kaiin-status-sel" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" style="font-size:10px;width:100%;${stRound};appearance:none;-webkit-appearance:none;background-image:url('data:image/svg+xml;utf8,<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;2&quot;><path d=&quot;M6 9l6 6 6-6&quot;/></svg>');background-repeat:no-repeat;background-position:right 8px center;background-size:12px;padding-right:24px">
        <option value="">未設定</option>
        ${statuses.map(s => `<option ${st===s.value?'selected':''}>${s.value}</option>`).join('')}
      </select></td>
      <td style="position:relative"><button type="button" class="kaiin-next-date-mmdd" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-iso="${nextDate}" style="font-size:11px;padding:3px 4px;width:100%;box-sizing:border-box;border-radius:4px;text-align:center;cursor:pointer;${nextDateStyle}">${nextDate?nextDate.substring(5).replace('-','/'):'年/月/日'}</button><input type="date" class="kaiin-next-date-hidden" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" value="${nextDate}" style="position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none"></td>
      ${treatment === 'BF' ? `<td><select class="kaiin-setfac-sel kaiin-plain-sel" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" style="font-size:11px;padding:3px 4px;width:100%;background:transparent;border:none;cursor:pointer;appearance:none;-webkit-appearance:none;text-align:center;text-align-last:center;color:${setFac?'var(--text)':'var(--text-muted)'}">
        ${['','BF銀座','ルミナス','中日'].map(f => `<option ${setFac===f?'selected':''} value="${f}">${f||'—'}</option>`).join('')}
      </select></td>` : ''}
      <td><input type="text" inputmode="numeric" class="kaiin-money" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="contract_amount" value="${(d.contractAmount||info.contract_amount)?Number(d.contractAmount||info.contract_amount).toLocaleString():''}" placeholder="0" style="font-size:10px;padding:2px 6px;width:100%;text-align:right;border:1px solid var(--border);border-radius:4px;font-variant-numeric:tabular-nums;box-sizing:border-box"></td>
      ${treatment === 'BF' ? `<td><input type="text" inputmode="numeric" class="kaiin-money" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="bf_travel_cost" value="${info.bf_travel_cost?Number(info.bf_travel_cost).toLocaleString():''}" placeholder="0" style="font-size:10px;padding:2px 6px;width:100%;text-align:right;border:1px solid var(--border);border-radius:4px;font-variant-numeric:tabular-nums;box-sizing:border-box"></td>` : ''}
      <td class="kaiin-memo-cell" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" style="cursor:pointer;padding:4px 8px;font-size:11px;text-align:left;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:${memo?'#fff8e1':'transparent'};border:1px dashed ${memo?'#f9a825':'var(--border)'};border-radius:4px" title="${esc(memo)}">${memo ? esc(_flattenMemoForDisplay(memo, 60)) : '<span style="color:var(--text-muted)">+ メモ</span>'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="${treatment==='BF'?11:9}" style="color:var(--text-muted);text-align:center;padding:20px">データなし</td></tr>`;

  // 次回予定: カレンダー (button + hidden date picker)
  container.querySelectorAll('.kaiin-next-date-mmdd').forEach(btn => {
    const hidden = btn.parentElement?.querySelector('.kaiin-next-date-hidden');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!hidden) return;
      if (typeof hidden.showPicker === 'function') {
        try { hidden.showPicker(); return; } catch(_) {}
      }
      hidden.focus();
      hidden.click();
    });
    if (hidden) {
      hidden.addEventListener('change', async () => {
        const iso = hidden.value || null;
        btn.dataset.iso = iso || '';
        btn.textContent = iso ? iso.substring(5).replace('-','/') : '年/月/日';
        const ok = await saveBFLifecycleField(btn.dataset.name, btn.dataset.apply, 'bf_next_date', iso);
        if (!ok) return;
        // 「予約変更」状態で次回予定を設定した場合は、予約日をそこに移動して予約管理に移す
        const name = btn.dataset.name, apply = btn.dataset.apply;
        const match = bookingsData.find(b => b.name === name && b.applyDate === apply);
        if (iso && match && (match.status === '予約変更')) {
          const nd = parseDate(iso.replace(/-/g, '/'));
          const today = new Date(); today.setHours(0,0,0,0);
          if (nd && nd > today) {
            try {
              await safeSave({
                type: 'upsert',
                table: 'booking_status',
                payload: { name, apply_date: apply, book_date: iso, status: '予約変更' },
                options: { onConflict: 'name,apply_date' }
              });
              match.bookDate = iso.replace(/-/g, '/');
              try {
                const bkEx = loadData('bk-extra', {});
                const key = name + '|' + apply;
                if (!bkEx[key]) bkEx[key] = {};
                bkEx[key].editedBookDate = iso.replace(/-/g, '/');
                saveData('bk-extra', bkEx);
              } catch(_){}
              showToast('予約日を ' + iso.substring(5).replace('-','/') + ' に移動しました (予約管理で確認)');
            } catch (e) { console.warn('予約日更新失敗', e); }
          }
        }
        btn.style.outline = '2px solid #16a34a';
        setTimeout(() => { btn.style.outline = ''; drawKaiinRows(treatment, rows, container); }, 300);
      });
    }
  });

  // 来院日/名前/相談 → bk-extra に永続化 + Supabase booking_status にも同期
  // ※DBカラムが無い環境では保存失敗するが、localStorage側は維持される(オフライン保持用)
  const saveBkExtraField = (name, applyDate, field, value) => {
    try {
      const bkEx = loadData('bk-extra', {});
      const key = name + '|' + applyDate;
      if (!bkEx[key]) bkEx[key] = {};
      bkEx[key][field] = value;
      saveData('bk-extra', bkEx);
      // メモリ側も更新 (厳密一致: name と applyDate の完全一致のみ。同名別人への誤同期防止)
      (bookingsData || []).forEach(b => {
        if (b.name === name && b.applyDate === applyDate) {
          if (field === 'editedBookDate') b.bookDate = value;
          if (field === 'editedName') b.name = value;
          if (field === 'editedService') b.service = value;
        }
      });
      // Supabase booking_status にも upsert (saveBFLifecycleField と同じ形式)
      const dbFieldMap = { editedBookDate: 'edited_book_date', editedName: 'edited_name', editedService: 'edited_service' };
      const dbField = dbFieldMap[field];
      if (dbField) {
        const payload = { name, apply_date: applyDate };
        payload[dbField] = value;
        (async () => {
          try {
            const res = await safeSave({ type:'upsert', table:'booking_status', payload, options: { onConflict:'name,apply_date' } });
            if (res && res.ok === false) console.warn('bk-extra supabase sync failed (column missing?)', field);
          } catch(e) { console.warn('bk-extra supabase sync exception', e); }
        })();
      }
      return true;
    } catch(e) { console.warn('bk-extra save error', e); return false; }
  };
  // 来院日: カレンダー (button + hidden date picker)
  container.querySelectorAll('.kaiin-bookdate-mmdd').forEach(btn => {
    const hidden = btn.parentElement?.querySelector('.kaiin-bookdate-hidden');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!hidden) return;
      if (typeof hidden.showPicker === 'function') {
        try { hidden.showPicker(); return; } catch(_) {}
      }
      hidden.focus();
      hidden.click();
    });
    if (hidden) {
      hidden.addEventListener('change', () => {
        const iso = hidden.value || '';
        btn.dataset.iso = iso;
        btn.textContent = iso ? iso.substring(5).replace('-','/') : '年/月/日';
        const ok = saveBkExtraField(btn.dataset.name, btn.dataset.apply, 'editedBookDate', iso);
        if (ok) {
          btn.style.outline = '2px solid #16a34a';
          setTimeout(() => { btn.style.outline = ''; }, 1000);
        }
      });
    }
  });
  // 名前
  container.querySelectorAll('.kaiin-name').forEach(inp => {
    const originalName = inp.dataset.name;
    inp.addEventListener('change', () => {
      const newName = inp.value.trim();
      if (!newName || newName === originalName) return;
      const ok = saveBkExtraField(originalName, inp.dataset.apply, 'editedName', newName);
      if (ok) {
        inp.style.background = '#dcfce7';
        setTimeout(() => { inp.style.background = 'transparent'; }, 1000);
      }
    });
  });
  // 相談種別
  container.querySelectorAll('.kaiin-consult-sel').forEach(sel => {
    sel.addEventListener('change', () => {
      const ok = saveBkExtraField(sel.dataset.name, sel.dataset.apply, 'editedService', sel.value);
      if (ok) { sel.style.borderColor = '#0a0'; setTimeout(() => { sel.style.borderColor = ''; }, 1000); }
    });
  });

  // CS医院 (複数選択モーダル再利用)
  container.querySelectorAll('.kaiin-csfac-btn').forEach(btn => {
    btn.addEventListener('click', () => openBFCsFacModal(btn.dataset.name, btn.dataset.apply, rows));
  });

  // セット医院の保存
  container.querySelectorAll('.kaiin-setfac-sel').forEach(sel => {
    sel.addEventListener('change', async () => {
      const ok = await saveBFLifecycleField(sel.dataset.name, sel.dataset.apply, 'bf_set_facility', sel.value || null);
      if (ok) {
        sel.style.borderColor = '#0a0';
        setTimeout(() => { sel.style.borderColor = ''; }, 1000);
      }
    });
  });

  // 売上/交通費の保存
  container.querySelectorAll('.kaiin-money').forEach(inp => {
    inp.addEventListener('focus', () => { inp.value = inp.value.replace(/,/g,''); });
    inp.addEventListener('blur', () => { const n = Number(inp.value.replace(/,/g,'')); inp.value = n ? n.toLocaleString() : ''; });
    inp.addEventListener('change', async () => {
      const n = Number(inp.value.replace(/,/g,'')) || 0;
      const ok = await saveBFLifecycleField(inp.dataset.name, inp.dataset.apply, inp.dataset.field, n);
      if (ok) {
        inp.style.borderColor = '#0a0';
        setTimeout(() => { inp.style.borderColor = ''; }, 1000);
      }
    });
    inp.addEventListener('click', e => e.stopPropagation());
  });

  // ステータス変更: 統一してsaveBFLifecycleField経由で保存 (bf_statusを再利用)
  container.querySelectorAll('.kaiin-status-sel').forEach(sel => {
    sel.addEventListener('change', async () => {
      const name = sel.dataset.name;
      const apply = sel.dataset.apply;
      const newVal = sel.value || null;
      // インプラント: 予約タブと統合 → booking_status.status に保存 + bookingsData 更新
      if (treatment === 'インプラント') {
        try {
          const payload = { name, apply_date: apply, status: newVal || '' };
          const res = await safeSave({ type:'upsert', table:'booking_status', payload, options: { onConflict:'name,apply_date' } });
          if (res && res.ok === false) throw new Error(res.error || 'save failed');
          // ローカルの bookingsData も更新して 予約タブとの整合性を保つ
          const match = bookingsData.find(b => b.name === name && b.applyDate === apply);
          if (match) match.status = newVal || '';
          // bk-extra にも反映 (予約タブの編集履歴と同じ仕組み)
          try {
            const bkEx = loadData('bk-extra', {});
            const key = name + '|' + apply;
            if (!bkEx[key]) bkEx[key] = {};
            bkEx[key].editedStatus = newVal || '';
            saveData('bk-extra', bkEx);
          } catch(_){}
          sel.style.borderColor = '#0a0'; setTimeout(() => { sel.style.borderColor = ''; }, 1000);
          drawKaiinRows(treatment, rows, container);
        } catch (e) {
          showToast('保存エラー: ' + (e?.message || e), true);
        }
        return;
      }
      // 非インプラント: 従来通り bf_status に保存
      const ok = await saveBFLifecycleField(name, apply, 'bf_status', newVal);
      if (!ok) return;
      // 「予約変更」かつ次回予定(未来)が入っていれば、予約日を次回予定に置き換え → 予約管理のみで表示
      if (newVal === '予約変更') {
        const info = bfLifecycleCache[name + '|' + apply] || {};
        const nextIso = info.bf_next_date;
        if (nextIso) {
          const nd = parseDate(nextIso.replace(/-/g, '/'));
          const today = new Date(); today.setHours(0,0,0,0);
          if (nd && nd > today) {
            // 予約日を次回予定に更新
            try {
              await safeSave({
                type: 'upsert',
                table: 'booking_status',
                payload: { name, apply_date: apply, book_date: nextIso, status: '予約変更' },
                options: { onConflict: 'name,apply_date' }
              });
              // ローカル bookingsData も更新
              const match = bookingsData.find(b => b.name === name && b.applyDate === apply);
              if (match) { match.bookDate = nextIso.replace(/-/g, '/'); match.status = '予約変更'; }
              // bk-extra にも反映
              try {
                const bkEx = loadData('bk-extra', {});
                const key = name + '|' + apply;
                if (!bkEx[key]) bkEx[key] = {};
                bkEx[key].editedStatus = '予約変更';
                bkEx[key].editedBookDate = nextIso.replace(/-/g, '/');
                saveData('bk-extra', bkEx);
              } catch(_){}
              showToast('予約日を ' + (nextIso.substring(5).replace('-','/')) + ' に移動しました (予約管理で確認)');
            } catch (e) { console.warn('予約日更新失敗', e); }
          }
        } else {
          showToast('※ 次回予定日を入力すると予約管理に自動移動します');
        }
      }
      sel.style.borderColor = '#0a0'; setTimeout(() => { sel.style.borderColor = ''; }, 1000);
      drawKaiinRows(treatment, rows, container);
    });
  });
  // メモセル → 予約一覧のメモモーダルを再利用
  container.querySelectorAll('.kaiin-memo-cell').forEach(td => {
    td.addEventListener('click', () => openMemoModal(td.dataset.name, td.dataset.apply, td));
  });
  // プロモ入力 (手動のみ)
  container.querySelectorAll('.kaiin-promo-input').forEach(inp => {
    inp.addEventListener('change', async () => {
      const name = inp.dataset.name; const apply = inp.dataset.apply;
      const v = inp.value.trim();
      // manual_bookings を更新
      try {
        await sb.from('manual_bookings').update({ source: v || null }).eq('name', name).eq('apply_date', apply);
        // bookingsDataにも反映
        const d = bookingsData.find(b => b.name === name && b.applyDate === apply);
        if (d) d.source = v;
        inp.style.borderColor = '#0a0';
        setTimeout(() => { inp.style.borderColor = ''; }, 1000);
        showToast('プロモを保存しました');
      } catch(e) { showToast('保存エラー: ' + e.message, true); }
    });
    inp.addEventListener('click', e => e.stopPropagation());
  });
}

// CS医院(複数可): JSON array文字列 or 単一文字列 を配列に
function parseCsFac(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('[')) { try { return JSON.parse(s); } catch(_) {} }
    return s ? [s] : [];
  }
  return [];
}
function stringifyCsFac(arr) {
  if (!arr || !arr.length) return '';
  return JSON.stringify(arr);
}

function drawBFLifecycleTable(bfRows) {
  const fstSel = document.getElementById('bf-lc-filter-status')?.value || '';
  const ffac = document.getElementById('bf-lc-filter-fac')?.value || '';
  const fdr = document.getElementById('bf-lc-filter-dr')?.value || '';
  const fnext = document.getElementById('bf-lc-filter-next')?.value || '';
  const fs = (document.getElementById('bf-lc-search')?.value || '').trim().toLowerCase();
  const FACS = ['','BF銀座','エスカ','アール','ウィズ','ルミナス','茶屋','知立','小牧','八事','大森','京都','岩田','アサノ'];

  let filtered = bfRows.slice();
  if (fstSel) {
    if (fstSel === '__none') filtered = filtered.filter(d => !bfLifecycleCache[d.name+'|'+d.applyDate]?.bf_status);
    else filtered = filtered.filter(d => bfLifecycleCache[d.name+'|'+d.applyDate]?.bf_status === fstSel);
  }
  if (ffac) filtered = filtered.filter(d => parseCsFac(bfLifecycleCache[d.name+'|'+d.applyDate]?.bf_cs_facility).includes(ffac));
  if (fdr) filtered = filtered.filter(d => bfLifecycleCache[d.name+'|'+d.applyDate]?.bf_cs_doctor === fdr);
  const fsetfac = document.getElementById('bf-lc-filter-setfac')?.value || '';
  if (fsetfac) filtered = filtered.filter(d => bfLifecycleCache[d.name+'|'+d.applyDate]?.bf_set_facility === fsetfac);
  if (fnext === 'fixed') filtered = filtered.filter(d => bfLifecycleCache[d.name+'|'+d.applyDate]?.bf_next_date);
  if (fnext === 'none') filtered = filtered.filter(d => !bfLifecycleCache[d.name+'|'+d.applyDate]?.bf_next_date);
  if (fs) filtered = filtered.filter(d => (d.name||'').toLowerCase().includes(fs));

  filtered.sort((a,b) => (b.applyDate||'').localeCompare(a.applyDate||''));

  document.getElementById('bf-lc-count').textContent = filtered.length + '件';

  const today = new Date(); today.setHours(0,0,0,0);
  // CS医院自動反映: bf_cs_facilityが未設定なら来院医院を自動セット
  const autoFacPromises = [];
  filtered.forEach(d => {
    const key = d.name + '|' + d.applyDate;
    const info = bfLifecycleCache[key] || {};
    if (!info.bf_cs_facility && d.facility) {
      const fac = normFac(d.facility);
      if (fac && fac !== '-') {
        autoFacPromises.push(
          safeSave({ type:'upsert', table:'booking_status', payload: { name: d.name, apply_date: d.applyDate, bf_cs_facility: fac }, options: { onConflict:'name,apply_date' } })
        );
        if (!bfLifecycleCache[key]) bfLifecycleCache[key] = { name: d.name, apply_date: d.applyDate };
        bfLifecycleCache[key].bf_cs_facility = fac;
      }
    }
  });
  // 非同期で保存（待たない）
  if (autoFacPromises.length) Promise.all(autoFacPromises).catch(e => console.warn('auto CS fac save', e));

  const rowsHtml = filtered.map(d => {
    const key = d.name + '|' + d.applyDate;
    const info = bfLifecycleCache[key] || {};
    const st = info.bf_status || '';
    const stColor = BF_STATUSES.find(s => s.value === st)?.color || '#ccc';
    const bookDate = parseDate(d.bookDate);
    const daysSince = bookDate ? Math.floor((today - bookDate) / 86400000) : '-';
    const histCount = (bfHistoryCache[key] || []).length;
    const csFac = info.bf_cs_facility || normFac(d.facility) || '';
    const stStyle = st
      ? `background:${stColor}22;color:${stColor};border:1px solid ${stColor};font-weight:700`
      : `background:#fff;color:#111;border:1px solid var(--border);font-weight:500`;
    return `<tr>
      <td style="white-space:nowrap;font-size:10px">${(fmtBookDate(d.bookDate)||'').replace(/\s+\d{1,2}:\d{2}.*$/,'')}</td>
      <td class="bf-lc-name-cell" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" style="font-weight:500;text-align:left;cursor:pointer;text-decoration:underline dotted;text-decoration-color:#ccc" title="クリックで編集">${maskName(d.name)}</td>
      <td><button type="button" class="bf-lc-csfac-btn" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-value="${esc(info.bf_cs_facility||csFac||'')}" style="font-size:10px;padding:3px 6px;width:100%;text-align:left;background:#fff;border:1px solid var(--border);border-radius:4px;cursor:pointer;min-height:24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${parseCsFac(info.bf_cs_facility||csFac||'').join(', ') || '<span style="color:var(--text-muted)">未選択</span>'}</button></td>
      <td><select class="bf-lc-csdr-select" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" style="font-size:10px;padding:2px 4px;width:100%;background:#fff;border:1px solid var(--border);border-radius:4px">
        <option value="">未選択</option>
        ${getCSDRList().map(dr => `<option ${info.bf_cs_doctor===dr?'selected':''}>${dr}</option>`).join('')}
        ${info.bf_cs_doctor && !getCSDRList().includes(info.bf_cs_doctor) ? `<option selected>${info.bf_cs_doctor}</option>` : ''}
        <option value="__ADD__" style="color:#0a0;font-weight:700">＋ 新規Dr追加</option>
      </select></td>
      <td><select class="bf-lc-field" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="bf_status" style="font-size:10px;padding:2px 4px;border-radius:4px;width:100%;${stStyle}">
        <option value="">未設定</option>
        ${BF_STATUSES.map(s => `<option style="color:#111;background:#fff" ${st===s.value?'selected':''}>${s.value}</option>`).join('')}
      </select></td>
      <td><select class="bf-lc-field" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="bf_set_facility" style="font-size:10px;padding:2px 4px;width:100%">${BF_SET_FACS.map(f => `<option ${(info.bf_set_facility||'')===f?'selected':''}>${f}</option>`).join('')}</select></td>
      <td><input type="text" inputmode="numeric" class="bf-lc-money" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="contract_amount" value="${d.contractAmount?Number(d.contractAmount).toLocaleString():(info.contract_amount?Number(info.contract_amount).toLocaleString():'')}" placeholder="0" style="font-size:10px;padding:2px 6px;width:100%;text-align:right;border:1px solid var(--border);border-radius:4px;font-variant-numeric:tabular-nums"></td>
      <td><input type="text" inputmode="numeric" class="bf-lc-money" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="bf_travel_cost" value="${info.bf_travel_cost?Number(info.bf_travel_cost).toLocaleString():''}" placeholder="0" style="font-size:10px;padding:2px 6px;width:100%;text-align:right;border:1px solid var(--border);border-radius:4px;font-variant-numeric:tabular-nums"></td>
      <td class="bf-lc-memo-cell" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" style="cursor:pointer;padding:4px 8px;min-height:26px;background:${(info.bf_memo||d._memo)?'#fff8e1':'transparent'};border:1px dashed ${(info.bf_memo||d._memo)?'#f9a825':'var(--border)'};border-radius:4px;font-size:11px;line-height:1.5;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(info.bf_memo||d._memo||'')}">${(info.bf_memo||d._memo) ? esc(_flattenMemoForDisplay(info.bf_memo||d._memo, 70)) : '<span style="color:var(--text-muted)">+ メモ</span>'}</td>
      <td><input type="date" class="bf-lc-field" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" data-field="bf_next_date" value="${info.bf_next_date||''}" style="font-size:9px;padding:1px 2px;width:100%;box-sizing:border-box;border-radius:3px;${info.bf_next_date?'background:#dcfce7;border:1px solid #16a34a;color:#15803d;font-weight:600':'background:#fef3c7;border:1px solid #f59e0b;color:#92400e'}"></td>
      <td style="font-size:10px;color:${daysSince>14?'#c00':'#666'};text-align:center;white-space:nowrap">${daysSince !== '-' ? daysSince+'日' : '-'}</td>
      <td><button class="bf-lc-hist-btn" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" style="font-size:10px;padding:2px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;cursor:pointer;white-space:nowrap">📜${histCount}</button>
        <button class="bf-lc-del-btn" data-name="${esc(d.name)}" data-apply="${esc(d.applyDate)}" title="この行を削除 (重複時)" style="font-size:10px;padding:2px 5px;margin-left:2px;background:#fff;border:1px solid #fecaca;color:#c00;border-radius:4px;cursor:pointer">🗑</button>
      </td>
    </tr>`;
  }).join('');

  const tbody = document.getElementById('bf-lc-tbody');
  tbody.innerHTML = rowsHtml || '<tr><td colspan="10" style="color:var(--text-muted);text-align:center;padding:20px">データなし</td></tr>';

  // 各フィールドイベント
  tbody.querySelectorAll('.bf-lc-field').forEach(el => {
    el.addEventListener('change', async () => {
      const ok = await saveBFLifecycleField(el.dataset.name, el.dataset.apply, el.dataset.field, el.value || null);
      if (ok) {
        el.style.borderColor = '#0a0';
        setTimeout(() => { el.style.borderColor = ''; }, 1000);
        // ステータス変更時: フィルターは保持してファネルと一覧だけ更新
        if (el.dataset.field === 'bf_status') updateBFFunnelAndTable(bfRows);
      }
    });
  });
  // 次回予定日変更時に即再描画（色更新）
  tbody.querySelectorAll('input[data-field="bf_next_date"]').forEach(inp => {
    inp.addEventListener('change', () => { setTimeout(() => drawBFLifecycleTable(bfRows), 200); });
  });
  // 履歴モーダル
  tbody.querySelectorAll('.bf-lc-hist-btn').forEach(btn => {
    btn.addEventListener('click', () => openBFHistoryModal(btn.dataset.name, btn.dataset.apply));
  });
  // 行削除 (重複削除用)
  tbody.querySelectorAll('.bf-lc-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const n = btn.dataset.name, a = btn.dataset.apply;
      if (!confirm(`${n} (${a}) を削除しますか？\n※同名患者で重複している場合、この行だけ削除されます。情報のある方は残ります。`)) return;
      await deleteBFRow(n, a);
    });
  });
  // メモモーダル
  tbody.querySelectorAll('.bf-lc-memo-cell').forEach(td => {
    td.addEventListener('click', () => openBFMemoModal(td.dataset.name, td.dataset.apply, bfRows));
  });
  // 名前クリックで編集 (予約一覧と同期)
  tbody.querySelectorAll('.bf-lc-name-cell').forEach(td => {
    td.addEventListener('click', () => {
      const oldName = td.dataset.name;
      const apply = td.dataset.apply;
      const newName = prompt('患者名を編集:', oldName);
      if (!newName || newName === oldName) return;
      editPatientName(oldName, apply, newName.trim(), bfRows);
    });
  });
  // CS医院複数選択
  tbody.querySelectorAll('.bf-lc-csfac-btn').forEach(btn => {
    btn.addEventListener('click', () => openBFCsFacModal(btn.dataset.name, btn.dataset.apply, bfRows));
  });
  // CSDR インラインセレクト
  tbody.querySelectorAll('.bf-lc-csdr-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      if (sel.value === '__ADD__') {
        const name = prompt('新しいDr名を入力してください:');
        if (name && name.trim()) {
          addCSDR(name.trim());
          showToast(`Dr「${name.trim()}」を追加しました`);
          // 追加直後にそのDrを自動選択
          const ok = await saveBFLifecycleField(sel.dataset.name, sel.dataset.apply, 'bf_cs_doctor', name.trim());
          if (ok) updateBFFunnelAndTable(bfRows);
        } else {
          // キャンセル時は元に戻す
          const cur = bfLifecycleCache[sel.dataset.name + '|' + sel.dataset.apply]?.bf_cs_doctor || '';
          sel.value = cur;
        }
        return;
      }
      const ok = await saveBFLifecycleField(sel.dataset.name, sel.dataset.apply, 'bf_cs_doctor', sel.value || null);
      if (ok) {
        sel.style.borderColor = '#0a0';
        setTimeout(() => { sel.style.borderColor = ''; }, 1000);
      }
    });
  });
  // 売上/交通費の金額系
  tbody.querySelectorAll('.bf-lc-money').forEach(inp => {
    inp.addEventListener('focus', () => { inp.value = inp.value.replace(/,/g,''); });
    inp.addEventListener('blur', () => { const n = Number(inp.value.replace(/,/g,'')); inp.value = n ? n.toLocaleString() : ''; });
    inp.addEventListener('change', async () => {
      const n = Number(inp.value.replace(/,/g,'')) || 0;
      const field = inp.dataset.field;
      const ok = await saveBFLifecycleField(inp.dataset.name, inp.dataset.apply, field, n);
      if (ok) {
        inp.style.borderColor = '#0a0';
        setTimeout(() => { inp.style.borderColor = ''; }, 1000);
        // 売上 → プロモ率でインセ自動計算も
        if (field === 'contract_amount') {
          const d = bookingsData.find(x => x.name === inp.dataset.name && x.applyDate === inp.dataset.apply);
          if (d) {
            d.contractAmount = n;
            const inc = calcIncentive(d.source, n);
            if (inc) {
              d.incentiveAmount = inc;
              (async () => {
                const res = await safeSave({ type:'upsert', table:'booking_status', payload: { name: d.name, apply_date: d.applyDate, incentive_amount: inc }, options: { onConflict:'name,apply_date' } });
                if (res && res.ok === false) showToast('⚠ インセ保存に失敗。再送信します', true);
              })();
            }
          }
        }
      }
    });
  });
}

function openBFCsdrModal(name, applyDate, bfRows) {
  const key = name + '|' + applyDate;
  const info = bfLifecycleCache[key] || {};
  const current = info.bf_cs_doctor || '';
  document.getElementById('bf-lc-csdr-title').textContent = `CSDR を選択 — ${name}`;
  const list = getCSDRList();
  const redraw = () => {
    document.getElementById('bf-lc-csdr-list').innerHTML = getCSDRList().map(dr => `
      <button class="bf-lc-csdr-opt" data-val="${dr.replace(/"/g,'&quot;')}" style="padding:8px 12px;text-align:left;background:${current===dr?'#dcfce7':'#fff'};border:1px solid ${current===dr?'#16a34a':'var(--border)'};border-radius:4px;cursor:pointer;font-size:13px;color:#111">${dr}${current===dr?' ✓':''}</button>
    `).join('') + `<button class="bf-lc-csdr-opt" data-val="" style="padding:8px 12px;text-align:left;background:#fff;border:1px dashed var(--border);border-radius:4px;cursor:pointer;font-size:13px;color:var(--text-muted)">(クリア)</button>`;
    document.getElementById('bf-lc-csdr-list').querySelectorAll('.bf-lc-csdr-opt').forEach(b => {
      b.addEventListener('click', async () => {
        const v = b.dataset.val || null;
        const ok = await saveBFLifecycleField(name, applyDate, 'bf_cs_doctor', v);
        if (ok) {
          document.getElementById('bf-lc-csdr-modal').hidden = true;
          if (bfRows) drawBFLifecycleTable(bfRows);
        }
      });
    });
  };
  redraw();
  document.getElementById('bf-lc-csdr-new').value = '';
  document.getElementById('bf-lc-csdr-modal').hidden = false;
  const addBtn = document.getElementById('bf-lc-csdr-add');
  const newBtn = addBtn.cloneNode(true);
  addBtn.parentNode.replaceChild(newBtn, addBtn);
  newBtn.addEventListener('click', () => {
    const v = document.getElementById('bf-lc-csdr-new').value.trim();
    if (!v) return;
    addCSDR(v);
    document.getElementById('bf-lc-csdr-new').value = '';
    showToast(`Dr「${v}」を追加しました`);
    redraw();
  });
  const newInp = document.getElementById('bf-lc-csdr-new');
  newInp.onkeydown = (e) => { if (e.key === 'Enter') newBtn.click(); };
}

function openBFCsFacModal(name, applyDate, bfRows) {
  const key = name + '|' + applyDate;
  const info = bfLifecycleCache[key] || {};
  const current = parseCsFac(info.bf_cs_facility);
  document.getElementById('bf-lc-csfac-title').textContent = `CS医院を選択 (複数可) — ${name}`;
  const opts = ['BF銀座','エスカ','アール','ウィズ','ルミナス','茶屋','知立','小牧','八事','大森','京都','岩田','アサノ'];
  document.getElementById('bf-lc-csfac-options').innerHTML = opts.map(f => `
    <label style="display:flex;align-items:center;gap:6px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:12px;background:${current.includes(f)?'#dcfce7':'#fff'}">
      <input type="checkbox" value="${f}" ${current.includes(f)?'checked':''} style="cursor:pointer">
      <span>${f}</span>
    </label>
  `).join('');
  document.getElementById('bf-lc-csfac-modal').hidden = false;
  const saveBtn = document.getElementById('bf-lc-csfac-save');
  const newBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newBtn, saveBtn);
  newBtn.addEventListener('click', async () => {
    const selected = [...document.getElementById('bf-lc-csfac-options').querySelectorAll('input:checked')].map(i => i.value);
    const ok = await saveBFLifecycleField(name, applyDate, 'bf_cs_facility', stringifyCsFac(selected));
    if (ok) {
      document.getElementById('bf-lc-csfac-modal').hidden = true;
      if (bfRows) drawBFLifecycleTable(bfRows);
    }
  });
}

function openBFMemoModal(name, applyDate, bfRows) {
  const key = name + '|' + applyDate;
  const info = bfLifecycleCache[key] || {};
  document.getElementById('bf-lc-memo-title').textContent = '📝 ' + name + ' のメモ';
  const st = info.bf_status || '未設定';
  document.getElementById('bf-lc-memo-sub').textContent = `BFステータス: ${st}${st==='検討中'?' — 後追い状況を記録してください':''}`;
  // 予約一覧メモと連動
  const bk = (bookingsData || []).find(b => b.name === name && b.applyDate === applyDate);
  document.getElementById('bf-lc-memo-text').value = info.bf_memo || (bk && bk._memo) || '';
  document.getElementById('bf-lc-memo-status').textContent = '';
  document.getElementById('bf-lc-memo-modal').hidden = false;
  const saveBtn = document.getElementById('bf-lc-memo-save');
  // 既存ハンドラを消して新しくバインド
  const newBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newBtn, saveBtn);
  newBtn.addEventListener('click', async () => {
    const v = document.getElementById('bf-lc-memo-text').value;
    const ok = await saveBFLifecycleField(name, applyDate, 'bf_memo', v || null);
    if (ok) {
      document.getElementById('bf-lc-memo-status').innerHTML = '<span style="color:#0a0">✓ 保存しました</span>';
      setTimeout(() => {
        document.getElementById('bf-lc-memo-modal').hidden = true;
        if (bfRows) drawBFLifecycleTable(bfRows);
      }, 600);
    }
  });
  setTimeout(() => document.getElementById('bf-lc-memo-text').focus(), 100);
}

function openBFHistoryModal(name, applyDate) {
  const key = name + '|' + applyDate;
  const history = bfHistoryCache[key] || [];
  document.getElementById('bf-lc-history-title').textContent = `📜 ${name} の履歴`;
  const body = document.getElementById('bf-lc-history-body');
  if (!history.length) {
    body.innerHTML = '<p style="color:var(--text-muted);font-size:13px">履歴なし</p>';
  } else {
    body.innerHTML = history.map(h => `
      <div style="padding:10px;margin-bottom:8px;background:var(--bg);border-left:3px solid #6366f1;border-radius:4px;position:relative">
        ${h.id ? `<button class="bf-hist-del" data-id="${h.id}" data-name="${esc(name)}" data-apply="${esc(applyDate)}" style="position:absolute;top:6px;right:6px;width:22px;height:22px;border:1px solid #fecaca;background:#fff;color:#c00;border-radius:4px;cursor:pointer;font-size:12px;line-height:1;font-weight:700" title="この履歴を削除" aria-label="この履歴を削除">×</button>` : ''}
        <div style="font-size:11px;color:var(--text-sub);margin-bottom:4px">${esc((h.created_at||'').substring(0,16).replace('T',' '))} — <b>${esc(h.changed_by||'-')}</b></div>
        <div style="font-size:13px;font-weight:600">${esc(h.from_status||'(なし)')} → ${esc(h.to_status||'(なし)')}</div>
        <div style="font-size:11px;color:var(--text-sub);margin-top:4px">
          ${h.next_date ? '次回: ' + esc(h.next_date) + (h.next_fixed?' 🟢確定':' 🟡未定') + ' / ' : ''}
          ${h.cs_facility ? 'CS: ' + esc(h.cs_facility) + (h.cs_doctor ? '/' + esc(h.cs_doctor) : '') : ''}
        </div>
        ${h.memo ? `<div style="font-size:11px;margin-top:4px;padding:6px;background:#fff;border-radius:3px">${esc(h.memo)}</div>` : ''}
      </div>
    `).join('');
    // 削除ボタン
    body.querySelectorAll('.bf-hist-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('この履歴を削除しますか？')) return;
        const id = Number(btn.dataset.id);
        const { error } = await sb.from('bf_history').delete().eq('id', id);
        if (error) { showToast('削除エラー: ' + error.message, true); return; }
        // キャッシュ更新
        const nm = btn.dataset.name, ap = btn.dataset.apply;
        const k = nm + '|' + ap;
        if (bfHistoryCache[k]) bfHistoryCache[k] = bfHistoryCache[k].filter(x => x.id !== id);
        showToast('削除しました');
        openBFHistoryModal(nm, ap); // 再描画
      });
    });
  }
  document.getElementById('bf-lc-history-modal').hidden = false;
}

function renderBFBookings(allBFData) {
  let data = allBFData || [];
  const isAdmin = canEditContent();

  // フィルター
  const search = (document.getElementById('bf-bk-search')?.value || '').trim().toLowerCase();
  const facF = document.getElementById('bf-bk-facility')?.value || '';
  const statusF = document.getElementById('bf-bk-status')?.value || '';
  if (search) data = data.filter(d => d.name && d.name.toLowerCase().includes(search));
  if (facF) data = data.filter(d => normFac(d.facility) === facF);

  // 期間フィルター
  const periodF = document.getElementById('bf-bk-period')?.value || '';
  const monthF = document.getElementById('bf-bk-month')?.value || '';
  const getDateStr = (d) => { const m = (d.applyDate||'').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); return m ? `${m[1]}-${String(parseInt(m[2])).padStart(2,'0')}-${String(parseInt(m[3])).padStart(2,'0')}` : ''; };
  if (periodF === 'today') {
    const t = new Date(); const ts = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
    data = data.filter(d => getDateStr(d) === ts);
  } else if (periodF === 'thisMonth') {
    const t = new Date(); const ms = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}`;
    data = data.filter(d => getDateStr(d).slice(0,7) === ms);
  } else if (periodF === 'lastMonth') {
    const t = new Date(); t.setMonth(t.getMonth()-1); const ms = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}`;
    data = data.filter(d => getDateStr(d).slice(0,7) === ms);
  }
  if (monthF) { data = data.filter(d => getDateStr(d).slice(0,7) === monthF); }
  if (statusF === '要対応') {
    const td = new Date(); td.setHours(0,0,0,0);
    data = data.filter(d => (!d.status||d.status==='未対応') && d.bookDate && (() => { const m=(d.bookDate||'').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); return m && new Date(parseInt(m[1]),parseInt(m[2])-1,parseInt(m[3])) < td; })());
  } else if (statusF) {
    if (statusF === '未対応') data = data.filter(d => !d.status || d.status === '未対応');
    else data = data.filter(d => d.status === statusF);
  }

  // 統計
  const active = data.filter(d => d.status !== '除外');
  const total = active.length;
  const cancelled = active.filter(d => d.status === 'キャンセル').length;
  const visited = active.filter(d => isVisitedStatus(d.status)).length;
  const contracted = active.filter(d => d.status === '成約').length;
  const todayR = new Date(); todayR.setHours(0,0,0,0);
  const past = active.filter(d => { const m=(d.bookDate||'').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); return m && new Date(parseInt(m[1]),parseInt(m[2])-1,parseInt(m[3])) < todayR; });
  const pastV = past.filter(d => isVisitedStatus(d.status)).length;
  const visitRate = past.length > 0 ? Math.round(pastV/past.length*100) : 0;
  const overdue = active.filter(d => (!d.status||d.status==='未対応') && d.bookDate && (() => { const m=(d.bookDate||'').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); return m && new Date(parseInt(m[1]),parseInt(m[2])-1,parseInt(m[3])) < todayR; })()).length;

  document.getElementById('bf-bk-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">BF予約</span><span class="stat-num">${total}</span></div>
    ${overdue > 0 ? `<div class="stat-card" style="border-color:var(--red)"><span class="stat-label" style="color:var(--red)">要対応</span><span class="stat-num" style="color:var(--red)">${overdue}</span></div>` : ''}
    <div class="stat-card"><span class="stat-label">キャンセル</span><span class="stat-num" style="color:var(--red)">${cancelled}</span></div>
    <div class="stat-card"><span class="stat-label">来院済</span><span class="stat-num">${visited}</span></div>
    <div class="stat-card"><span class="stat-label">来院率</span><span class="stat-num">${visitRate}%</span></div>
    <div class="stat-card"><span class="stat-label">成約</span><span class="stat-num" style="color:var(--green)">${contracted}</span></div>
  `;

  // 医院フィルター選択肢
  const facs = [...new Set(allBFData.map(d => normFac(d.facility)).filter(f => f && f !== '-'))].sort();
  const facEl = document.getElementById('bf-bk-facility');
  if (facEl) { const cur = facEl.value; facEl.innerHTML = '<option value="">医院:全て</option>' + facs.map(f => `<option ${f===cur?'selected':''}>${f}</option>`).join(''); }

  document.getElementById('bf-count').textContent = data.length + '件';
  const memos = loadData('bk-memos', {});
  const bkExtra = loadData('bk-extra', {});
  const sorted = [...data].sort((a,b) => (b.applyDate||'').localeCompare(a.applyDate||''));
  const tbody = document.getElementById('bf-tbody');

  tbody.innerHTML = sorted.slice(0, 200).map((d, idx) => {
    const key = d.name+'|'+d.applyDate;
    const extra = bkExtra[key] || {};
    const memo = d._memo || memos[key] || '';
    const rowStyle = d.status==='除外'?'background:#f5f5f5;opacity:0.5;text-decoration:line-through':d.status==='成約'?'background:#f0fdf4':d.status==='来院済'?'background:#eff6ff':d.status==='キャンセル'?'background:#fef2f2':'';
    return `<tr style="${rowStyle}">
    <td style="font-size:9px"><span class="badge ${d.tool==='セレクト'?'badge-warning':'badge-default'}" style="font-size:8px;padding:1px 4px">${d.tool==='セレクト'?'セレクト':'DX'}</span></td>
    <td style="font-size:10px;color:var(--text-sub)">${fmtApplyDate(d.applyDate)}</td>
    <td style="font-size:10px">${fmtBookDate(d.bookDate)}</td>
    <td style="font-size:11px;font-weight:500;text-align:left;${isAdmin?'cursor:pointer;text-decoration:underline dotted':''}" ${isAdmin?`class="bf-bk-row-edit" data-name="${d.name}" data-apply="${d.applyDate}" title="クリックで編集"`:''}>
      ${maskName(d.name)}</td>
    <td style="font-size:10px">${normFac(d.facility)}</td>
    <td style="font-size:10px">${maskPhone(d.phone)||'-'}</td>
    <td style="font-size:10px;text-align:left;max-width:90px;overflow:hidden;text-overflow:ellipsis">${maskEmail(d.email)||'-'}</td>
    <td style="font-size:9px;color:var(--text-muted);max-width:70px;overflow:hidden;text-overflow:ellipsis">${d.source||'-'}</td>
    <td style="text-align:center">${isAdmin ? `<select class="form-select bf-bk-status-sel" data-name="${d.name}" data-apply="${d.applyDate}" style="font-size:10px;padding:2px 4px;min-width:70px;text-align:center;${d.status==='来院済'?'background:#dbeafe;color:#1d4ed8':d.status==='成約'?'background:#dcfce7;color:#15803d':d.status==='キャンセル'?'background:#fee2e2;color:#b91c1c':d.status==='確認済'?'background:#f3e8ff;color:#7c3aed':d.status==='除外'?'background:#f5f5f5;color:#9ca3af':''}"><option ${(!d.status||d.status==='未対応')?'selected':''}>未対応</option><option ${d.status==='確認済'?'selected':''}>確認済</option><option ${d.status==='来院済'?'selected':''}>来院済</option><option ${d.status==='成約'?'selected':''}>成約</option><option ${d.status==='キャンセル'?'selected':''}>キャンセル</option><option ${d.status==='除外'?'selected':''}>除外</option></select>` : (d.status||'未対応')}</td>
    <td style="font-size:10px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer" class="bf-bk-memo" data-name="${d.name}" data-apply="${d.applyDate}" title="${(memo||'').replace(/"/g,'&quot;')}">${memo ? esc(_flattenMemoForDisplay(memo, 30)) : '<span style="color:var(--text-muted)">+</span>'}</td>
    <td style="text-align:center;${extra.contractService?'background:#dcfce7;color:#15803d;font-weight:600':''}">${isAdmin ? `<select class="form-select bf-bk-field" data-name="${d.name}" data-apply="${d.applyDate}" data-field="contractService" style="font-size:10px;padding:2px 4px;min-width:60px"><option value="">-</option><option ${(extra.contractService||d.contractService)==='BF'?'selected':''}>BF</option><option ${(extra.contractService||d.contractService)==='矯正(表)'?'selected':''}>矯正(表)</option><option ${(extra.contractService||d.contractService)==='矯正(裏)'?'selected':''}>矯正(裏)</option><option ${(extra.contractService||d.contractService)==='ﾗﾌﾞﾘｴ'?'selected':''}>ﾗﾌﾞﾘｴ</option><option ${(extra.contractService||d.contractService)==='ｲﾝﾌﾟﾗﾝﾄ'?'selected':''}>ｲﾝﾌﾟﾗﾝﾄ</option></select>` : (extra.contractService||d.contractService||'-')}</td>
    <td>${isAdmin ? `<input type="number" class="form-input bf-bk-field" data-name="${d.name}" data-apply="${d.applyDate}" data-field="contractAmount" value="${extra.contractAmount||d.contractAmount||''}" placeholder="0" style="font-size:10px;padding:2px 4px;width:60px;text-align:center">` : '-'}</td>
    <td>${isAdmin ? `<input type="month" class="form-input bf-bk-field" data-name="${d.name}" data-apply="${d.applyDate}" data-field="paymentMonth" value="${extra.paymentMonth||d.paymentMonth||''}" style="font-size:10px;padding:2px 4px;width:100px">` : '-'}</td>
    <td>${isAdmin ? `<input type="month" class="form-input bf-bk-field" data-name="${d.name}" data-apply="${d.applyDate}" data-field="incentiveMonth" value="${extra.incentiveMonth||d.incentiveMonth||''}" style="font-size:10px;padding:2px 4px;width:100px">` : '-'}</td>
    <td>${isAdmin ? `<input type="number" class="form-input bf-bk-field" data-name="${d.name}" data-apply="${d.applyDate}" data-field="incentiveAmount" value="${extra.incentiveAmount||d.incentiveAmount||''}" placeholder="0" style="font-size:10px;padding:2px 4px;width:60px;text-align:center">` : '-'}</td>
  </tr>`}).join('') || '<tr><td colspan="15" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';

  // 名前クリックで行編集
  if (isAdmin) {
    tbody.querySelectorAll('.bf-bk-row-edit').forEach(td => {
      td.addEventListener('click', () => {
        openRowEditModal(td.dataset.name, td.dataset.apply);
        document.getElementById('re-save').addEventListener('click', () => { ensureBFData(); renderBFBookings(_bfAllData); }, { once: true });
      });
    });
  }

  // イベント: ステータス変更
  if (isAdmin) {
    tbody.querySelectorAll('.bf-bk-status-sel').forEach(sel => {
      sel.addEventListener('change', () => {
        const name = sel.dataset.name, apply = sel.dataset.apply, newStatus = sel.value;
        if ((newStatus==='キャンセル'||newStatus==='除外') && !confirm(name+' を「'+newStatus+'」にしますか？')) { const m = bookingsData.find(d=>d.name===name&&d.applyDate===apply); sel.value = m?m.status||'未対応':'未対応'; return; }
        const match = bookingsData.find(d => d.name===name && d.applyDate===apply);
        if (match) match.status = newStatus;
        sel.style.borderColor = 'var(--green)';
        setTimeout(() => sel.style.borderColor = '', 1000);
        (async () => {
          const res = await safeSave({ type:'upsert', table:'booking_status', payload: { name, apply_date: apply, status: newStatus }, options: { onConflict:'name,apply_date' } });
          if (res && res.ok === false) showToast('⚠ ステータス保存に失敗。再送信します', true);
        })();
      });
    });
    // メモ
    tbody.querySelectorAll('.bf-bk-memo').forEach(td => {
      td.addEventListener('click', () => openMemoModal(td.dataset.name, td.dataset.apply, td));
    });
    // 追加フィールド
    const bkExtraLocal = loadData('bk-extra', {});
    const saveExtraBF = (name, apply, field, value) => {
      const key = name+'|'+apply;
      if (!bkExtraLocal[key]) bkExtraLocal[key] = {};
      bkExtraLocal[key][field] = value;
      saveData('bk-extra', bkExtraLocal);
      const dbField = field==='contractService'?'contract_service':field==='contractAmount'?'contract_amount':field==='paymentMonth'?'payment_month':field==='incentiveAmount'?'incentive_amount':'incentive_month';
      const update = { name, apply_date: apply };
      update[dbField] = field==='contractAmount'||field==='incentiveAmount' ? Number(value)||0 : value;
      (async () => {
        const res = await safeSave({ type:'upsert', table:'booking_status', payload: update, options: { onConflict:'name,apply_date' } });
        if (res && res.ok === false) showToast('⚠ 保存に失敗。再送信します', true);
      })();
    };
    tbody.querySelectorAll('.bf-bk-field').forEach(el => {
      el.addEventListener('change', () => {
        saveExtraBF(el.dataset.name, el.dataset.apply, el.dataset.field, el.value);
        el.style.borderColor = 'var(--green)';
        setTimeout(() => el.style.borderColor = '', 1000);
      });
    });
  }
}

// === 申込分析 ===
function renderApplyAnalysis(period) {
  period = period || 'today';
  const sFac = (f) => {
    if (!f) return '-';
    if (f.includes('銀座')) return 'BF銀座'; if (f.includes('ウィズ')||f.includes('WITH')) return 'ウィズ';
    if (f.includes('エスカ')) return 'エスカ'; if (f.includes('アール')) return 'アール';
    if (f.includes('ルミナス')) return 'ルミナス'; if (f.includes('茶屋')) return '茶屋';
    if (f.includes('小牧')) return '小牧'; if (f.includes('知立')) return '知立';
    if (f.includes('八事')) return '八事'; if (f.includes('岩田')) return '岩田';
    if (f.includes('大森')) return '大森'; if (f.includes('京都')) return '京都';
    return f.length > 8 ? f.slice(0,8)+'…' : f;
  };
  const sSvc = (s) => {
    if (!s) return '-';
    if (s.includes('ラミネート')||s.includes('ブラックフィルム')) return 'BF';
    if (s.includes('矯正')) return '矯正'; if (s.includes('セラミック')) return 'セラミック';
    if (s.includes('インプラント')) return 'インプラント';
    return s.replace(/相談|無料|　/g,'').slice(0,6);
  };

  let data = bookingsData.filter(d => d.status !== '除外');

  // 期間フィルター（申込日ベース）
  const now = new Date();
  const todayStr = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')}`;
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate()-1);
  const yesterdayStr = `${yesterday.getFullYear()}/${String(yesterday.getMonth()+1).padStart(2,'0')}/${String(yesterday.getDate()).padStart(2,'0')}`;
  const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate()-7);
  const monthStart = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/01`;

  const getApplyDateStr = (d) => {
    if (!d.applyDate) return '';
    const m = d.applyDate.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (!m) return '';
    return `${m[1]}/${String(parseInt(m[2])).padStart(2,'0')}/${String(parseInt(m[3])).padStart(2,'0')}`;
  };

  if (period === 'today') {
    data = data.filter(d => getApplyDateStr(d) === todayStr);
  } else if (period === 'yesterday') {
    data = data.filter(d => getApplyDateStr(d) === yesterdayStr);
  } else if (period === 'week') {
    data = data.filter(d => { const ds = getApplyDateStr(d); return ds >= `${weekAgo.getFullYear()}/${String(weekAgo.getMonth()+1).padStart(2,'0')}/${String(weekAgo.getDate()).padStart(2,'0')}`; });
  } else if (period === 'month') {
    data = data.filter(d => { const ds = getApplyDateStr(d); return ds >= monthStart; });
  }

  // 統計
  const total = data.length;
  const byTool = {}; data.forEach(d => { byTool[d.tool||'不明'] = (byTool[d.tool||'不明']||0)+1; });

  document.getElementById('apply-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">申込数</span><span class="stat-num">${total}</span></div>
    <div class="stat-card"><span class="stat-label">DXHUB</span><span class="stat-num">${byTool['DXHUB']||0}</span></div>
    <div class="stat-card"><span class="stat-label">セレクト</span><span class="stat-num">${byTool['セレクト']||0}</span></div>
  `;

  // 日別チャート
  const daily = {};
  data.forEach(d => { const ds = getApplyDateStr(d); if (ds) { const short = ds.slice(5); daily[short] = (daily[short]||0)+1; } });
  const dailySorted = Object.entries(daily).sort((a,b) => b[0].localeCompare(a[0])).slice(0, 14);
  const maxDaily = Math.max(...dailySorted.map(([,v]) => v), 1);
  document.getElementById('apply-daily-chart').innerHTML = dailySorted.map(([day, count]) =>
    `<div class="bar-row"><div class="bar-label">${day}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(Math.round(count/maxDaily*100),5)}%"><span>${count}</span></div></div><div class="bar-value">${count}件</div></div>`
  ).join('') || '<p style="color:var(--text-muted);font-size:13px">データなし</p>';

  // プロモ別
  const promoG = {}; data.forEach(d => { const p = d.source||'(なし)'; promoG[p] = (promoG[p]||0)+1; });
  const promoS = Object.entries(promoG).sort((a,b) => b[1]-a[1]);
  renderBarChart('apply-promo-chart', promoS.slice(0,15).map(([name,count]) => ({ name: name.length>20?name.slice(0,20)+'…':name, rate: total>0?Math.round(count/total*100):0, decided: count, consulted: total })));

  // 医院別
  const facG = {}; data.forEach(d => { const f = sFac(d.facility); facG[f] = (facG[f]||0)+1; });
  renderBarChart('apply-facility-chart', Object.entries(facG).sort((a,b) => b[1]-a[1]).map(([name,count]) => ({ name, rate: total>0?Math.round(count/total*100):0, decided: count, consulted: total })));

  // 相談別
  const svcG = {}; data.forEach(d => { const s = sSvc(d.service); svcG[s] = (svcG[s]||0)+1; });
  renderBarChart('apply-service-chart', Object.entries(svcG).sort((a,b) => b[1]-a[1]).map(([name,count]) => ({ name, rate: total>0?Math.round(count/total*100):0, decided: count, consulted: total })));
}

function renderAnalysis() {
  const sFac = (f) => {
    if (!f) return '-';
    if (f.includes('銀座')) return 'BF銀座'; if (f.includes('ウィズ')||f.includes('WITH')||f.includes('ワイズ')) return 'ウィズ';
    if (f.includes('エスカ')) return 'エスカ'; if (f.includes('アール')) return 'アール'; if (f.includes('ルミナス')) return 'ルミナス';
    if (f.includes('茶屋')) return '茶屋'; if (f.includes('小牧')) return '小牧'; if (f.includes('知立')) return '知立';
    if (f.includes('八事')) return '八事'; if (f.includes('岩田')) return '岩田'; if (f.includes('大森')) return '大森'; if (f.includes('京都')) return '京都';
    return f.length > 8 ? f.slice(0,8)+'…' : f;
  };
  const sSvc = (s) => {
    if (!s) return '-';
    if (s.includes('ラミネート')||s.includes('ブラックフィルム')) return 'BF';
    if (s.includes('矯正')) return '矯正'; if (s.includes('セラミック')) return 'セラミック';
    if (s.includes('インプラント')) return 'インプラント';
    return s.replace(/相談|無料|　/g,'').slice(0,6);
  };

  let data = bookingsData.filter(d => d.status !== '除外');
  // 権限制限
  if (_hasPromoRestriction()) data = data.filter(d => _matchesAllowedPromo(d.source));
  if (userRole === 'custom') {
    const cp = JSON.parse(sessionStorage.getItem('customPromos')||'[]');
    if (cp.length) data = data.filter(d => d.source && cp.includes(d.source));
  }
  // フィルター
  const anFac = document.getElementById('an-facility');
  const anSvc = document.getElementById('an-service');
  const anPromo = document.getElementById('an-promo');
  const anTool = document.getElementById('an-tool');
  const anMonth = document.getElementById('an-month');
  if (anFac && anFac.value) data = data.filter(d => sFac(d.facility) === anFac.value);
  if (anSvc && anSvc.value) data = data.filter(d => sSvc(d.service) === anSvc.value);
  if (anPromo && anPromo.value) data = data.filter(d => d.source === anPromo.value);
  if (anTool && anTool.value) data = data.filter(d => d.tool === anTool.value);
  if (anMonth && anMonth.value) {
    data = data.filter(d => {
      if (!d.bookDate && !d.applyDate) return false;
      const src = d.bookDate || d.applyDate;
      const m = src.match(/(\d{4})\D+(\d{1,2})/);
      if (!m) return false;
      const ym = m[1] + '-' + String(parseInt(m[2])).padStart(2,'0');
      return ym === anMonth.value;
    });
  }

  // フィルター選択肢を更新 (権限フィルタ済データから生成)
  const _forOpts = getFilteredBookingsData();
  if (anFac) { const facs = [...new Set(_forOpts.map(d => sFac(d.facility)).filter(Boolean))].sort(); const cur = anFac.value; anFac.innerHTML = '<option value="">全て</option>'+facs.map(f=>`<option ${f===cur?'selected':''}>${f}</option>`).join(''); }
  if (anSvc) { const svcs = [...new Set(_forOpts.map(d => sSvc(d.service)).filter(Boolean))].sort(); const cur = anSvc.value; anSvc.innerHTML = '<option value="">全て</option>'+svcs.map(s=>`<option ${s===cur?'selected':''}>${s}</option>`).join(''); }
  if (anPromo) { const pc = {}; _forOpts.forEach(d => { if (d.source) pc[d.source]=(pc[d.source]||0)+1; }); const ps = Object.entries(pc).sort((a,b)=>b[1]-a[1]); const cur = anPromo.value; anPromo.innerHTML = '<option value="">全て</option>'+ps.map(([p,c])=>`<option value="${p}" ${p===cur?'selected':''}>${p} (${c})</option>`).join(''); }

  // 統計
  const total = data.length;
  const cancelled = data.filter(d => d.status==='キャンセル').length;
  const visited = data.filter(d => isVisitedStatus(d.status)).length;
  const contracted = data.filter(d => d.status==='成約').length;
  const bkExtra = loadData('bk-extra',{});
  let amt = 0; data.forEach(d => { const k=d.name+'|'+d.applyDate; if (bkExtra[k]&&bkExtra[k].contractAmount) amt+=Number(bkExtra[k].contractAmount); });
  const vr = total>0?Math.round((total-cancelled)/total*100):0;
  const cr = visited>0?pct(contracted,visited):0;
  const unit = contracted>0?Math.round(amt/contracted):0;

  const statsEl = document.getElementById('an-stats');
  if (statsEl) statsEl.innerHTML = `
    <div class="stat-card"><span class="stat-label">予約数</span><span class="stat-num">${total}</span></div>
    <div class="stat-card"><span class="stat-label">キャンセル</span><span class="stat-num" style="color:var(--red)">${cancelled}</span></div>
    <div class="stat-card"><span class="stat-label">来院</span><span class="stat-num">${visited}</span></div>
    <div class="stat-card"><span class="stat-label">来院率</span><span class="stat-num">${vr}%</span></div>
    <div class="stat-card"><span class="stat-label">成約</span><span class="stat-num" style="color:var(--green)">${contracted}</span></div>
    <div class="stat-card"><span class="stat-label">成約率</span><span class="stat-num" style="color:${cr>=30?'var(--green)':'var(--red)'}">${cr}%</span></div>
    <div class="stat-card"><span class="stat-label">成約単価</span><span class="stat-num">¥${fmt(unit)}</span></div>
    <div class="stat-card"><span class="stat-label">成約金額</span><span class="stat-num">¥${fmt(amt)}</span></div>
  `;

  // ファネル分析
  const funnelEl = document.getElementById('an-funnel');
  if (funnelEl) {
    const fTotal = data.length;
    const fCancelled = data.filter(d => d.status === 'キャンセル').length;
    const fActive = fTotal - fCancelled;
    const fConfirmed = data.filter(d => ['確認済','来院済','成約'].includes(d.status)).length;
    const fVisited = data.filter(d => isVisitedStatus(d.status)).length;
    const fContracted = data.filter(d => d.status === '成約').length;

    const steps = [
      { label: '申込', count: fTotal, color: '#6366f1', width: 100 },
      { label: '有効（キャンセル除）', count: fActive, color: '#8b5cf6', width: fTotal > 0 ? Math.round(fActive/fTotal*100) : 0 },
      { label: '確認済', count: fConfirmed, color: '#0ea5e9', width: fTotal > 0 ? Math.round(fConfirmed/fTotal*100) : 0 },
      { label: '来院', count: fVisited, color: '#22c55e', width: fTotal > 0 ? Math.round(fVisited/fTotal*100) : 0 },
      { label: '成約', count: fContracted, color: '#f59e0b', width: fTotal > 0 ? Math.round(fContracted/fTotal*100) : 0 },
    ];

    funnelEl.innerHTML = `
      <div class="funnel">
        ${steps.map((s, i) => {
          const prevCount = i > 0 ? steps[i-1].count : fTotal;
          const convRate = prevCount > 0 ? Math.round(s.count / prevCount * 100) : 0;
          const dropRate = prevCount > 0 ? Math.round((prevCount - s.count) / prevCount * 100) : 0;
          return (i > 0 ? '<div class="funnel-arrow">→</div>' : '') +
            `<div class="funnel-step">
              <div class="funnel-bar" style="background:${s.color};width:${Math.max(s.width, 20)}%;min-width:60px">
                <span style="font-size:18px">${s.count}</span>
                <span style="font-size:10px;opacity:0.8">${s.width}%</span>
              </div>
              <div class="funnel-label">${s.label}</div>
              ${i > 0 ? `<div class="funnel-rate">${convRate}% 転換 / ${dropRate}% 離脱</div>` : '<div class="funnel-rate">100%</div>'}
            </div>`;
        }).join('')}
      </div>
      <div style="margin-top:12px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;font-size:11px">
        <div style="background:#f8f9fa;padding:8px;border-radius:6px;text-align:center">
          <div style="font-weight:600;color:var(--text)">キャンセル率</div>
          <div style="font-size:18px;font-weight:700;color:var(--red)">${fTotal > 0 ? Math.round(fCancelled/fTotal*100) : 0}%</div>
          <div style="color:var(--text-sub)">${fCancelled}/${fTotal}件</div>
        </div>
        <div style="background:#f8f9fa;padding:8px;border-radius:6px;text-align:center">
          <div style="font-weight:600;color:var(--text)">確認→来院率</div>
          <div style="font-size:18px;font-weight:700;color:#0ea5e9">${fConfirmed > 0 ? Math.round(fVisited/fConfirmed*100) : 0}%</div>
          <div style="color:var(--text-sub)">${fVisited}/${fConfirmed}件</div>
        </div>
        <div style="background:#f8f9fa;padding:8px;border-radius:6px;text-align:center">
          <div style="font-weight:600;color:var(--text)">来院→成約率</div>
          <div style="font-size:18px;font-weight:700;color:var(--green)">${fVisited > 0 ? Math.round(fContracted/fVisited*100) : 0}%</div>
          <div style="color:var(--text-sub)">${fContracted}/${fVisited}件</div>
        </div>
        <div style="background:#f8f9fa;padding:8px;border-radius:6px;text-align:center">
          <div style="font-weight:600;color:var(--text)">全体成約率</div>
          <div style="font-size:18px;font-weight:700;color:#f59e0b">${fTotal > 0 ? Math.round(fContracted/fTotal*100) : 0}%</div>
          <div style="color:var(--text-sub)">${fContracted}/${fTotal}件</div>
        </div>
      </div>
    `;
  }

  // 軸でグループ化
  const axis = window._anAxis || 'promo';
  const axisLabel = axis==='promo'?'プロモーション':axis==='facility'?'医院':'相談';
  const getKey = (d) => axis==='promo'?(d.source||'(なし)'):axis==='facility'?sFac(d.facility):sSvc(d.service);
  const groups = {};
  data.forEach(d => {
    const k = getKey(d);
    if (!groups[k]) groups[k] = {total:0,cancelled:0,visited:0,contracted:0,amount:0};
    groups[k].total++;
    if (d.status==='キャンセル') groups[k].cancelled++;
    if (isVisitedStatus(d.status)) groups[k].visited++;
    if (d.status==='成約') groups[k].contracted++;
    const ek = d.name+'|'+d.applyDate; if (bkExtra[ek]&&bkExtra[ek].contractAmount) groups[k].amount+=Number(bkExtra[ek].contractAmount);
  });
  const sorted = Object.entries(groups).sort((a,b)=>b[1].total-a[1].total);

  // チャート
  const chartEl = document.getElementById('an-chart');
  const titleEl = document.getElementById('an-chart-title');
  const thAxis = document.getElementById('an-th-axis');
  if (titleEl) titleEl.textContent = axisLabel+'別';
  if (thAxis) thAxis.textContent = axisLabel;
  if (chartEl) {
    chartEl.innerHTML = sorted.slice(0,20).map(([name,v]) => {
      const gvr = v.total>0?Math.round((v.total-v.cancelled)/v.total*100):0;
      const gcr = v.visited>0?pct(v.contracted,v.visited):0;
      return `<div class="bar-row"><div class="bar-label">${name}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(Math.round(v.total/total*100),3)}%"><span>${Math.round(v.total/total*100)}%</span></div></div><div class="bar-value" style="min-width:130px;font-size:10px">${v.total}件 来院${gvr}% 成約${gcr}%</div></div>`;
    }).join('') || '<p style="color:var(--text-muted)">データなし</p>';
  }

  // テーブル
  const tbody = document.getElementById('an-tbody');
  if (tbody) {
    tbody.innerHTML = sorted.map(([name,v]) => {
      const gvr = v.total>0?Math.round((v.total-v.cancelled)/v.total*100):0;
      const gcr = v.visited>0?pct(v.contracted,v.visited):0;
      const gu = v.contracted>0?Math.round(v.amount/v.contracted):0;
      return `<tr><td style="font-size:12px">${name}</td><td>${v.total}</td><td style="color:var(--red)">${v.cancelled}</td><td>${v.visited}</td><td>${gvr}%</td><td style="color:var(--green)">${v.contracted}</td><td><span style="color:${gcr>=30?'var(--green)':'var(--red)'};font-weight:600">${gcr}%</span></td><td>${gu?'¥'+fmt(gu):'-'}</td><td>${v.amount?'¥'+fmt(v.amount):'-'}</td></tr>`;
    }).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';
  }
}

function renderPromoDash() { renderAnalysis(); }

// Legacy renderPromoDash - now calls renderAnalysis
function _oldRenderPromoDash() {
  const bkExtra = loadData('bk-extra', {});
  let dashData = bookingsData;
  // プロモ・カスタムユーザーの制限
  if (_hasPromoRestriction()) {
    dashData = dashData.filter(d => _matchesAllowedPromo(d.source));
  }
  if (userRole === 'custom') {
    const cPromos = JSON.parse(sessionStorage.getItem('customPromos') || '[]');
    const cServices = JSON.parse(sessionStorage.getItem('customServices') || '[]');
    const cFacilities = JSON.parse(sessionStorage.getItem('customFacilities') || '[]');
    if (cPromos.length) dashData = dashData.filter(d => d.source && cPromos.includes(d.source));
    if (cServices.length) dashData = dashData.filter(d => d.service && cServices.some(s => d.service.includes(s)));
    if (cFacilities.length) dashData = dashData.filter(d => d.facility && cFacilities.some(f => d.facility.includes(f)));
  }
  const promoGroups = {};
  dashData.forEach(d => {
    const p = d.source || '(なし)';
    if (!promoGroups[p]) promoGroups[p] = { total: 0, cancelled: 0, visited: 0, contracted: 0, amount: 0 };
    promoGroups[p].total++;
    if (d.status === 'キャンセル') promoGroups[p].cancelled++;
    if (isVisitedStatus(d.status)) promoGroups[p].visited++;
    if (d.status === '成約') promoGroups[p].contracted++;
  });
  // 金額集計
  Object.keys(bkExtra).forEach(key => {
    if (bkExtra[key].contractAmount) {
      const [name, apply] = key.split('|');
      const match = dashData.find(d => d.name === name && d.applyDate === apply);
      if (match) {
        const p = match.source || '(なし)';
        if (promoGroups[p]) promoGroups[p].amount += Number(bkExtra[key].contractAmount);
      }
    }
  });

  const sorted = Object.entries(promoGroups).sort((a, b) => b[1].total - a[1].total);
  const totalAll = sorted.reduce((s, [, v]) => s + v.total, 0);
  const contractedAll = sorted.reduce((s, [, v]) => s + v.contracted, 0);

  const cancelledAll = sorted.reduce((s, [, v]) => s + v.cancelled, 0);
  const visitedAll = sorted.reduce((s, [, v]) => s + v.visited, 0);
  const amountAll = sorted.reduce((s, [, v]) => s + v.amount, 0);
  const visitRate = totalAll > 0 ? Math.round((totalAll - cancelledAll) / totalAll * 100) : 0;
  const contractRate = visitedAll > 0 ? Math.round(contractedAll / visitedAll * 100) : 0;
  const avgUnit = contractedAll > 0 ? Math.round(amountAll / contractedAll) : 0;

  document.getElementById('promo-dash-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">予約数</span><span class="stat-num">${totalAll}</span></div>
    <div class="stat-card"><span class="stat-label">キャンセル</span><span class="stat-num" style="color:var(--red)">${cancelledAll}</span></div>
    <div class="stat-card"><span class="stat-label">来院数</span><span class="stat-num">${visitedAll}</span></div>
    <div class="stat-card"><span class="stat-label">来院率</span><span class="stat-num">${visitRate}%</span></div>
    <div class="stat-card"><span class="stat-label">成約数</span><span class="stat-num" style="color:var(--green)">${contractedAll}</span></div>
    <div class="stat-card"><span class="stat-label">成約率</span><span class="stat-num" style="color:${contractRate>=30?'var(--green)':'var(--red)'}">${contractRate}%</span></div>
    <div class="stat-card"><span class="stat-label">成約単価</span><span class="stat-num">¥${fmt(avgUnit)}</span></div>
    <div class="stat-card"><span class="stat-label">成約金額</span><span class="stat-num">¥${fmt(amountAll)}</span></div>
  `;

  // バーチャート（クリック可能）
  const chartEl = document.getElementById('promo-dash-bookings');
  chartEl.innerHTML = sorted.slice(0, 20).map(([name, v]) => {
    const pct2 = Math.round(v.total / totalAll * 100);
    return `<div class="bar-row" style="cursor:pointer" data-promo="${name}">
      <div class="bar-label">${name.length > 20 ? name.slice(0, 20) + '…' : name}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(pct2, 3)}%"><span>${pct2}%</span></div></div>
      <div class="bar-value">${v.total}/${totalAll}</div>
    </div>`;
  }).join('');
  chartEl.querySelectorAll('.bar-row[data-promo]').forEach(row => {
    row.addEventListener('click', () => showPromoDetail(row.dataset.promo));
  });

  // 医院別集計
  const facChart = {};
  const svcChart = {};
  const sFac2 = (f) => {
    if (!f) return '不明';
    if (f.includes('銀座')) return 'BF銀座';
    if (f.includes('ウィズ') || f.includes('WITH') || f.includes('ワイズ')) return 'ウィズ';
    if (f.includes('エスカ')) return 'エスカ';
    if (f.includes('アール')) return 'アール';
    if (f.includes('ルミナス')) return 'ルミナス';
    if (f.includes('茶屋')) return '茶屋';
    if (f.includes('小牧')) return '小牧';
    if (f.includes('知立')) return '知立';
    if (f.includes('八事')) return '八事';
    if (f.includes('岩田')) return '岩田';
    if (f.includes('大森')) return '大森';
    if (f.includes('京都')) return '京都';
    return f.length > 8 ? f.slice(0,8) : f;
  };
  const sSvc2 = (s) => {
    if (!s) return '不明';
    if (s.includes('ラミネート') || s.includes('ブラックフィルム')) return 'BF';
    if (s.includes('矯正')) return '矯正';
    if (s.includes('セラミック')) return 'セラミック';
    if (s.includes('インプラント')) return 'インプラント';
    return s.replace(/相談|無料|　/g, '').slice(0, 6);
  };
  const facDetail = {};
  dashData.forEach(d => {
    const f = sFac2(d.facility);
    if (!facDetail[f]) facDetail[f] = { total: 0, cancelled: 0, visited: 0, contracted: 0 };
    facDetail[f].total++;
    if (d.status === 'キャンセル') facDetail[f].cancelled++;
    if (isVisitedStatus(d.status)) facDetail[f].visited++;
    if (d.status === '成約') facDetail[f].contracted++;
    const s = sSvc2(d.service); svcChart[s] = (svcChart[s]||0) + 1;
  });
  const totalDash = dashData.length;
  // 医院別チャート（予約数バー + 成約率テキスト）
  const facChartEl = document.getElementById('promo-facility-chart');
  const facSorted = Object.entries(facDetail).sort((a,b) => b[1].total - a[1].total);
  facChartEl.innerHTML = facSorted.map(([name, v]) => {
    const vr = v.total > 0 ? Math.round((v.total - v.cancelled) / v.total * 100) : 0;
    const cr = v.visited > 0 ? pct(v.contracted, v.visited) : 0;
    return `<div class="bar-row">
      <div class="bar-label">${name}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(Math.round(v.total/totalDash*100),3)}%"><span>${Math.round(v.total/totalDash*100)}%</span></div></div>
      <div class="bar-value" style="min-width:120px;font-size:10px">${v.total}件 来院${vr}% 成約${cr}%</div>
    </div>`;
  }).join('') || '<p style="color:var(--text-muted);font-size:13px">データなし</p>';
  // 相談別集計（成約率も出す）
  const svcDetail = {};
  dashData.forEach(d => {
    const s = sSvc2(d.service);
    if (!svcDetail[s]) svcDetail[s] = { total: 0, cancelled: 0, visited: 0, contracted: 0 };
    svcDetail[s].total++;
    if (d.status === 'キャンセル') svcDetail[s].cancelled++;
    if (isVisitedStatus(d.status)) svcDetail[s].visited++;
    if (d.status === '成約') svcDetail[s].contracted++;
  });
  const svcEl2 = document.getElementById('promo-service-chart');
  const svcSorted = Object.entries(svcDetail).sort((a,b) => b[1].total - a[1].total);
  svcEl2.innerHTML = svcSorted.map(([name, v]) => {
    const vr = v.total > 0 ? Math.round((v.total - v.cancelled) / v.total * 100) : 0;
    const cr = v.visited > 0 ? pct(v.contracted, v.visited) : 0;
    return `<div class="bar-row">
      <div class="bar-label">${name}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(Math.round(v.total/totalDash*100),3)}%;background:linear-gradient(90deg,#0ea5e9,#38bdf8)"><span>${Math.round(v.total/totalDash*100)}%</span></div></div>
      <div class="bar-value" style="min-width:120px;font-size:10px">${v.total}件 来院${vr}% 成約${cr}%</div>
    </div>`;
  }).join('') || '<p style="color:var(--text-muted);font-size:13px">データなし</p>';

  // テーブル
  document.getElementById('promo-dash-tbody').innerHTML = sorted.map(([name, v]) => {
    const vRate = v.total > 0 ? Math.round((v.total - v.cancelled) / v.total * 100) : 0;
    const cRate = v.visited > 0 ? pct(v.contracted, v.visited) : 0;
    const unit = v.contracted > 0 ? Math.round(v.amount / v.contracted) : 0;
    return `<tr>
      <td style="font-size:12px">${name}</td>
      <td>${v.total}</td>
      <td style="color:var(--red)">${v.cancelled}</td>
      <td>${v.visited}</td>
      <td>${vRate}%</td>
      <td style="color:var(--green)">${v.contracted}</td>
      <td><span style="color:${cRate>=30?'var(--green)':'var(--red)'};font-weight:600">${cRate}%</span></td>
      <td>${unit ? '¥' + fmt(unit) : '-'}</td>
      <td>${v.amount ? '¥' + fmt(v.amount) : '-'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';
}

function showPromoDetail(promoName) {
  // 権限チェック: 許可されたプロモ以外はアクセス不可
  if (_hasPromoRestriction() && promoName !== '(なし)' && !_matchesAllowedPromo(promoName)) {
    try { alert('このプロモの閲覧権限がありません'); } catch(_){}
    return;
  }
  const data = bookingsData.filter(d => (d.source || '(なし)') === promoName);
  const bkExtra = loadData('bk-extra', {});
  // shortFac for promo detail
  const sFac = (f) => {
    if (!f) return '-';
    if (f.includes('銀座')) return 'BF銀座';
    if (f.includes('ウィズ') || f.includes('WITH') || f.includes('ワイズ')) return 'ウィズ';
    if (f.includes('エスカ')) return 'エスカ';
    if (f.includes('アール')) return 'アール';
    if (f.includes('ルミナス')) return 'ルミナス';
    if (f.includes('茶屋')) return '茶屋';
    if (f.includes('小牧')) return '小牧';
    if (f.includes('知立')) return '知立';
    if (f.includes('八事')) return '八事';
    if (f.includes('岩田')) return '岩田';
    if (f.includes('大森')) return '大森';
    if (f.includes('京都')) return '京都';
    return f.length > 8 ? f.slice(0,8)+'…' : f;
  };
  const sService = (s) => {
    if (!s) return '-';
    if (s.includes('ラミネート') || s.includes('ブラックフィルム')) return 'BF';
    if (s.includes('矯正')) return '矯正';
    if (s.includes('セラミック')) return 'セラミック';
    if (s.includes('インプラント')) return 'インプラント';
    return s.replace(/相談|無料|　/g, '').slice(0, 6);
  };

  document.getElementById('promo-detail').hidden = false;
  document.getElementById('promo-detail-title').textContent = promoName;

  const total = data.length;
  const cancelled = data.filter(d => d.status === 'キャンセル').length;
  const visited = data.filter(d => isVisitedStatus(d.status)).length;
  const contracted = data.filter(d => d.status === '成約').length;
  let totalAmt = 0;
  data.forEach(d => {
    const key = d.name + '|' + d.applyDate;
    if (bkExtra[key] && bkExtra[key].contractAmount) totalAmt += Number(bkExtra[key].contractAmount);
  });

  const detailVisitRate = total > 0 ? Math.round((total - cancelled) / total * 100) : 0;
  const detailContractRate = visited > 0 ? pct(contracted, visited) : 0;
  const detailUnit = contracted > 0 ? Math.round(totalAmt / contracted) : 0;

  document.getElementById('promo-detail-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">予約数</span><span class="stat-num">${total}</span></div>
    <div class="stat-card"><span class="stat-label">キャンセル</span><span class="stat-num" style="color:var(--red)">${cancelled}</span></div>
    <div class="stat-card"><span class="stat-label">来院</span><span class="stat-num">${visited}</span></div>
    <div class="stat-card"><span class="stat-label">来院率</span><span class="stat-num">${detailVisitRate}%</span></div>
    <div class="stat-card"><span class="stat-label">成約</span><span class="stat-num" style="color:var(--green)">${contracted}</span></div>
    <div class="stat-card"><span class="stat-label">成約率</span><span class="stat-num" style="color:${detailContractRate>=30?'var(--green)':'var(--red)'}">${detailContractRate}%</span></div>
    <div class="stat-card"><span class="stat-label">成約単価</span><span class="stat-num">¥${fmt(detailUnit)}</span></div>
    <div class="stat-card"><span class="stat-label">成約金額</span><span class="stat-num">¥${fmt(totalAmt)}</span></div>
  `;

  // 医院別内訳
  const facGroups = {};
  data.forEach(d => { const f = sFac(d.facility); if (!facGroups[f]) facGroups[f] = 0; facGroups[f]++; });
  renderBarChart('promo-detail-facility', Object.entries(facGroups).sort((a,b) => b[1]-a[1]).map(([name, count]) => ({
    name, rate: Math.round(count/total*100), decided: count, consulted: total
  })));

  // 相談別内訳
  const svcGroups = {};
  data.forEach(d => { const s = sService(d.service); if (!svcGroups[s]) svcGroups[s] = 0; svcGroups[s]++; });
  const svcEl = document.getElementById('promo-detail-service');
  svcEl.innerHTML = Object.entries(svcGroups).sort((a,b) => b[1]-a[1]).map(([name, count]) =>
    `<div class="bar-row"><div class="bar-label">${name}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(Math.round(count/total*100),5)}%;background:linear-gradient(90deg,#0ea5e9,#38bdf8)"><span>${Math.round(count/total*100)}%</span></div></div><div class="bar-value">${count}</div></div>`
  ).join('');

  // 予約一覧
  const statusBadge = (s) => {
    if (!s || s === '未対応') return '<span class="badge badge-default">未対応</span>';
    if (s === 'キャンセル') return '<span class="badge badge-danger">キャンセル</span>';
    if (s === '来院済') return '<span class="badge badge-warning">来院済</span>';
    if (s === '成約') return '<span class="badge badge-success">成約</span>';
    return `<span class="badge badge-default">${s}</span>`;
  };
  const sorted2 = [...data].sort((a,b) => (b.bookDate||'').localeCompare(a.bookDate||''));
  document.getElementById('promo-detail-tbody').innerHTML = sorted2.map(d => `<tr>
    <td style="font-size:11px;white-space:nowrap">${d.bookDate ? d.bookDate.slice(0,10) : '-'}</td>
    <td style="font-size:11px;white-space:nowrap">${d.name}</td>
    <td style="font-size:11px">${sService(d.service)}</td>
    <td style="font-size:11px">${sFac(d.facility)}</td>
    <td>${statusBadge(d.status)}</td>
  </tr>`).join('');

  // スクロール
  document.getElementById('promo-detail').scrollIntoView({behavior:'smooth', block:'start'});
}

// === Ad Budget (Supabase - 新構造) ===
const AD_FACILITIES = ['BF銀座','エスカ','アール','ウィズ','ルミナス','茶屋','知立','小牧','八事','岩田','大森','京都'];
const AD_MEDIA = ['google','yahoo','meta','tiktok','seo','organic','sns_management','incentive'];
const AD_MEDIA_LABELS = {google:'Google',yahoo:'Yahoo',meta:'Meta',tiktok:'TikTok',seo:'SEO',organic:'オーガニック',sns_management:'SNS運用',incentive:'インセンティブ'};
let adFacilityCount = 0;

function addAdFacilityRow(facility, values) {
  const container = document.getElementById('ad-facilities-container');
  const idx = adFacilityCount++;
  const div = document.createElement('div');
  div.className = 'card';
  div.style.cssText = 'margin-bottom:10px;padding:12px;background:var(--bg)';
  div.id = 'ad-fac-' + idx;
  div.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <select class="form-select ad-fac-name" style="width:auto;padding:4px 8px;font-size:12px;font-weight:600">
        ${AD_FACILITIES.map(f => `<option ${f===(facility||'')?'selected':''}>${f}</option>`).join('')}
      </select>
      <button class="resource-delete" onclick="document.getElementById('ad-fac-${idx}').remove()" style="width:24px;height:24px;font-size:11px">×</button>
    </div>
    <div class="form-grid" style="grid-template-columns:repeat(4,1fr);gap:8px">
      ${AD_MEDIA.map(m => `<div class="form-group"><label class="form-label">${AD_MEDIA_LABELS[m]}</label><input type="number" class="form-input ad-media-${m}" placeholder="0" value="${values&&values[m]||''}" style="font-size:12px;padding:4px 8px"></div>`).join('')}
      <div class="form-group"><label class="form-label">その他名目</label><input type="text" class="form-input ad-media-other-name" placeholder="例: LINE" value="${values&&values.other_name||''}" style="font-size:12px;padding:4px 8px"></div>
      <div class="form-group"><label class="form-label">その他金額</label><input type="number" class="form-input ad-media-other-amount" placeholder="0" value="${values&&values.other_amount||''}" style="font-size:12px;padding:4px 8px"></div>
    </div>
  `;
  container.appendChild(div);
}

async function saveAdBudget() {
  const agency = document.getElementById('ad-agency').value.trim();
  const month = document.getElementById('ad-month').value;
  if (!agency || !month) { showToast('代理店名と年月を入力してください', true); return; }

  // ヘッダー保存
  const { data: hdr, error: hErr } = await sb.from('ad_budget_headers').insert({
    agency, month,
    total_budget: Number(document.getElementById('ad-total').value) || 0,
    common_cost: Number(document.getElementById('ad-common').value) || 0,
    fee: Number(document.getElementById('ad-fee').value) || 0,
  }).select();
  if (hErr || !hdr || !hdr[0]) { showToast('保存エラー: ' + (hErr?.message||''), true); return; }
  const headerId = hdr[0].id;

  // 店舗別詳細保存
  const facRows = document.querySelectorAll('[id^="ad-fac-"]');
  for (const row of facRows) {
    const facility = row.querySelector('.ad-fac-name').value;
    const detail = { header_id: headerId, facility };
    AD_MEDIA.forEach(m => { detail[m] = Number(row.querySelector('.ad-media-'+m)?.value) || 0; });
    detail.other_name = row.querySelector('.ad-media-other-name')?.value || '';
    detail.other_amount = Number(row.querySelector('.ad-media-other-amount')?.value) || 0;
    await sb.from('ad_budget_details').insert(detail);
  }

  // フォームリセット
  ['ad-total','ad-common','ad-fee'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('ad-facilities-container').innerHTML = '';
  adFacilityCount = 0;
  showToast('広告予算を登録しました');
  renderAdBudgets();
}

async function deleteAdBudget(id) {
  if (!confirm('この広告予算を削除しますか？')) return;
  await sb.from('ad_budget_headers').delete().eq('id', id);
  showToast('削除しました');
  renderAdBudgets();
}

async function renderAdBudgets() {
  const { data: headers } = await sb.from('ad_budget_headers').select('*').order('month', { ascending: false });
  const { data: details } = await sb.from('ad_budget_details').select('*');
  let allHeaders = headers || [];
  const allDetails = details || [];

  // 代理店制限
  if (userRole === 'custom') {
    const myAgency = sessionStorage.getItem('customAgency') || '';
    if (myAgency) {
      allHeaders = allHeaders.filter(h => h.agency === myAgency);
      const agencyInput = document.getElementById('ad-agency');
      if (agencyInput) { agencyInput.value = myAgency; agencyInput.readOnly = true; }
    }
  }

  // フィルター
  const af = document.getElementById('ad-filter-agency').value;
  const mf = document.getElementById('ad-filter-month').value;
  let filtered = allHeaders;
  if (af) filtered = filtered.filter(h => h.agency === af);
  if (mf) filtered = filtered.filter(h => h.month === mf);

  // フィルター選択肢
  const agencies = [...new Set(allHeaders.map(h => h.agency))].sort();
  const months = [...new Set(allHeaders.map(h => h.month))].sort().reverse();
  document.getElementById('ad-filter-agency').innerHTML = '<option value="">代理店:全て</option>' + agencies.map(a => `<option ${a===af?'selected':''}>${a}</option>`).join('');
  document.getElementById('ad-filter-month').innerHTML = '<option value="">月:全て</option>' + months.map(m => `<option ${m===mf?'selected':''}>${m}</option>`).join('');

  // 統計
  const totalBudget = filtered.reduce((s,h) => s + Number(h.total_budget), 0);
  const totalCommon = filtered.reduce((s,h) => s + Number(h.common_cost), 0);
  const totalFee = filtered.reduce((s,h) => s + Number(h.fee), 0);
  const hdrIds = filtered.map(h => h.id);
  const filteredDetails = allDetails.filter(d => hdrIds.includes(d.header_id));
  const totalMedia = filteredDetails.reduce((s,d) => s + AD_MEDIA.reduce((ms,m) => ms + Number(d[m]||0), 0) + Number(d.other_amount||0), 0);

  document.getElementById('ad-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">総額</span><span class="stat-num">¥${fmt(totalBudget)}</span></div>
    <div class="stat-card"><span class="stat-label">共通費</span><span class="stat-num">¥${fmt(totalCommon)}</span></div>
    <div class="stat-card"><span class="stat-label">手数料</span><span class="stat-num">¥${fmt(totalFee)}</span></div>
    <div class="stat-card"><span class="stat-label">媒体費</span><span class="stat-num">¥${fmt(totalMedia)}</span></div>
    <div class="stat-card"><span class="stat-label">件数</span><span class="stat-num">${filtered.length}</span></div>
  `;

  // 一覧
  const listEl = document.getElementById('ad-list');
  if (!filtered.length) { listEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px">データなし</p>'; return; }

  listEl.innerHTML = filtered.map(h => {
    const hDetails = allDetails.filter(d => d.header_id === h.id);
    const facTotal = hDetails.reduce((s,d) => s + AD_MEDIA.reduce((ms,m) => ms + Number(d[m]||0), 0) + Number(d.other_amount||0), 0);
    return `
      <div class="card" style="margin-bottom:12px;padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div>
            <span style="font-weight:700;font-size:15px">${h.agency}</span>
            <span style="font-size:12px;color:var(--text-sub);margin-left:8px">${h.month}</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <span style="font-size:16px;font-weight:700">¥${fmt(h.total_budget)}</span>
            <button class="resource-delete" onclick="deleteAdBudget(${h.id})" style="width:28px;height:28px;font-size:12px">×</button>
          </div>
        </div>
        <div style="display:flex;gap:16px;font-size:12px;color:var(--text-sub);margin-bottom:12px;flex-wrap:wrap">
          <span>共通費: ¥${fmt(h.common_cost)}</span>
          <span>手数料: ¥${fmt(h.fee)}</span>
          <span>店舗広告費: ¥${fmt(facTotal)}</span>
        </div>
        ${hDetails.length ? `
          <div style="font-size:11px;font-weight:600;color:var(--text-sub);margin-bottom:6px">店舗別詳細</div>
          <div class="data-table-wrap">
            <table class="data-table" style="font-size:11px">
              <thead><tr><th>店舗</th>${Object.values(AD_MEDIA_LABELS).map(l => `<th>${l}</th>`).join('')}<th>その他</th><th>合計</th></tr></thead>
              <tbody>${hDetails.map(d => {
                const rowTotal = AD_MEDIA.reduce((s,m) => s + Number(d[m]||0), 0) + Number(d.other_amount||0);
                return `<tr>
                  <td style="font-weight:600">${d.facility}</td>
                  ${AD_MEDIA.map(m => `<td>¥${fmt(d[m])}</td>`).join('')}
                  <td>${d.other_name ? d.other_name+' ¥'+fmt(d.other_amount) : '-'}</td>
                  <td style="font-weight:700">¥${fmt(rowTotal)}</td>
                </tr>`;
              }).join('')}</tbody>
            </table>
          </div>
        ` : '<p style="font-size:12px;color:var(--text-muted)">店舗別詳細なし</p>'}
      </div>
    `;
  }).join('');
}

// === Layer 3: 日次自動バックアップ ===
const BACKUP_TABLES = ['booking_status','manual_bookings','self_recordings','bf_history','accounts','promo_rates','ad_budget_headers','ad_budget_details'];
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24時間
const BACKUP_KEEP_DAYS = 30;

async function createBackup(manual) {
  const stamp = new Date().toISOString().replace(/[:.]/g,'-').substring(0,19);
  const payload = { generated_at: new Date().toISOString(), generated_by: getLoggedUserName ? getLoggedUserName() : 'admin', tables: {} };
  for (const tbl of BACKUP_TABLES) {
    try {
      const { data } = await sb.from(tbl).select('*').limit(10000);
      payload.tables[tbl] = data || [];
    } catch(e) { payload.tables[tbl] = { error: e.message }; }
  }
  // change_log は直近7日分
  try {
    const since = new Date(Date.now() - 7*86400000).toISOString();
    const { data } = await sb.from('change_log').select('*').gte('changed_at', since).limit(5000);
    payload.tables.change_log_recent = data || [];
  } catch(_){}

  const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: 'application/json' });
  const fileName = `backup-${stamp}.json`;
  try {
    const { error } = await sb.storage.from('backups').upload(fileName, blob, { contentType: 'application/json', upsert: false });
    if (error) throw error;
    localStorage.setItem('last-backup-at', Date.now().toString());
    localStorage.setItem('last-backup-file', fileName);
    if (manual) showToast('✓ バックアップ作成: ' + fileName);
    // 古いバックアップ削除
    await cleanOldBackups();
    return { ok: true, fileName };
  } catch(e) {
    console.error('backup failed', e);
    if (manual) showToast('バックアップ失敗: ' + e.message, true);
    return { ok: false, error: e };
  }
}

async function cleanOldBackups() {
  try {
    const { data } = await sb.storage.from('backups').list();
    if (!data) return;
    const cutoff = Date.now() - BACKUP_KEEP_DAYS * 86400000;
    const old = data.filter(f => {
      const m = f.name.match(/backup-(\d{4}-\d{2}-\d{2})/);
      if (!m) return false;
      return new Date(m[1]).getTime() < cutoff;
    });
    if (old.length) {
      await sb.storage.from('backups').remove(old.map(f => f.name));
      console.debug(`[Backup] Cleaned ${old.length} old backups`);
    }
  } catch(e) { console.warn('cleanOldBackups', e); }
}

async function maybeAutoBackup() {
  const last = Number(localStorage.getItem('last-backup-at')) || 0;
  if (Date.now() - last < BACKUP_INTERVAL_MS) return;
  // 管理者のみが作成 (重複防止)
  if (userRole !== 'admin') return;
  console.debug('[Backup] Running daily backup...');
  await createBackup(false);
}

async function listBackups() {
  try {
    const { data, error } = await sb.storage.from('backups').list('', { limit: 100, sortBy: { column: 'name', order: 'desc' } });
    if (error) throw error;
    return (data || []).filter(f => f.name.endsWith('.json'));
  } catch(e) { return []; }
}

async function downloadBackup(fileName) {
  try {
    const { data, error } = await sb.storage.from('backups').download(fileName);
    if (error) throw error;
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
  } catch(e) { showToast('ダウンロード失敗: ' + e.message, true); }
}

async function renderBackupsList() {
  const el = document.getElementById('backup-list');
  if (!el) return;
  el.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">読込中...</div>';
  const list = await listBackups();
  if (!list.length) { el.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:10px">バックアップなし</div>'; return; }
  el.innerHTML = list.slice(0, 30).map(f => {
    const m = f.name.match(/backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    const label = m ? `${m[1]} ${m[2]}:${m[3]}` : f.name;
    const size = f.metadata?.size ? (f.metadata.size/1024).toFixed(1) + ' KB' : '';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border-light);font-size:11px">
      <span style="flex:1">📦 ${label} ${size ? `<span style="color:var(--text-muted)">(${size})</span>` : ''}</span>
      <button class="btn btn-outline backup-dl-btn" data-file="${f.name}" style="font-size:10px;padding:2px 10px">⬇ DL</button>
    </div>`;
  }).join('');
  el.querySelectorAll('.backup-dl-btn').forEach(btn => {
    btn.addEventListener('click', () => downloadBackup(btn.dataset.file));
  });
}

// === 変更履歴・復元 (Layer 1) ===
async function renderChangeLog() {
  const table = document.getElementById('ch-filter-table').value;
  const op = document.getElementById('ch-filter-op').value;
  const key = (document.getElementById('ch-filter-key').value || '').trim();
  const period = document.getElementById('ch-filter-period').value;

  let query = sb.from('change_log').select('*').order('changed_at', { ascending: false }).limit(500);
  if (table) query = query.eq('table_name', table);
  if (op) query = query.eq('operation', op);
  if (key) query = query.ilike('row_key', '%' + key + '%');
  if (period !== 'all') {
    const days = period === '24h' ? 1 : period === '7d' ? 7 : 30;
    const since = new Date(Date.now() - days*86400000).toISOString();
    query = query.gte('changed_at', since);
  }
  const { data, error } = await query;
  if (error) { showToast('読込失敗: ' + error.message, true); return; }
  const tbody = document.getElementById('ch-tbody');
  if (!data || !data.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted);text-align:center;padding:20px">履歴なし</td></tr>';
    document.getElementById('ch-count').textContent = '0件';
    return;
  }
  document.getElementById('ch-count').textContent = data.length + '件' + (data.length >= 500 ? ' (上限500)' : '');
  const opColor = { INSERT: '#10b981', UPDATE: '#3b82f6', DELETE: '#dc2626' };
  tbody.innerHTML = data.map(h => {
    const diff = computeDiff(h.old_data, h.new_data);
    const diffText = diff.length
      ? diff.slice(0, 3).map(d => `<span style="color:var(--text-sub)">${d.field}:</span> <span style="color:#c00">${esc(d.old).substring(0,30)}</span> → <span style="color:#0a0">${esc(d.new).substring(0,30)}</span>`).join('<br>') + (diff.length>3?`<br><span style="color:var(--text-muted)">...他${diff.length-3}件</span>`:'')
      : (h.operation==='INSERT' ? '(新規作成)' : h.operation==='DELETE' ? '(削除)' : '(変更なし)');
    return `
      <tr>
        <td style="font-size:10px;white-space:nowrap">${(h.changed_at||'').substring(0,16).replace('T',' ')}</td>
        <td style="font-size:10px">${h.table_name}</td>
        <td><span style="font-size:10px;font-weight:700;color:${opColor[h.operation]||'#666'}">${h.operation}</span></td>
        <td style="font-size:10px;text-align:left;max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(h.row_key)}</td>
        <td style="font-size:11px;line-height:1.5">${diffText}</td>
        <td style="text-align:center">
          <button class="btn btn-outline ch-view-btn" data-id="${h.id}" style="font-size:10px;padding:2px 8px;margin-bottom:2px">詳細</button>
          ${h.old_data ? `<button class="btn btn-dark ch-restore-btn" data-id="${h.id}" style="font-size:10px;padding:2px 8px;background:#f59e0b;border-color:#f59e0b">↺ 復元</button>` : ''}
        </td>
      </tr>`;
  }).join('');

  // 詳細ボタン
  tbody.querySelectorAll('.ch-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const h = data.find(x => x.id == btn.dataset.id);
      if (h) openChangeDetailModal(h);
    });
  });
  // 復元ボタン
  tbody.querySelectorAll('.ch-restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const h = data.find(x => x.id == btn.dataset.id);
      if (!h || !h.old_data) return;
      if (!confirm(`${h.table_name} の「${h.row_key}」を この変更前の状態 に戻します。よろしいですか？`)) return;
      await restoreChange(h);
    });
  });
}

function computeDiff(oldData, newData) {
  if (!oldData || !newData) return [];
  const diff = [];
  const keys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);
  keys.forEach(k => {
    if (k === 'updated_at' || k === 'created_at') return;
    const o = oldData[k]; const n = newData[k];
    if (JSON.stringify(o) !== JSON.stringify(n)) {
      diff.push({ field: k, old: String(o == null ? '' : o), new: String(n == null ? '' : n) });
    }
  });
  return diff;
}

function openChangeDetailModal(h) {
  document.getElementById('ch-detail-title').textContent = `${h.table_name} / ${h.row_key} — ${h.operation}`;
  const body = document.getElementById('ch-detail-body');
  const diff = computeDiff(h.old_data, h.new_data);
  body.innerHTML = `
    <div style="font-size:11px;color:var(--text-sub);margin-bottom:12px">${(h.changed_at||'').substring(0,19).replace('T',' ')}</div>
    ${diff.length ? `<table class="data-table" style="font-size:12px"><thead><tr><th>フィールド</th><th style="color:#c00">変更前</th><th style="color:#0a0">変更後</th></tr></thead><tbody>
      ${diff.map(d => `<tr><td style="text-align:left;font-weight:600">${d.field}</td><td style="color:#c00;background:#fee2e2">${esc(d.old)||'(空)'}</td><td style="color:#0a0;background:#dcfce7">${esc(d.new)||'(空)'}</td></tr>`).join('')}
    </tbody></table>` : '<p>変更なし</p>'}
    <details style="margin-top:12px"><summary style="cursor:pointer;font-size:11px">生データ (JSON)</summary>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div><div style="font-size:11px;color:#c00;font-weight:600">OLD</div><pre style="font-size:10px;background:#fee2e2;padding:8px;border-radius:4px;overflow:auto;max-height:300px">${esc(JSON.stringify(h.old_data, null, 2) || '(なし)')}</pre></div>
        <div><div style="font-size:11px;color:#0a0;font-weight:600">NEW</div><pre style="font-size:10px;background:#dcfce7;padding:8px;border-radius:4px;overflow:auto;max-height:300px">${esc(JSON.stringify(h.new_data, null, 2) || '(なし)')}</pre></div>
      </div>
    </details>
    ${h.old_data ? `<div style="margin-top:14px"><button class="btn btn-dark" id="ch-detail-restore" style="background:#f59e0b;border-color:#f59e0b">↺ この変更前の状態に復元</button></div>` : ''}
  `;
  const rb = document.getElementById('ch-detail-restore');
  if (rb) rb.addEventListener('click', async () => {
    if (!confirm('この変更前の状態に戻します。よろしいですか？')) return;
    await restoreChange(h);
    document.getElementById('ch-detail-modal').hidden = true;
  });
  document.getElementById('ch-detail-modal').hidden = false;
}

async function restoreChange(h) {
  if (!h.old_data) { showToast('復元元データなし', true); return; }
  const restoreData = { ...h.old_data };
  // updated_at / id は除外してupsert
  delete restoreData.updated_at;
  const table = h.table_name;
  try {
    let conflictKey = 'id';
    if (table === 'booking_status' || table === 'manual_bookings') conflictKey = 'name,apply_date';
    const { error } = await sb.from(table).upsert(restoreData, { onConflict: conflictKey });
    if (error) throw error;
    showToast('復元しました。次回リロード/更新で反映');
    renderChangeLog();
  } catch(e) {
    showToast('復元エラー: ' + e.message, true);
  }
}

function exportChangeLogCsv() {
  const tbody = document.getElementById('ch-tbody');
  const rows = tbody.querySelectorAll('tr');
  // change_log データをCSV化
  sb.from('change_log').select('*').order('changed_at', { ascending: false }).limit(2000).then(({ data }) => {
    if (!data || !data.length) { showToast('データなし', true); return; }
    const csvRows = [['id','changed_at','table_name','row_key','operation','old_data','new_data']];
    data.forEach(h => {
      csvRows.push([h.id, h.changed_at, h.table_name, h.row_key, h.operation, JSON.stringify(h.old_data||{}), JSON.stringify(h.new_data||{})]);
    });
    const csv = csvRows.map(row => row.map(c => '"' + String(c||'').replace(/"/g,'""') + '"').join(',')).join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `change_log_${new Date().toISOString().substring(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// === プロモ別インセ率 ===
let promoRatesCache = {}; // { promoCode: rate }

async function loadPromoRates() {
  try {
    const { data } = await sb.from('promo_rates').select('*');
    promoRatesCache = {};
    (data || []).forEach(r => { promoRatesCache[r.promo_code] = Number(r.rate) || 0; });
  } catch(e) { console.warn('promo rates load', e); }
  return promoRatesCache;
}

async function savePromoRate() {
  const code = document.getElementById('pr-code').value.trim();
  const rate = Number(document.getElementById('pr-rate').value);
  if (!code || isNaN(rate)) { showToast('プロモコードと率を入力', true); return; }
  const { error } = await sb.from('promo_rates').upsert({ promo_code: code, rate, updated_at: new Date().toISOString() });
  if (error) { showToast('保存失敗: ' + error.message, true); return; }
  document.getElementById('pr-code').value = '';
  document.getElementById('pr-rate').value = '';
  // キャッシュ更新 + 既存予約の再計算をトリガー
  await loadPromoRates();
  if (typeof bookingsData !== 'undefined' && bookingsData.length) {
    const bkEx = loadData('bk-extra', {});
    let recalc = 0;
    bookingsData.forEach(d => {
      if ((d.source||'').trim() !== code) return;
      const key = d.name + '|' + d.applyDate;
      const ex = bkEx[key] || {};
      const amt = Number(ex.contractAmount || d.contractAmount || 0);
      if (amt > 0) {
        const inc = calcIncentive(code, amt);
        if (inc) {
          if (!bkEx[key]) bkEx[key] = {};
          bkEx[key].incentiveAmount = inc;
          d.incentiveAmount = inc;
          (async () => {
            const res = await safeSave({ type:'upsert', table:'booking_status', payload: { name: d.name, apply_date: d.applyDate, incentive_amount: inc }, options: { onConflict:'name,apply_date' } });
            if (res && res.ok === false) console.warn('promo incentive queued', d.name);
          })();
          recalc++;
        }
      }
    });
    if (recalc) saveData('bk-extra', bkEx);
    if (typeof renderBookings === 'function') renderBookings();
    showToast(`プロモ率を保存しました (${recalc}件のインセを再計算)`);
  } else {
    showToast('プロモ率を保存しました');
  }
  await renderPromoRates();
}

async function deletePromoRate(code) {
  if (!confirm(code + ' のインセ率を削除しますか？')) return;
  await sb.from('promo_rates').delete().eq('promo_code', code);
  showToast('削除しました');
  renderPromoRates();
}

async function renderPromoRates() {
  await loadPromoRates();
  const { data } = await sb.from('promo_rates').select('*').order('promo_code');

  // datalist を既存プロモコードで埋める (予約データ + 登録済みレート + PROMO_PASSWORDS の値)
  const dl = document.getElementById('pr-code-options');
  if (dl) {
    const fromBookings = [...new Set((bookingsData || []).map(d => d.source).filter(Boolean))];
    const fromRates = (data || []).map(r => r.promo_code);
    const fromPasswords = typeof PROMO_PASSWORDS === 'object' ? Object.values(PROMO_PASSWORDS) : [];
    const all = [...new Set([...fromBookings, ...fromRates, ...fromPasswords])].sort();
    dl.innerHTML = all.map(p => `<option value="${p.replace(/"/g,'&quot;')}">`).join('');
  }

  const tbody = document.querySelector('#pr-table tbody');
  if (!tbody) return;
  const rows = (data || []).map(r => `
    <tr>
      <td style="font-weight:600">${r.promo_code}</td>
      <td><span style="font-family:'Cormorant Garamond',serif;font-size:16px;font-weight:600">${r.rate}</span>%</td>
      <td style="font-size:11px;color:var(--text-sub)">${(r.updated_at||'').substring(0,10)}</td>
      <td><button class="resource-delete" onclick="deletePromoRate('${r.promo_code.replace(/'/g,"\\'")}')" style="width:24px;height:24px;font-size:11px">×</button></td>
    </tr>`).join('');
  tbody.innerHTML = rows || '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;padding:12px">未登録</td></tr>';
}

function calcIncentive(source, amount) {
  const rate = promoRatesCache[(source || '').trim()];
  if (!rate || !Number(amount)) return 0;
  return Math.round(Number(amount) * rate / 100);
}

// === 自医院録音 (Supabase + MediaRecorder) ===
let recordingsCache = [];
let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;
let recTimerInterval = null;
let recStartTime = 0;

async function fetchRecordings() {
  try {
    const { data, error } = await sb.from('self_recordings').select('*').order('session_date', { ascending: false }).order('id', { ascending: false });
    if (error) throw error;
    if (!data) {
      console.warn('recordings fetch: no data returned, keeping cache');
      return recordingsCache;
    }
    recordingsCache = data.map(r => ({
      id: r.id, createdAt: r.created_at,
      date: r.session_date, counselor: r.counselor, facility: r.facility,
      patient: r.patient, service: r.service, url: r.url, duration: r.duration,
      contracted: r.contracted, amount: r.amount, notes: r.notes,
      aiTranscript: r.ai_transcript, aiAdvice: r.ai_advice, aiScore: r.ai_score,
      aiChat: r.ai_chat || loadData('rec-chat-' + r.id, [])
    }));
    // ローカル退避（fetch失敗時の表示維持用）
    try { saveData('self-recordings-backup', recordingsCache); } catch(_){}
  } catch (e) {
    console.warn('recordings fetch error - using last backup', e);
    // 直近キャッシュを保持。空にしない
    if (!recordingsCache.length) {
      recordingsCache = loadData('self-recordings-backup', []);
    }
  }
  return recordingsCache;
}

// Phase 3: Storage private化に伴う署名URL生成
// 保存されている url は旧 public URL の可能性があるため、path を抽出して
// createSignedUrl を呼ぶ。失敗時は元 URL を fallback として返す (互換維持)。
async function getSignedRecordingUrl(storagePath) {
  if (!storagePath) return null;
  let path = storagePath;
  if (path.startsWith('http')) {
    const m = path.match(/\/recordings\/(.+?)(?:\?.*)?$/);
    if (m) path = m[1];
    else return storagePath; // 形式不明、そのまま返す
  }
  try {
    const { data, error } = await sb.storage.from('recordings').createSignedUrl(path, 3600);
    if (error) { console.warn('signed url err', error); return storagePath; }
    return data.signedUrl || storagePath;
  } catch(e) { console.warn('signed url exception', e); return storagePath; }
}

async function uploadRecordingBlob(blob) {
  const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('mp4') ? 'm4a' : blob.type.includes('wav') ? 'wav' : 'webm';
  const fileName = `${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
  const { error } = await sb.storage.from('recordings').upload(fileName, blob, { contentType: blob.type, upsert: false });
  if (error) throw error;
  const { data: pub } = sb.storage.from('recordings').getPublicUrl(fileName);
  return pub.publicUrl;
}

async function saveRecording() {
  const date = document.getElementById('rec-date').value;
  const counselor = document.getElementById('rec-counselor').value.trim();
  const facility = document.getElementById('rec-facility').value;
  const patient = document.getElementById('rec-patient').value.trim();
  const service = document.getElementById('rec-service').value;
  let url = document.getElementById('rec-url').value.trim();
  const duration = Number(document.getElementById('rec-duration').value) || 0;
  const contracted = document.getElementById('rec-contracted').value === '1';
  const amount = Number(document.getElementById('rec-amount').value) || 0;
  const notes = document.getElementById('rec-notes').value.trim();
  const file = document.getElementById('rec-file').files[0];
  if (!date || !counselor) { showToast('日付とカウンセラーを入力してください', true); return; }

  const saveBtn = document.getElementById('rec-save');
  saveBtn.disabled = true; saveBtn.textContent = '保存中...';
  document.getElementById('rec-status').textContent = '';

  try {
    // 録音blob優先、次にfile、次にurl
    if (recordedBlob) {
      document.getElementById('rec-status').textContent = '録音をアップロード中...';
      url = await uploadRecordingBlob(recordedBlob);
    } else if (file) {
      document.getElementById('rec-status').textContent = 'ファイルをアップロード中...';
      url = await uploadRecordingBlob(file);
    }

    const { error } = await sb.from('self_recordings').insert({
      session_date: date, counselor, facility, patient, service, url,
      duration, contracted, amount, notes
    });
    if (error) throw error;

    // リセット
    ['rec-patient','rec-url','rec-duration','rec-amount','rec-notes'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('rec-contracted').value = '0';
    document.getElementById('rec-file').value = '';
    const fprev = document.getElementById('rec-file-preview');
    if (fprev) { fprev.style.display = 'none'; fprev.src = ''; }
    const flbl = document.getElementById('rec-file-label');
    if (flbl) flbl.textContent = 'クリックして選択 (m4a/mp3/wav/webm)';
    const prev = document.getElementById('rec-preview');
    prev.style.display = 'none'; prev.src = '';
    recordedBlob = null; recordedChunks = [];
    document.getElementById('rec-timer').textContent = '00:00';
    document.getElementById('rec-status').textContent = '';
    showToast('録音情報を登録しました');
    await renderRecordings();
  } catch (e) {
    console.error(e);
    showToast('保存エラー: ' + (e.message || ''), true);
    document.getElementById('rec-status').textContent = '';
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = '登録';
  }
}

async function deleteRecording(id) {
  if (!confirm('この録音記録を削除しますか？')) return;
  const rec = recordingsCache.find(r => r.id === id);
  await sb.from('self_recordings').delete().eq('id', id);
  // Storageからも削除 (URLに /recordings/ が含まれる場合)
  if (rec && rec.url && rec.url.includes('/recordings/')) {
    try {
      const fileName = rec.url.split('/recordings/')[1].split('?')[0];
      await sb.storage.from('recordings').remove([fileName]);
    } catch(e) { console.warn('storage delete skipped', e); }
  }
  showToast('削除しました');
  renderRecordings();
}

// === ブラウザ録音 ===
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
      : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    const opts = mimeType ? { mimeType, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 };
    mediaRecorder = new MediaRecorder(stream, opts);
    recordedChunks = [];
    recordedBlob = null;
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      recordedBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const prev = document.getElementById('rec-preview');
      prev.src = URL.createObjectURL(recordedBlob);
      prev.style.display = 'block';
      stream.getTracks().forEach(t => t.stop());
      // duration自動入力 (分)
      const mins = Math.max(1, Math.round((Date.now() - recStartTime) / 60000));
      const durEl = document.getElementById('rec-duration');
      if (!durEl.value) durEl.value = mins;
      document.getElementById('rec-status').textContent = `録音完了 (${mins}分) — 保存時にアップロード`;
    };
    mediaRecorder.start();
    recStartTime = Date.now();
    document.getElementById('rec-start').disabled = true;
    document.getElementById('rec-stop').disabled = false;
    document.getElementById('rec-status').textContent = '🔴 録音中...';
    recTimerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - recStartTime) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      document.getElementById('rec-timer').textContent = `${mm}:${ss}`;
    }, 1000);
  } catch (e) {
    showToast('マイクアクセスが拒否されました: ' + e.message, true);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  clearInterval(recTimerInterval);
  document.getElementById('rec-start').disabled = false;
  document.getElementById('rec-stop').disabled = true;
}

// === パートナー専用ログイン (?view=partner) ===
// パートナー用ログインは廃止。メインのメール+パスワードログインへ誘導
function initPartnerLogin() {
  try {
    const u = new URL(location.href);
    u.searchParams.delete('view');
    // 廃止メッセージを表示してからメインに戻す
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;font-family:inherit;padding:20px;text-align:center';
    ov.innerHTML = `
      <div style="font-size:13px;font-weight:700;letter-spacing:3px;color:#111">SEISHOKAI PARTNERS</div>
      <div style="font-size:14px;color:#333;max-width:360px;line-height:1.7">このアクセス方法は廃止されました。<br>管理者にご連絡ください。</div>
      <button id="pt-back-btn" style="border:2px solid #111;background:#111;color:#fff;padding:10px 32px;font-size:13px;font-weight:700;border-radius:6px;cursor:pointer;font-family:inherit;letter-spacing:2px">メインへ</button>
    `;
    document.body.appendChild(ov);
    ov.querySelector('#pt-back-btn').addEventListener('click', () => {
      location.replace(u.toString());
    });
  } catch (e) {
    console.warn('initPartnerLogin redirect failed', e);
  }
}

// === 録音専用ページ (?view=rec) ===
let rsRecorder = null;
let rsChunks = [];
let rsBlob = null;
let rsStream = null;
let rsTimerInt = null;
let rsStart = 0;
let rsWakeLock = null;

async function initStandaloneRecorder() {
  const rs = document.getElementById('rec-standalone');
  rs.hidden = false;
  rs.style.display = 'flex';
  document.getElementById('login-screen').style.display = 'none';
  // 端末スリープ防止 (Wake Lock)
  const setupWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        rsWakeLock = await navigator.wakeLock.request('screen');
        document.getElementById('rs-wake').innerHTML = '● 画面ロック防止';
        document.getElementById('rs-wake').style.opacity = '.8';
        rsWakeLock.addEventListener('release', () => {
          document.getElementById('rs-wake').style.opacity = '.4';
        });
      }
    } catch(e) { console.warn('wakeLock denied', e); }
  };

  document.getElementById('rs-toggle').addEventListener('click', async () => {
    if (!rsRecorder || rsRecorder.state === 'inactive') {
      // 開始
      try {
        rsStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mt = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
          : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
        rsRecorder = new MediaRecorder(rsStream, { ...(mt ? { mimeType: mt } : {}), audioBitsPerSecond: 32000 });
        rsChunks = []; rsBlob = null;
        rsRecorder.ondataavailable = e => { if (e.data.size > 0) rsChunks.push(e.data); };
        rsRecorder.onstop = () => {
          rsBlob = new Blob(rsChunks, { type: rsRecorder.mimeType || 'audio/webm' });
          rsStream.getTracks().forEach(t => t.stop());
          // 保存画面へ遷移
          document.getElementById('rs-recording-ui').style.display = 'none';
          document.getElementById('rs-save-ui').hidden = false;
          document.getElementById('rs-preview').src = URL.createObjectURL(rsBlob);
          document.getElementById('rs-save-time').textContent = document.getElementById('rs-timer').textContent;
        };
        // 5秒ごとにchunkを吐く (万一のクラッシュ対策)
        rsRecorder.start(5000);
        rsStart = Date.now();
        document.getElementById('rs-toggle').style.background = '#333';
        document.getElementById('rs-toggle').innerHTML = '■ STOP';
        document.getElementById('rs-toggle').style.boxShadow = '0 0 40px rgba(255,255,255,.1)';
        document.getElementById('rs-hint').textContent = '録音中 — 停止は再タップ';
        await setupWakeLock();
        rsTimerInt = setInterval(() => {
          const s = Math.floor((Date.now() - rsStart) / 1000);
          const hh = Math.floor(s / 3600);
          const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
          const ss = String(s % 60).padStart(2, '0');
          document.getElementById('rs-timer').textContent = hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
          // 推定サイズ (32kbps)
          const estKb = Math.round(s * 32 / 8);
          const estDisp = estKb < 1024 ? `≈ ${estKb} KB` : `≈ ${(estKb/1024).toFixed(1)} MB`;
          document.getElementById('rs-size').textContent = estDisp;
        }, 1000);
      } catch (e) {
        alert('マイクが使えません: ' + e.message);
      }
    } else {
      // 停止
      rsRecorder.stop();
      clearInterval(rsTimerInt);
      if (rsWakeLock) { try { await rsWakeLock.release(); } catch(_){} rsWakeLock = null; }
    }
  });

  // タブ復帰時に WakeLock 再取得
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && rsRecorder && rsRecorder.state === 'recording') {
      await setupWakeLock();
    }
  });

  // 撮り直し
  document.getElementById('rs-redo').addEventListener('click', () => {
    if (!confirm('録音を破棄してもう一度撮りますか？')) return;
    rsBlob = null; rsChunks = [];
    document.getElementById('rs-save-ui').hidden = true;
    document.getElementById('rs-recording-ui').style.display = 'flex';
    document.getElementById('rs-timer').textContent = '00:00';
    document.getElementById('rs-toggle').style.background = '#d93636';
    document.getElementById('rs-toggle').innerHTML = '● REC';
    document.getElementById('rs-toggle').style.boxShadow = '0 0 40px rgba(217,54,54,.4)';
    document.getElementById('rs-hint').textContent = 'タップで録音開始';
    document.getElementById('rs-size').textContent = '';
  });

  // 保存
  document.getElementById('rs-save').addEventListener('click', async () => {
    const counselor = document.getElementById('rs-counselor').value.trim();
    if (!counselor) { document.getElementById('rs-save-status').textContent = 'カウンセラー名を入力してください'; return; }
    const btn = document.getElementById('rs-save');
    btn.disabled = true; btn.textContent = '保存中...';
    document.getElementById('rs-save-status').textContent = 'アップロード中...';
    try {
      const url = await uploadRecordingBlob(rsBlob);
      const durSec = Math.floor((Date.now() - rsStart) / 1000);
      const today = new Date();
      const date = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      const { error } = await sb.from('self_recordings').insert({
        session_date: date, counselor,
        facility: document.getElementById('rs-facility').value,
        patient: document.getElementById('rs-patient').value.trim(),
        service: 'インビザ',
        url, duration: Math.max(1, Math.round(durSec / 60)),
        contracted: document.getElementById('rs-contracted').value === '1',
        amount: Number(document.getElementById('rs-amount').value) || 0,
        notes: document.getElementById('rs-notes').value.trim()
      });
      if (error) throw error;
      document.getElementById('rs-save-status').innerHTML = '<span style="color:#6f6">✓ 保存完了</span>';
      setTimeout(() => {
        // リセットして最初の画面に戻る
        document.getElementById('rs-redo').click();
        ['rs-counselor','rs-patient','rs-amount','rs-notes'].forEach(id => document.getElementById(id).value = '');
        document.getElementById('rs-contracted').value = '0';
        document.getElementById('rs-save-status').textContent = '';
      }, 1500);
    } catch(e) {
      console.error(e);
      document.getElementById('rs-save-status').innerHTML = '<span style="color:#f66">エラー: ' + (e.message || '') + '</span>';
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  });

  // 閉じる
  document.getElementById('rs-close').addEventListener('click', () => {
    if (rsRecorder && rsRecorder.state === 'recording') {
      if (!confirm('録音中です。破棄して閉じますか？')) return;
      rsRecorder.stop();
      clearInterval(rsTimerInt);
    }
    if (rsWakeLock) { try { rsWakeLock.release(); } catch(_){} }
    location.href = location.pathname;
  });
}

async function openRecordingDetail(id) {
  const r = recordingsCache.find(x => x.id === id);
  if (!r) return;
  // Phase 3: 署名URLに変換 (失敗時は元URL fallback)
  const playUrl = r.url ? (await getSignedRecordingUrl(r.url)) : null;
  const body = document.getElementById('rec-detail-body');
  body.innerHTML = `
    <h3 style="font-size:16px;font-weight:700;margin-bottom:12px">${esc(r.patient || '（患者名なし）')} 様 / ${esc(r.facility)}</h3>
    <div style="font-size:12px;color:var(--text-sub);margin-bottom:16px">${esc(r.date)} ・ ${esc(r.counselor)} ・ ${esc(r.service)} ・ ${esc(r.duration)}分</div>
    <div style="display:flex;gap:16px;margin-bottom:16px;padding:12px;background:var(--bg);border-radius:8px">
      <div><span style="font-size:11px;color:var(--text-sub)">成約</span><div style="font-size:16px;font-weight:700;color:${r.contracted?'#0a0':'#999'}">${r.contracted?'✓ 成約':'未成約'}</div></div>
      <div><span style="font-size:11px;color:var(--text-sub)">金額</span><div style="font-size:16px;font-weight:700">¥${fmt(r.amount)}</div></div>
      ${r.aiScore!=null?`<div><span style="font-size:11px;color:var(--text-sub)">AI評価</span><div style="font-size:16px;font-weight:700">${r.aiScore}/100</div></div>`:''}
    </div>
    ${r.url ? `<div style="margin-bottom:16px"><div style="font-size:11px;font-weight:600;color:var(--text-sub);margin-bottom:4px">録音</div><audio controls src="${esc(playUrl || r.url)}" style="width:100%;margin-bottom:4px"></audio><a href="${esc(playUrl || r.url)}" target="_blank" style="font-size:11px;color:#0066cc;word-break:break-all">別タブで開く</a></div>` : ''}
    <div style="margin-bottom:16px"><div style="font-size:11px;font-weight:600;color:var(--text-sub);margin-bottom:4px">要点・メモ</div><div style="font-size:13px;line-height:1.7;white-space:pre-wrap">${esc(r.notes || '(なし)')}</div></div>
    ${r.aiTranscript ? `<details style="margin-bottom:12px"><summary style="font-size:11px;font-weight:600;color:var(--text-sub);cursor:pointer">📝 文字起こし (展開)</summary><div style="font-size:12px;line-height:1.7;white-space:pre-wrap;padding:10px;background:var(--bg);border-radius:4px;max-height:300px;overflow-y:auto;margin-top:6px">${esc(r.aiTranscript)}</div></details>` : ''}
    ${r.aiAdvice ? `<div style="margin-bottom:16px;padding:14px;background:#fff8e1;border-left:3px solid #f9a825;border-radius:4px"><div style="font-size:11px;font-weight:600;color:#b8860b;margin-bottom:8px">🤖 AI フィードバック</div><div style="font-size:13px;line-height:1.7;white-space:pre-wrap">${esc(r.aiAdvice)}</div></div>` : ''}
    ${r.aiAdvice ? `
    <div style="margin-bottom:12px;padding:12px;background:#f0f9ff;border-left:3px solid #0284c7;border-radius:4px">
      <div style="font-size:11px;font-weight:600;color:#0369a1;margin-bottom:8px">💬 AIとディスカッション</div>
      <div id="rec-chat-history" style="max-height:280px;overflow-y:auto;margin-bottom:10px"></div>
      <div style="display:flex;gap:6px;align-items:flex-end">
        <textarea id="rec-chat-input" rows="2" placeholder="質問・深掘りしたいことを入力 (例: もっと具体的な事例で / 価格説明のテンプレを作って)" style="flex:1;padding:8px;border:1.5px solid var(--border);border-radius:6px;font-size:12px;line-height:1.5;resize:vertical;font-family:inherit"></textarea>
        <button class="btn btn-dark" id="rec-chat-send" onclick="sendChatMessage(${r.id})" style="padding:8px 16px;font-size:12px;background:#0284c7;border-color:#0284c7">送信</button>
      </div>
      <div id="rec-chat-status" style="font-size:10px;color:var(--text-sub);margin-top:6px;min-height:12px"></div>
    </div>` : ''}
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
      <button class="btn btn-dark" id="rec-ai-analyze-btn" onclick="analyzeRecording(${r.id})" style="background:#7c3aed;border-color:#7c3aed">${r.aiAdvice ? '🤖 AI再分析' : '🤖 AI分析する'}</button>
      <button class="btn btn-outline" onclick="document.getElementById('rec-detail-modal').hidden=true">閉じる</button>
      <button class="btn btn-outline" onclick="deleteRecording(${r.id});document.getElementById('rec-detail-modal').hidden=true" style="color:#c00;border-color:#c00;margin-left:auto">削除</button>
    </div>
    <div id="rec-ai-status" style="font-size:11px;color:var(--text-sub);margin-top:8px;min-height:14px"></div>
  `;
  document.getElementById('rec-detail-modal').hidden = false;
  if (r.aiAdvice) renderChatHistory(r);
}

function renderChatHistory(r) {
  const el = document.getElementById('rec-chat-history');
  if (!el) return;
  const chat = r.aiChat || [];
  if (!chat.length) { el.innerHTML = '<div style="font-size:11px;color:var(--text-muted);text-align:center;padding:8px">まだ会話なし。質問してみよう</div>'; return; }
  el.innerHTML = chat.map(m => {
    if (m.role === 'user') {
      return `<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><div style="max-width:80%;padding:8px 12px;background:#0284c7;color:#fff;border-radius:12px 12px 2px 12px;font-size:12px;line-height:1.5;white-space:pre-wrap">${escHtml(m.content)}</div></div>`;
    } else {
      return `<div style="display:flex;justify-content:flex-start;margin-bottom:8px"><div style="max-width:85%;padding:8px 12px;background:#fff;border:1px solid var(--border-light);border-radius:12px 12px 12px 2px;font-size:12px;line-height:1.6;white-space:pre-wrap">${escHtml(m.content)}</div></div>`;
    }
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function escHtml(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function sendChatMessage(id) {
  const r = recordingsCache.find(x => x.id === id);
  if (!r) return;
  const input = document.getElementById('rec-chat-input');
  const status = document.getElementById('rec-chat-status');
  const sendBtn = document.getElementById('rec-chat-send');
  const userMsg = input.value.trim();
  if (!userMsg) return;

  // ユーザーメッセージ追加
  if (!r.aiChat) r.aiChat = [];
  r.aiChat.push({ role: 'user', content: userMsg });
  renderChatHistory(r);
  input.value = '';
  sendBtn.disabled = true;
  status.textContent = 'AI応答中...';

  try {
    // 競合データ
    let competitorContext = '';
    try {
      const cRes = await fetch('data/clinics.json?v=' + Date.now(), { cache: 'no-store' });
      const cData = await cRes.json();
      competitorContext = (cData || []).slice(0, 12).map(c => {
        const sc = c.scores || {};
        const avg = ((sc.reception + sc.counseling + sc.hospitality + sc.environment) / 4).toFixed(1);
        return `■ ${c.name}(${avg}/5): 強み=${(c.strengths||[]).slice(0,2).join('/')} / 改善=${c.improvements?.counseling || ''}`;
      }).join('\n');
    } catch(_){}

    const systemPrompt = `あなたは清翔会(歯科医院グループ)のカウンセリング指導コーチです。
以下のカウンセリング録音について、ユーザー(医院スタッフ)とディスカッションします。
具体的かつ実用的なアドバイスを返してください。長文すぎず、要点を絞って。

# 対象カウンセリング
- 日付: ${r.date} / カウンセラー: ${r.counselor} / 医院: ${r.facility}
- 相談: ${r.service} / ${r.duration}分 / 成約: ${r.contracted ? 'あり ¥'+Number(r.amount).toLocaleString() : 'なし'}
- 要点メモ: ${r.notes || '(なし)'}
${r.aiTranscript ? '- 文字起こし(抜粋): ' + r.aiTranscript.slice(0,3000) : ''}

# 過去のAI分析サマリー
${(r.aiAdvice||'').slice(0,1500)}

# 競合12医院データ(参考)
${competitorContext}`;

    // 会話履歴をClaude形式に
    const messages = r.aiChat.map(m => ({ role: m.role, content: m.content }));

    const apiRes = await fetch(AI_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: systemPrompt,
        messages
      })
    });
    if (!apiRes.ok) throw new Error('AI失敗 ' + apiRes.status);
    const apiData = await apiRes.json();
    const reply = (apiData.content || []).map(b => b.text || '').join('');

    r.aiChat.push({ role: 'assistant', content: reply });
    renderChatHistory(r);
    status.textContent = '';

    // DB保存 (ai_chat列がない環境ではフォールバック)
    try {
      await sb.from('self_recordings').update({ ai_chat: r.aiChat }).eq('id', id);
    } catch(e) {
      console.warn('ai_chat 列がない可能性。SQL: ALTER TABLE self_recordings ADD COLUMN ai_chat JSONB;', e);
      saveData('rec-chat-' + id, r.aiChat);
    }
  } catch(e) {
    console.error(e);
    status.innerHTML = '<span style="color:#c00">エラー: ' + (e.message || '') + '</span>';
    r.aiChat.pop(); // ユーザーメッセージを巻き戻し
    renderChatHistory(r);
    input.value = userMsg;
  } finally {
    sendBtn.disabled = false;
  }
}

// === AI分析 (Cloudflare Workers経由でClaude呼び出し) ===
const AI_PROXY_URL = 'https://seishokai-ai-proxy.tkm-koike.workers.dev/';

// 競合録音のAI分析モーダル
function openCompetitorAIModal(docId, clinicName, docName) {
  document.getElementById('comp-ai-title').textContent = `競合録音 AI分析: ${clinicName}`;
  document.getElementById('comp-ai-sub').textContent = `資料: ${docName}`;
  document.getElementById('comp-ai-text').value = '';
  document.getElementById('comp-ai-status').textContent = '';
  document.getElementById('comp-ai-result').innerHTML = '';
  document.getElementById('comp-ai-modal').hidden = false;
  document.getElementById('comp-ai-modal').dataset.clinic = clinicName;
}

async function runCompetitorAIAnalysis() {
  const clinicName = document.getElementById('comp-ai-modal').dataset.clinic;
  const text = document.getElementById('comp-ai-text').value.trim();
  if (!text) { alert('文字起こし/要約を貼り付けてください'); return; }
  const btn = document.getElementById('comp-ai-run');
  const status = document.getElementById('comp-ai-status');
  const result = document.getElementById('comp-ai-result');
  btn.disabled = true; btn.textContent = '分析中...';
  status.textContent = 'Claudeで分析中...';
  result.innerHTML = '';

  try {
    // 当該医院の調査データを取得
    const targetClinic = (clinics || []).find(c => c.name === clinicName);
    const targetInfo = targetClinic ? `
■ ${targetClinic.name}
  訪問: ${targetClinic.visitDate} / Dr: ${targetClinic.staff?.dr || '不明'}
  既存評価: 受付${targetClinic.scores?.reception}/カウンセリング${targetClinic.scores?.counseling}/接遇${targetClinic.scores?.hospitality}/環境${targetClinic.scores?.environment}
  既存の強み: ${(targetClinic.strengths||[]).join(' / ')}
  既存の改善点: ${targetClinic.improvements?.counseling || ''}
` : '';

    const prompt = `あなたは清翔会(歯科医院グループ)のカウンセリング戦略コンサルタントです。
競合医院 ${clinicName} のカウンセリング録音の文字起こしを分析し、清翔会が学ぶべきポイントと自院に取り入れるべき施策を抽出してください。

# 既存の競合調査データ
${targetInfo}

# 録音の文字起こし/要約
${text.slice(0, 10000)}

# 出力フォーマット (JSONのみ、説明文不要)
{
  "score": 1-100の整数(競合のカウンセリングの完成度),
  "strengths": ["この医院の強み1","強み2","強み3"],
  "weaknesses": ["弱点・改善余地1","2","3"],
  "adopt": ["清翔会が真似すべき施策1(具体的に)","2","3","4","5"],
  "differentiate": "清翔会が差別化すべきポイント(150文字)",
  "key_phrases": ["印象的だった具体フレーズ1","2","3"]
}`;

    const apiRes = await fetch(AI_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!apiRes.ok) throw new Error('AI API失敗 ' + apiRes.status);
    const apiData = await apiRes.json();
    const rawText = (apiData.content || []).map(b => b.text || '').join('');
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AIの返答を解析できませんでした');
    const parsed = JSON.parse(jsonMatch[0]);

    status.innerHTML = '<span style="color:#0a0">✓ 分析完了</span>';

    result.innerHTML = `
      <div style="padding:14px;background:#fff8e1;border-left:3px solid #f9a825;border-radius:4px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:12px;font-weight:700;color:#b8860b">🤖 AI 分析結果</div>
          <div style="font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:600">${parsed.score||'-'}<span style="font-size:11px;color:var(--text-sub)">/100</span></div>
        </div>
        <div style="margin-bottom:12px">
          <div style="font-size:11px;font-weight:600;color:#0a0;margin-bottom:4px">💪 ${clinicName} の強み</div>
          <ul style="font-size:13px;line-height:1.7;margin:0;padding-left:20px">${(parsed.strengths||[]).map(x=>`<li>${x}</li>`).join('')}</ul>
        </div>
        <div style="margin-bottom:12px">
          <div style="font-size:11px;font-weight:600;color:#c00;margin-bottom:4px">⚠ ${clinicName} の弱点</div>
          <ul style="font-size:13px;line-height:1.7;margin:0;padding-left:20px">${(parsed.weaknesses||[]).map(x=>`<li>${x}</li>`).join('')}</ul>
        </div>
        <div style="margin-bottom:12px;padding:10px;background:#fff;border-radius:6px">
          <div style="font-size:11px;font-weight:600;color:#7c3aed;margin-bottom:4px">✨ 清翔会が真似すべき施策</div>
          <ul style="font-size:13px;line-height:1.7;margin:0;padding-left:20px;font-weight:500">${(parsed.adopt||[]).map(x=>`<li>${x}</li>`).join('')}</ul>
        </div>
        <div style="margin-bottom:12px">
          <div style="font-size:11px;font-weight:600;color:var(--text-sub);margin-bottom:4px">🎯 差別化ポイント</div>
          <div style="font-size:13px;line-height:1.7;padding:8px;background:#fff;border-radius:4px">${parsed.differentiate||''}</div>
        </div>
        ${(parsed.key_phrases||[]).length ? `<div>
          <div style="font-size:11px;font-weight:600;color:var(--text-sub);margin-bottom:4px">💬 印象的なフレーズ</div>
          <ul style="font-size:13px;line-height:1.7;margin:0;padding-left:20px;color:var(--text-sub)">${parsed.key_phrases.map(x=>`<li>"${x}"</li>`).join('')}</ul>
        </div>` : ''}
        <div style="display:flex;gap:6px;margin-top:14px">
          <button class="btn btn-outline" style="font-size:11px;padding:5px 12px" onclick="navigator.clipboard.writeText(document.getElementById('comp-ai-result').innerText);showToast('コピーしました')">📋 結果をコピー</button>
        </div>
      </div>
    `;
    btn.disabled = false; btn.textContent = '🔄 再分析';
  } catch(e) {
    console.error(e);
    status.innerHTML = '<span style="color:#c00">エラー: ' + (e.message || '') + '</span>';
    btn.disabled = false; btn.textContent = '🤖 AI分析する';
  }
}

async function analyzeRecording(id) {
  const r = recordingsCache.find(x => x.id === id);
  if (!r) return;
  const btn = document.getElementById('rec-ai-analyze-btn');
  const status = document.getElementById('rec-ai-status');
  btn.disabled = true;
  btn.textContent = '分析中...';
  status.textContent = '';

  try {
    // 1. 競合データを文脈に
    let competitorContext = '';
    try {
      const cRes = await fetch('data/clinics.json?v=' + Date.now(), { cache: 'no-store' });
      const cData = await cRes.json();
      competitorContext = (cData || []).slice(0, 12).map(c => {
        const sc = c.scores || {};
        const avg = ((sc.reception + sc.counseling + sc.hospitality + sc.environment) / 4).toFixed(1);
        const adopt = (c.suggestions?.adopt || []).join(' / ') || 'なし';
        return `■ ${c.name} (平均${avg}/5)\n  強み: ${(c.strengths||[]).slice(0,3).join(' / ')}\n  改善点: ${c.improvements?.counseling || ''}\n  採用すべき施策: ${adopt}`;
      }).join('\n\n');
    } catch(e) { console.warn('competitor context skip', e); }

    // 2. 録音音声があればまずWhisperで文字起こし (proxyが対応していれば)
    let transcript = r.aiTranscript || '';
    if (!transcript && r.url) {
      status.textContent = '音声を文字起こし中...';
      try {
        // Phase 3: Storage が private 化されたため署名URLで proxy に渡す
        const signedUrl = await getSignedRecordingUrl(r.url);
        const wRes = await fetch(AI_PROXY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcribeUrl: signedUrl || r.url, language: 'ja' })
        });
        if (wRes.ok) {
          const wData = await wRes.json();
          transcript = wData.text || wData.transcript || '';
        }
      } catch(e) { console.warn('transcribe skip', e); }
    }

    // 3. Claude にフィードバック依頼
    status.textContent = 'Claudeで分析中...';
    const prompt = `あなたは清翔会(歯科医院グループ)のカウンセリング指導コーチです。
以下は当院カウンセラーのカウンセリング記録です。競合12医院の調査データと比較しながら、改善点と具体アドバイスを返してください。

# 当院カウンセリング情報
- 日付: ${r.date}
- カウンセラー: ${r.counselor}
- 医院: ${r.facility}
- 患者: ${r.patient || '不明'}
- 相談内容: ${r.service}
- 録音時間: ${r.duration}分
- 成約: ${r.contracted ? 'あり' : 'なし'}
- 成約金額: ${r.amount ? '¥' + Number(r.amount).toLocaleString() : 'なし'}
- 要点メモ: ${r.notes || '(なし)'}
${transcript ? '- 文字起こし:\n' + transcript.slice(0, 8000) : ''}

# 競合医院の調査結果
${competitorContext || '(データ未取得)'}

# 出力フォーマット (JSONのみ、説明文不要)
{
  "score": 1-100の整数,
  "good": ["良かった点1","良かった点2","良かった点3"],
  "improve": ["改善点1","改善点2","改善点3"],
  "advice": "成約率向上のための具体的アドバイス(150-300文字)。競合医院の事例を引用して具体的に。",
  "next_action": "次回までに実行すべき具体的アクション3つを箇条書きで"
}`;

    const apiRes = await fetch(AI_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!apiRes.ok) throw new Error('AI API失敗 ' + apiRes.status);
    const apiData = await apiRes.json();
    const rawText = (apiData.content || []).map(b => b.text || '').join('');
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AIの返答を解析できませんでした');
    const parsed = JSON.parse(jsonMatch[0]);

    // 4. 整形してDB保存
    const adviceText = `【総合スコア】${parsed.score}/100点\n\n【良かった点】\n${(parsed.good||[]).map(x=>'・'+x).join('\n')}\n\n【改善点】\n${(parsed.improve||[]).map(x=>'・'+x).join('\n')}\n\n【アドバイス】\n${parsed.advice||''}\n\n【次回までに】\n${parsed.next_action||''}`;

    await sb.from('self_recordings').update({
      ai_transcript: transcript || null,
      ai_advice: adviceText,
      ai_score: Number(parsed.score) || null
    }).eq('id', id);

    // 5. キャッシュ更新 + モーダル再描画
    r.aiTranscript = transcript;
    r.aiAdvice = adviceText;
    r.aiScore = Number(parsed.score) || null;
    status.innerHTML = '<span style="color:#0a0">✓ 分析完了</span>';
    setTimeout(() => { openRecordingDetail(id); renderRecordings(); }, 500);
  } catch(e) {
    console.error(e);
    status.innerHTML = '<span style="color:#c00">エラー: ' + (e.message || '') + '</span>';
    btn.disabled = false;
    btn.textContent = '🤖 再試行';
  }
}

function updateRecordingStatsOnly() {
  // フィルター適用後のデータで統計＋カウンセラー別だけ再計算（行は触らない）
  const recs = recordingsCache;
  const fc = document.getElementById('rec-filter-counselor')?.value || '';
  const ff = document.getElementById('rec-filter-facility')?.value || '';
  const fk = document.getElementById('rec-filter-contract')?.value || '';
  let filtered = recs.slice();
  if (fc) filtered = filtered.filter(r => r.counselor === fc);
  if (ff) filtered = filtered.filter(r => r.facility === ff);
  if (fk !== '') filtered = filtered.filter(r => String(r.contracted ? 1 : 0) === fk);
  const total = filtered.length;
  const contracted = filtered.filter(r => r.contracted).length;
  const rate = total ? (contracted / total * 100).toFixed(1) : '0.0';
  const totalAmount = filtered.reduce((s, r) => s + Number(r.amount || 0), 0);
  const avgAmount = contracted ? Math.round(totalAmount / contracted) : 0;
  const statsEl = document.getElementById('rec-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="stat-card"><span class="stat-label">件数</span><span class="stat-num">${total}</span></div>
      <div class="stat-card"><span class="stat-label">成約</span><span class="stat-num">${contracted}</span></div>
      <div class="stat-card"><span class="stat-label">成約率</span><span class="stat-num">${rate}%</span></div>
      <div class="stat-card"><span class="stat-label">合計金額</span><span class="stat-num">¥${fmt(totalAmount)}</span></div>
      <div class="stat-card"><span class="stat-label">平均成約額</span><span class="stat-num">¥${fmt(avgAmount)}</span></div>
    `;
  }
  // カウンセラー別
  const byC = {};
  filtered.forEach(r => {
    if (!byC[r.counselor]) byC[r.counselor] = { count: 0, contracted: 0, amount: 0 };
    byC[r.counselor].count++;
    if (r.contracted) byC[r.counselor].contracted++;
    byC[r.counselor].amount += Number(r.amount || 0);
  });
  const cRows = Object.entries(byC).sort((a, b) => b[1].contracted - a[1].contracted).map(([name, d]) => `
    <tr>
      <td style="font-weight:600">${name}</td>
      <td>${d.count}</td>
      <td>${d.contracted}</td>
      <td>${d.count ? (d.contracted / d.count * 100).toFixed(1) : '0.0'}%</td>
      <td>¥${fmt(d.amount)}</td>
      <td>¥${fmt(d.contracted ? Math.round(d.amount / d.contracted) : 0)}</td>
    </tr>`).join('');
  const cTbody = document.querySelector('#rec-counselor-table tbody');
  if (cTbody) cTbody.innerHTML = cRows || '<tr><td colspan="6" style="color:var(--text-muted);text-align:center;padding:12px">データなし</td></tr>';
}

async function renderRecordings() {
  const recs = await fetchRecordings();

  // フィルター値
  const fc = document.getElementById('rec-filter-counselor')?.value || '';
  const ff = document.getElementById('rec-filter-facility')?.value || '';
  const fk = document.getElementById('rec-filter-contract')?.value || '';
  let filtered = recs.slice();
  if (fc) filtered = filtered.filter(r => r.counselor === fc);
  if (ff) filtered = filtered.filter(r => r.facility === ff);
  if (fk !== '') filtered = filtered.filter(r => String(r.contracted ? 1 : 0) === fk);

  // フィルター選択肢
  const counselors = [...new Set(recs.map(r => r.counselor))].sort();
  const facilities = [...new Set(recs.map(r => r.facility))].sort();
  const fcEl = document.getElementById('rec-filter-counselor');
  const ffEl = document.getElementById('rec-filter-facility');
  if (fcEl) fcEl.innerHTML = '<option value="">カウンセラー:全て</option>' + counselors.map(c => `<option ${c===fc?'selected':''}>${c}</option>`).join('');
  if (ffEl) ffEl.innerHTML = '<option value="">医院:全て</option>' + facilities.map(f => `<option ${f===ff?'selected':''}>${f}</option>`).join('');

  // 統計
  const total = filtered.length;
  const contracted = filtered.filter(r => r.contracted).length;
  const rate = total ? (contracted / total * 100).toFixed(1) : '0.0';
  const totalAmount = filtered.reduce((s, r) => s + Number(r.amount || 0), 0);
  const avgAmount = contracted ? Math.round(totalAmount / contracted) : 0;
  document.getElementById('rec-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">件数</span><span class="stat-num">${total}</span></div>
    <div class="stat-card"><span class="stat-label">成約</span><span class="stat-num">${contracted}</span></div>
    <div class="stat-card"><span class="stat-label">成約率</span><span class="stat-num">${rate}%</span></div>
    <div class="stat-card"><span class="stat-label">合計金額</span><span class="stat-num">¥${fmt(totalAmount)}</span></div>
    <div class="stat-card"><span class="stat-label">平均成約額</span><span class="stat-num">¥${fmt(avgAmount)}</span></div>
  `;

  // カウンセラー別
  const byC = {};
  filtered.forEach(r => {
    if (!byC[r.counselor]) byC[r.counselor] = { count: 0, contracted: 0, amount: 0 };
    byC[r.counselor].count++;
    if (r.contracted) byC[r.counselor].contracted++;
    byC[r.counselor].amount += Number(r.amount || 0);
  });
  const cRows = Object.entries(byC).sort((a, b) => b[1].contracted - a[1].contracted).map(([name, d]) => `
    <tr>
      <td style="font-weight:600">${name}</td>
      <td>${d.count}</td>
      <td>${d.contracted}</td>
      <td>${d.count ? (d.contracted / d.count * 100).toFixed(1) : '0.0'}%</td>
      <td>¥${fmt(d.amount)}</td>
      <td>¥${fmt(d.contracted ? Math.round(d.amount / d.contracted) : 0)}</td>
    </tr>`).join('');
  document.querySelector('#rec-counselor-table tbody').innerHTML = cRows || '<tr><td colspan="6" style="color:var(--text-muted);text-align:center;padding:12px">データなし</td></tr>';

  // 一覧
  const listRows = filtered.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(r => `
    <tr>
      <td style="white-space:nowrap;cursor:pointer" onclick="openRecordingDetail(${r.id})">${r.date}</td>
      <td style="cursor:pointer" onclick="openRecordingDetail(${r.id})">${r.counselor}</td>
      <td style="cursor:pointer" onclick="openRecordingDetail(${r.id})">${r.facility}</td>
      <td style="cursor:pointer" onclick="openRecordingDetail(${r.id})">${r.patient || '-'}</td>
      <td style="cursor:pointer" onclick="openRecordingDetail(${r.id})">${r.service}</td>
      <td style="cursor:pointer" onclick="openRecordingDetail(${r.id})">${r.duration ? r.duration + '分' : '-'}</td>
      <td><select class="rec-inline" data-id="${r.id}" data-field="contracted" style="font-size:11px;padding:2px 4px;border-radius:4px;border:1px solid var(--border);${r.contracted?'background:#dcfce7;color:#15803d;font-weight:700':'background:#fff;color:#999'}">
        <option value="0" ${!r.contracted?'selected':''}>未</option>
        <option value="1" ${r.contracted?'selected':''}>成約</option>
      </select></td>
      <td><input type="text" inputmode="numeric" class="rec-inline rec-amt-inline" data-id="${r.id}" data-field="amount" value="${r.amount?Number(r.amount).toLocaleString():''}" placeholder="0" style="font-size:11px;padding:2px 6px;width:90px;text-align:right;border:1px solid var(--border);border-radius:4px;font-variant-numeric:tabular-nums"></td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer" onclick="openRecordingDetail(${r.id})">${(r.notes || '').substring(0, 40)}</td>
      <td style="cursor:pointer" onclick="openRecordingDetail(${r.id})">${r.url ? '🎧' : '-'}</td>
      <td style="cursor:pointer" onclick="openRecordingDetail(${r.id})">${r.aiScore != null ? r.aiScore : '-'}</td>
      <td onclick="deleteRecording(${r.id})" style="cursor:pointer;color:#c00">×</td>
    </tr>`).join('');
  const tbody = document.querySelector('#rec-list-table tbody');
  tbody.innerHTML = listRows || '<tr><td colspan="12" style="color:var(--text-muted);text-align:center;padding:20px">データなし</td></tr>';

  // インラインCRUD
  tbody.querySelectorAll('.rec-inline').forEach(el => {
    if (el.classList.contains('rec-amt-inline')) {
      el.addEventListener('focus', () => { el.value = el.value.replace(/,/g,''); });
      el.addEventListener('blur', () => { const n = Number(el.value.replace(/,/g,'')); el.value = n ? n.toLocaleString() : ''; });
    }
    el.addEventListener('change', async () => {
      const id = Number(el.dataset.id);
      const field = el.dataset.field;
      let value = el.value;
      const dbField = field === 'contracted' ? 'contracted' : 'amount';
      const dbValue = field === 'contracted' ? value === '1' : (Number(String(value).replace(/,/g,'')) || 0);
      try {
        const { error } = await sb.from('self_recordings').update({ [dbField]: dbValue }).eq('id', id);
        if (error) throw error;
        // ローカルキャッシュを更新（再fetchしない）
        const cached = recordingsCache.find(x => x.id === id);
        if (cached) { cached[field] = dbValue; }
        el.style.borderColor = '#0a0';
        if (field === 'contracted') {
          if (dbValue) { el.style.background = '#dcfce7'; el.style.color = '#15803d'; el.style.fontWeight = '700'; }
          else { el.style.background = '#fff'; el.style.color = '#999'; el.style.fontWeight = ''; }
        }
        setTimeout(() => { el.style.borderColor = ''; }, 1000);
        // 統計だけ再計算（一覧は再描画しない＝行フォーカスが消えない）
        updateRecordingStatsOnly();
      } catch(e) {
        console.error(e);
        showToast('保存失敗: ' + (e.message||''), true);
      }
    });
    el.addEventListener('click', e => e.stopPropagation());
  });
}

// === Reviews ===
function getReviews() { return loadData('reviews-data', []); }
function getComments() { return loadData('reviews-comments', []); }

function saveReviewEntry() {
  const month = document.getElementById('rev-month').value;
  const count = Number(document.getElementById('rev-count').value);
  const rating = Number(document.getElementById('rev-rating').value);
  if (!month || !count) return;
  const data = getReviews();
  const existing = data.findIndex(d => d.facility === (reviewsFacility === '全体' ? 'エスカ' : reviewsFacility) && d.month === month);
  const entry = { facility: reviewsFacility === '全体' ? 'エスカ' : reviewsFacility, month, count, rating };
  if (existing >= 0) data[existing] = entry; else data.push(entry);
  saveData('reviews-data', data);
  document.getElementById('rev-count').value = '';
  document.getElementById('rev-rating').value = '';
  renderReviews();
}

function saveComment() {
  const text = document.getElementById('comment-text').value.trim();
  if (!text) return;
  const data = getComments();
  data.push({
    id: Date.now(),
    facility: reviewsFacility === '全体' ? 'エスカ' : reviewsFacility,
    rating: Number(document.getElementById('comment-rating').value),
    text,
    date: new Date().toISOString().split('T')[0]
  });
  saveData('reviews-comments', data);
  document.getElementById('comment-text').value = '';
  renderReviews();
}

function renderReviews() {
  const data = getReviews();
  const comments = getComments();
  const filtered = reviewsFacility === '全体' ? data : data.filter(d => d.facility === reviewsFacility);
  const filteredComments = reviewsFacility === '全体' ? comments : comments.filter(c => c.facility === reviewsFacility);
  const sorted = [...filtered].sort((a, b) => a.month.localeCompare(b.month));

  // Stats
  const latest = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];
  const monthDiff = latest && prev ? latest.count - prev.count : 0;
  document.getElementById('reviews-stats').innerHTML = `
    <div class="stat-card"><span class="stat-num">${latest ? latest.count : 0}</span><span class="stat-label">口コミ数</span></div>
    <div class="stat-card"><span class="stat-num">${latest ? latest.rating.toFixed(1) : '-'}</span><span class="stat-label">評価</span></div>
    <div class="stat-card"><span class="stat-num" style="color:${monthDiff > 0 ? 'var(--green)' : monthDiff < 0 ? 'var(--red)' : 'var(--text)'}">
      ${monthDiff > 0 ? '+' : ''}${monthDiff}</span><span class="stat-label">前月比</span></div>
    <div class="stat-card"><span class="stat-num">${filteredComments.length}</span><span class="stat-label">コメント数</span></div>
  `;

  // Chart (simple CSS bar chart)
  const chartEl = document.getElementById('reviews-chart');
  if (sorted.length === 0) {
    chartEl.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:40px 0">データを入力すると推移グラフが表示されます</p>';
  } else {
    const maxRating = 5;
    chartEl.innerHTML = `
      <div style="display:flex;align-items:flex-end;gap:4px;height:160px;padding:0 4px">
        ${sorted.map(d => {
          const h = (d.rating / maxRating) * 140;
          const color = d.rating >= 4.5 ? '#6366f1' : d.rating >= 4.0 ? '#0ea5e9' : d.rating >= 3.0 ? '#f59e0b' : '#dc2626';
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
            <span style="font-size:11px;font-weight:600">${d.rating.toFixed(1)}</span>
            <div style="width:100%;height:${h}px;background:${color};border-radius:4px 4px 0 0;min-width:20px"></div>
            <span style="font-size:9px;color:var(--text-muted);white-space:nowrap">${d.month.slice(5)}\u6708</span>
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top:12px;display:flex;align-items:flex-end;gap:4px;height:120px;padding:0 4px">
        ${sorted.map((d, i) => {
          const maxCount = Math.max(...sorted.map(s => s.count));
          const h = maxCount > 0 ? (d.count / maxCount) * 100 : 0;
          const diff = i > 0 ? d.count - sorted[i - 1].count : 0;
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
            <span style="font-size:10px;font-weight:600">${d.count}<span style="font-size:9px;color:${diff > 0 ? 'var(--green)' : 'var(--text-muted)'}">${diff > 0 ? '+' + diff : ''}</span></span>
            <div style="width:100%;height:${h}px;background:var(--accent);border-radius:4px 4px 0 0;min-width:20px;opacity:0.7"></div>
            <span style="font-size:9px;color:var(--text-muted)">${d.month.slice(5)}\u6708</span>
          </div>`;
        }).join('')}
      </div>
      <div style="display:flex;gap:16px;margin-top:8px;font-size:11px;color:var(--text-sub)">
        <span>上: 評価推移</span><span>下: 口コミ数推移</span>
      </div>
    `;
  }

  // Comments
  const commentsEl = document.getElementById('comments-list');
  const sortedComments = [...filteredComments].sort((a, b) => b.date.localeCompare(a.date));
  commentsEl.innerHTML = sortedComments.map(c => {
    const stars = '★'.repeat(c.rating) + '☆'.repeat(5 - c.rating);
    return `<div style="padding:12px;margin-bottom:8px;background:var(--bg);border-radius:var(--radius-sm);border:1px solid var(--border-light)">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="color:#f59e0b;font-size:13px">${stars}</span>
        <span style="font-size:11px;color:var(--text-muted)">${c.date}${reviewsFacility === '全体' ? ' · ' + c.facility : ''}</span>
      </div>
      <p style="font-size:13px;line-height:1.5">${c.text}</p>
    </div>`;
  }).join('') || '<p style="color:var(--text-muted);font-size:13px">コメントなし</p>';

  // Table
  const tbody = document.getElementById('reviews-tbody');
  const reversed = [...sorted].reverse();
  tbody.innerHTML = reversed.map((d, i) => {
    const prev = reversed[i + 1];
    const diff = prev ? d.count - prev.count : 0;
    const diffStr = diff > 0 ? `<span style="color:var(--green)">+${diff}</span>` : diff < 0 ? `<span style="color:var(--red)">${diff}</span>` : '-';
    return `<tr>
      <td>${d.month}${reviewsFacility === '全体' ? ` <span style="color:var(--text-muted)">${d.facility}</span>` : ''}</td>
      <td>${d.count}</td><td>${diffStr}</td><td>${d.rating.toFixed(1)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';
}

// =========================================
// パラ管理 (歯科金属スクラップ回収)
// =========================================
const PARA_PASSCODE = 'para';
const PARA_CLINICS = ['BF銀座','エスカ','アール','ウィズ','ルミナス','茶屋','知立','小牧','八事','大森','京都'];
let paraRecordsCache = {}; // key: year_month+'|'+clinic_name → record
let paraSaveTimers = {}; // debounce per cell

function currentYear() { return new Date().getFullYear(); }
function ymKey(y, m) { return `${y}-${String(m).padStart(2,'0')}`; }

async function loadParaYear(year) {
  try {
    const start = `${year}-01`;
    const end = `${year}-12`;
    const { data, error } = await sb.from('para_records').select('*').gte('year_month', start).lte('year_month', end);
    if (error) throw error;
    // 該当年のキャッシュだけリセット
    for (const k of Object.keys(paraRecordsCache)) {
      if (k.startsWith(String(year) + '-')) delete paraRecordsCache[k];
    }
    (data || []).forEach(r => { paraRecordsCache[r.year_month + '|' + r.clinic_name] = r; });
    return data || [];
  } catch(e) {
    console.warn('loadParaYear failed', e);
    showToast && showToast('データ読込失敗: ' + (e.message || e));
    return [];
  }
}

// 後方互換 (外注画面などが呼ぶ可能性)
async function loadParaRecords(ym) {
  const [y] = ym.split('-');
  return loadParaYear(Number(y));
}

async function saveParaCell(clinic, ym, patch) {
  const payload = { year_month: ym, clinic_name: clinic, ...patch };
  if (payload.collected_date === '') payload.collected_date = null;
  if (payload.grams === '' || payload.grams == null) payload.grams = null;
  else payload.grams = Number(payload.grams);
  if (payload.memo === undefined) payload.memo = null;
  const res = await safeSave({ type:'upsert', table:'para_records', payload, options:{ onConflict:'year_month,clinic_name' } });
  if (res.ok) {
    paraRecordsCache[ym + '|' + clinic] = { ...(paraRecordsCache[ym + '|' + clinic] || {}), ...payload };
    updateParaTotals();
  } else {
    showToast && showToast('保存失敗 (キューに登録)');
  }
}

function scheduleParaSave(clinic, ym, patch) {
  const key = clinic + '|' + ym;
  clearTimeout(paraSaveTimers[key]);
  paraSaveTimers[key] = setTimeout(() => { saveParaCell(clinic, ym, patch); }, 500);
}

function updateParaTotals() {
  const tbody = document.getElementById('para-tbody');
  const tfoot = document.getElementById('para-tfoot');
  if (!tbody || !tfoot) return;
  const yearEl = document.getElementById('para-year');
  const year = Number(yearEl?.value || currentYear());
  // 各行の合計
  let grand = 0;
  const monthSums = Array(13).fill(0); // index 1-12
  PARA_CLINICS.forEach(c => {
    let row = 0;
    for (let m = 1; m <= 12; m++) {
      const r = paraRecordsCache[ymKey(year,m) + '|' + c];
      const g = r?.grams;
      if (g != null && !isNaN(Number(g))) {
        row += Number(g);
        monthSums[m] += Number(g);
        grand += Number(g);
      }
    }
    const el = tbody.querySelector(`tr[data-clinic="${c}"] .para-row-total`);
    if (el) el.textContent = row ? (Math.round(row*100)/100).toLocaleString() : '';
  });
  for (let m = 1; m <= 12; m++) {
    const el = tfoot.querySelector(`.para-col-total[data-m="${m}"]`);
    if (el) el.textContent = monthSums[m] ? (Math.round(monthSums[m]*100)/100).toLocaleString() : '';
  }
  const totalEl = document.getElementById('para-total');
  if (totalEl) totalEl.textContent = (Math.round(grand*100)/100).toLocaleString();
}

async function renderPara() {
  const yearEl = document.getElementById('para-year');
  if (!yearEl) { console.warn('para-year element not found'); return; }
  if (!yearEl.value) yearEl.value = String(currentYear());
  initParaControls();
  const year = Number(yearEl.value) || currentYear();
  yearEl.value = String(year);
  console.debug('renderPara year=', year);
  const thead = document.getElementById('para-thead');
  const tbody = document.getElementById('para-tbody');
  const tfoot = document.getElementById('para-tfoot');
  // ヘッダー (医院 | 1月 ... 12月 | 合計)
  thead.innerHTML = `<tr>
    <th style="width:90px;text-align:left;position:sticky;left:0;background:var(--card);z-index:2">医院</th>
    ${Array.from({length:12},(_,i)=>`<th style="width:72px;text-align:center">${i+1}月</th>`).join('')}
    <th style="width:80px;text-align:right">合計(g)</th>
  </tr>`;
  tbody.innerHTML = `<tr><td colspan="14" style="text-align:center;color:var(--text-muted);padding:20px">読込中...</td></tr>`;
  await loadParaYear(year);
  // 本体
  tbody.innerHTML = PARA_CLINICS.map(c => {
    const memoAny = (() => {
      // 年間で最新のメモを表示用に1つ拾う (なくても可)
      for (let m = 12; m >= 1; m--) { const r = paraRecordsCache[ymKey(year,m)+'|'+c]; if (r?.memo) return r.memo; }
      return '';
    })();
    const cells = [];
    for (let m = 1; m <= 12; m++) {
      const ym = ymKey(year, m);
      const r = paraRecordsCache[ym + '|' + c] || {};
      const grams = r.grams != null ? r.grams : '';
      const date = r.collected_date || '';
      const md = date ? date.substring(5).replace('-','/') : '';
      cells.push(`<td style="padding:2px" data-clinic="${c}" data-ym="${ym}">
        <input type="number" step="0.01" class="para-grams" value="${grams}" placeholder="g" style="width:100%;padding:3px 4px;font-size:11px;text-align:right;border:1px solid var(--border);border-radius:3px;box-sizing:border-box">
        <input type="text" class="para-mmdd" value="${md}" placeholder="M/D" maxlength="5" style="width:100%;padding:2px 4px;margin-top:2px;font-size:10px;text-align:center;border:1px solid var(--border);border-radius:3px;box-sizing:border-box;color:var(--text-sub)">
      </td>`);
    }
    return `<tr data-clinic="${esc(c)}">
      <td style="font-weight:600;position:sticky;left:0;background:var(--card);z-index:1;cursor:pointer" class="para-clinic-cell" title="クリックでメモ編集: ${esc(memoAny)}">${esc(c)}${memoAny?' 📝':''}</td>
      ${cells.join('')}
      <td class="para-row-total" style="text-align:right;font-weight:600;color:var(--text-sub)"></td>
    </tr>`;
  }).join('');
  // フッター (各月合計)
  tfoot.innerHTML = `<tr style="background:var(--bg)">
    <th style="text-align:left;position:sticky;left:0;background:var(--bg)">月合計</th>
    ${Array.from({length:12},(_,i)=>`<td class="para-col-total" data-m="${i+1}" style="text-align:right;font-weight:600;font-size:11px;padding:6px 4px"></td>`).join('')}
    <td style="text-align:right;font-weight:700"><span id="para-total-foot"></span></td>
  </tr>`;
  // リスナー: grams / mmdd → debounced 保存
  tbody.querySelectorAll('td[data-clinic][data-ym]').forEach(td => {
    const clinic = td.dataset.clinic;
    const ym = td.dataset.ym;
    const gInp = td.querySelector('.para-grams');
    const dInp = td.querySelector('.para-mmdd');
    gInp.addEventListener('input', () => {
      updateParaTotals();
      scheduleParaSave(clinic, ym, { grams: gInp.value });
      gInp.style.background = '#fef3c7';
      setTimeout(() => { gInp.style.background = ''; }, 600);
    });
    dInp.addEventListener('change', () => {
      const v = dInp.value.trim();
      let iso = null;
      const m = v.match(/^(\d{1,2})[\/\-\.](\d{1,2})$/);
      if (m) {
        const [_, mm, dd] = m;
        const y = ym.split('-')[0];
        iso = `${y}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
        dInp.value = `${mm}/${dd}`;
      } else if (!v) { iso = null; }
      else { dInp.value = ''; return; }
      scheduleParaSave(clinic, ym, { collected_date: iso });
    });
  });
  // 医院名クリック → メモ編集モーダル
  tbody.querySelectorAll('.para-clinic-cell').forEach(cell => {
    cell.addEventListener('click', () => openParaMemoModal(cell.closest('tr').dataset.clinic, year));
  });
  updateParaTotals();
  // 外注URL表示
  const urlEl = document.getElementById('para-ext-url');
  if (urlEl) urlEl.textContent = location.origin + location.pathname + '?view=para';
}

function openParaMemoModal(clinic, year) {
  // 既存のモーダルを再利用せず、軽量なオーバーレイを作る
  const monthsOpts = Array.from({length:12},(_,i)=>{
    const ym = ymKey(year, i+1);
    const r = paraRecordsCache[ym + '|' + clinic] || {};
    return `<div style="margin-bottom:8px">
      <label style="font-size:11px;color:var(--text-sub);display:block;margin-bottom:2px">${i+1}月 メモ</label>
      <input type="text" class="para-memo-input" data-ym="${esc(ym)}" value="${esc(r.memo||'')}" style="width:100%;padding:6px;font-size:12px;border:1px solid var(--border);border-radius:4px;box-sizing:border-box">
    </div>`;
  }).join('');
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:center;justify-content:center';
  ov.innerHTML = `<div style="background:#fff;max-width:480px;width:90%;max-height:80vh;overflow-y:auto;padding:20px;border-radius:8px">
    <div style="font-size:14px;font-weight:700;margin-bottom:12px">${esc(clinic)} - ${esc(year)}年 月別メモ</div>
    ${monthsOpts}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
      <button id="para-memo-cancel" class="btn btn-outline" style="padding:6px 16px">閉じる</button>
      <button id="para-memo-save" class="btn btn-dark" style="padding:6px 16px">保存</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#para-memo-cancel').onclick = () => ov.remove();
  ov.querySelector('#para-memo-save').onclick = async () => {
    const inputs = ov.querySelectorAll('.para-memo-input');
    for (const inp of inputs) {
      const ym = inp.dataset.ym;
      const cur = paraRecordsCache[ym + '|' + clinic]?.memo || '';
      if (inp.value !== cur) {
        await saveParaCell(clinic, ym, { memo: inp.value });
      }
    }
    ov.remove();
    renderPara();
  };
}

function initParaControls() {
  const yearEl = document.getElementById('para-year');
  if (!yearEl || yearEl.dataset.bound) return;
  yearEl.dataset.bound = '1';
  if (!yearEl.value) yearEl.value = currentYear();
  yearEl.addEventListener('change', () => renderPara());
  const prevBtn = document.getElementById('para-year-prev');
  const nextBtn = document.getElementById('para-year-next');
  if (prevBtn) prevBtn.addEventListener('click', () => { yearEl.value = Number(yearEl.value || currentYear()) - 1; renderPara(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { yearEl.value = Number(yearEl.value || currentYear()) + 1; renderPara(); });
  const csvBtn = document.getElementById('para-csv');
  if (csvBtn) csvBtn.addEventListener('click', () => {
    const year = Number(yearEl.value);
    const rows = [['医院', ...Array.from({length:12},(_,i)=>`${i+1}月(g)`), '合計(g)']];
    PARA_CLINICS.forEach(c => {
      const row = [c];
      let sum = 0;
      for (let m = 1; m <= 12; m++) {
        const r = paraRecordsCache[ymKey(year,m) + '|' + c] || {};
        const g = r.grams;
        row.push(g != null ? g : '');
        if (g != null) sum += Number(g);
      }
      row.push(sum || '');
      rows.push(row);
    });
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type:'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `para_${year}.csv`;
    a.click();
  });
}

// 外注アクセス (?view=para) — ヘッダー他タブ全非表示で UI のみ表示
function initParaExternal() {
  const loginScreen = document.getElementById('login-screen');
  if (loginScreen) loginScreen.style.display = 'none';

  const showUI = () => {
    // 通常 app を完全に削除 (ID衝突を防ぐ: para-year 等が両方あるとgetElementByIdがadmin側を返してしまう)
    const app = document.getElementById('app');
    if (app) app.remove();
    // ログイン画面も削除
    const login = document.getElementById('login-screen');
    if (login) login.remove();
    let wrap = document.getElementById('para-ext-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'para-ext-wrap';
      wrap.style.cssText = 'max-width:900px;margin:0 auto;padding:20px;font-family:inherit';
      wrap.style.cssText = 'max-width:1200px;margin:0 auto;padding:20px;font-family:inherit';
      wrap.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #111">
          <div style="font-size:14px;font-weight:800;letter-spacing:2px">SEISHOKAI / パラ管理 (外注)</div>
        </div>
        <div class="card" style="margin-bottom:16px;padding:16px;border:1px solid #e0e0e0;border-radius:8px;background:#fff">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
            <label style="font-size:12px;font-weight:600">対象年</label>
            <button id="para-year-prev" style="padding:6px 10px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer" title="前年">◀</button>
            <input type="number" id="para-year" min="2020" max="2099" step="1" style="width:90px;padding:6px 10px;font-size:13px;text-align:center;border:1px solid #ccc;border-radius:4px">
            <button id="para-year-next" style="padding:6px 10px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer" title="翌年">▶</button>
            <button id="para-csv" style="padding:6px 14px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer">CSVエクスポート</button>
            <div style="flex:1"></div>
            <div style="font-size:13px;color:#666">年間合計: <strong id="para-total" style="color:#111;font-size:15px">0</strong> g</div>
          </div>
          <div style="overflow-x:auto"><table id="para-year-table" style="width:100%;border-collapse:collapse;font-size:12px;min-width:1100px">
            <thead id="para-thead"></thead>
            <tbody id="para-tbody"></tbody>
            <tfoot id="para-tfoot"></tfoot>
          </table></div>
          <div style="font-size:10px;color:#999;margin-top:6px">※ 上段=グラム(g) / 下段=回収日(M/D) 自動保存。メモは医院名クリックで編集</div>
        </div>
        <div style="font-size:11px;color:#999">保存はリアルタイムで医院側と同期されます</div>
      `;
      document.body.appendChild(wrap);
    }
    // CSVボタンは非表示 (外注モードでは入力専用)
    try { setupRealtime(); } catch(_){}
    renderPara();
  };

  // 既にセッション済みなら直行
  if (sessionStorage.getItem('paraExtPassed') === 'true') { showUI(); return; }

  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;font-family:inherit;padding:20px';
  ov.innerHTML = `
    <div style="font-size:13px;font-weight:700;letter-spacing:3px;color:#111;margin-bottom:8px">SEISHOKAI / パラ管理</div>
    <div style="font-size:11px;color:#999;letter-spacing:1.5px;text-transform:uppercase">Enter Password</div>
    <input id="para-pass-input" type="password" autocomplete="off"
      style="width:280px;text-align:center;font-size:16px;letter-spacing:2px;padding:14px;border:2px solid #111;border-radius:8px;outline:none;font-family:inherit">
    <div id="para-pass-err" style="font-size:11px;color:#c00;min-height:14px"></div>
    <button id="para-pass-btn" style="border:2px solid #111;background:#111;color:#fff;padding:10px 40px;font-size:13px;font-weight:700;border-radius:6px;cursor:pointer;font-family:inherit;letter-spacing:2px">LOGIN</button>
  `;
  document.body.appendChild(ov);
  const input = ov.querySelector('#para-pass-input');
  const err = ov.querySelector('#para-pass-err');
  const btn = ov.querySelector('#para-pass-btn');
  input.focus();
  const submit = () => {
    if (input.value === PARA_PASSCODE) {
      sessionStorage.setItem('paraExtPassed', 'true');
      ov.remove();
      showUI();
    } else {
      err.textContent = 'パスワードが違います';
      input.value = '';
      input.focus();
    }
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

// ══════════════════════════════════════════════════════════════════════
// Phase 4: 代理店 Auth 一括移行ツール (管理タブ → Auth移行)
// ══════════════════════════════════════════════════════════════════════
function genRandomPassword(len) {
  // 紛らわしい文字 (0/O/1/l/I) を除外した可読パスワード生成
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  let pw = '';
  try {
    const array = new Uint32Array(len);
    crypto.getRandomValues(array);
    for (let i = 0; i < len; i++) pw += chars[array[i] % chars.length];
  } catch(_) {
    for (let i = 0; i < len; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

// Phase 6: 権限管理 UI (admin / staff_promo / agency)
// 一覧 + 編集 + 削除 + 新規発行 (UUID リンク型) を提供
const ROLE_LABELS = {
  admin: 'admin (全権)',
  staff_promo: 'staff_promo (担当プロモ)',
  agency: 'agency (代理店・自社プロモのみ)'
};

function _roleBadge(role) {
  const color = role === 'admin' ? '#7c3aed' : role === 'staff_promo' ? '#0369a1' : '#d97706';
  const bg    = role === 'admin' ? '#ede9fe' : role === 'staff_promo' ? '#e0f2fe' : '#fef3c7';
  return `<span style="background:${bg};color:${color};padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600">${escapeHtml(role || '-')}</span>`;
}

// Worker API ヘルパー (admin JWT 必須)
async function callAuthAdminWorker(path, body) {
  const jwt = await getCurrentAuthJwt();
  if (!jwt) return { ok: false, error: '認証セッションがありません。メールで再ログインしてください。' };
  let res;
  try {
    res = await fetch(AUTH_ADMIN_URL + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + jwt,
      },
      body: JSON.stringify(body || {}),
    });
  } catch (e) {
    return { ok: false, error: 'Worker に接続できません: ' + (e.message || e), networkError: true };
  }
  let j = null;
  try { j = await res.json(); } catch(_) {}
  if (!j) return { ok: false, error: 'Worker 応答が不正です (status=' + res.status + ')', networkError: res.status >= 500 || res.status === 404 };
  return j;
}

// クリップボードコピー (失敗時は無視)
async function _copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return true;
  } catch (_) { return false; }
}

// アカウント発行成功モーダル (テキスト選択可能・ワンクリックコピー)
function _showCredModal(info) {
  const existing = document.getElementById('_cred-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = '_cred-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:24px;max-width:520px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.3);">
      <div style="font-size:18px;font-weight:700;margin-bottom:12px;color:#059669">✅ アカウント発行完了</div>
      <textarea id="_cred-modal-ta" readonly style="width:100%;min-height:120px;font-family:monospace;font-size:13px;padding:12px;border:1px solid #d1d5db;border-radius:8px;resize:vertical;box-sizing:border-box;line-height:1.6;background:#f9fafb">${escapeHtml(info)}</textarea>
      <div style="font-size:12px;color:#6b7280;margin-top:8px">※ 上のテキストは直接選択・コピー可能です。すでにクリップボードにもコピー済みです。</div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <button id="_cred-modal-copy" style="padding:8px 16px;background:#4f46e5;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px">📋 再コピー</button>
        <button id="_cred-modal-close" style="padding:8px 16px;background:#111;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px">閉じる</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const ta = modal.querySelector('#_cred-modal-ta');
  setTimeout(() => { ta.focus(); ta.select(); }, 50);
  modal.querySelector('#_cred-modal-copy').addEventListener('click', async () => {
    ta.select();
    const ok = await _copyToClipboard(info);
    const btn = modal.querySelector('#_cred-modal-copy');
    btn.textContent = ok ? '✅ コピーしました' : '⚠️ 手動選択してください';
    setTimeout(() => { btn.textContent = '📋 再コピー'; }, 1600);
  });
  const closeBtn = modal.querySelector('#_cred-modal-close');
  const close = () => modal.remove();
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', function esc(e){ if (e.key==='Escape'){ close(); document.removeEventListener('keydown', esc); } });
}

// Phase 8: タブ定義
const AUTH_TAB_DEFS = [
  { key: 'bookings', label: '予約' },
  { key: 'kaiin',    label: '来院' },
  { key: 'tc',       label: 'TC' },
  { key: 'sales',    label: '売上' },
  { key: 'adbudget', label: '広告' },
  { key: 'admin',    label: '管理' },
];
function _defaultTabsForRole(role) {
  if (role === 'admin')       return { bookings:true, kaiin:true,  tc:true,  sales:true,  adbudget:true,  admin:true  };
  if (role === 'staff_promo') return { bookings:true, kaiin:true,  tc:false, sales:false, adbudget:false, admin:false };
  return                             { bookings:true, kaiin:false, tc:false, sales:false, adbudget:false, admin:false };
}
function _tabsToBadges(vt) {
  if (!vt || typeof vt !== 'object') return '<span style="color:var(--text-muted);font-size:11px">-</span>';
  return AUTH_TAB_DEFS
    .filter(t => vt[t.key] === true)
    .map(t => `<code style="background:#eef2ff;color:#3730a3;padding:1px 5px;border-radius:3px;font-size:10px;margin-right:3px">${t.label}</code>`)
    .join('') || '<span style="color:var(--text-muted);font-size:11px">なし</span>';
}
function _readTabsFromCheckboxes(root, prefix) {
  const result = {};
  AUTH_TAB_DEFS.forEach(t => {
    const el = root.querySelector(`.${prefix}[data-tab="${t.key}"]`);
    result[t.key] = !!(el && el.checked);
  });
  return result;
}
function _setTabsOnCheckboxes(root, prefix, tabs) {
  AUTH_TAB_DEFS.forEach(t => {
    const el = root.querySelector(`.${prefix}[data-tab="${t.key}"]`);
    if (el) el.checked = !!(tabs && tabs[t.key]);
  });
}

// Phase 9: プロモ一覧からプレフィックスグループを抽出 (2件以上のものだけ)
// 例: ['hikaru_a','hikaru_b','bin_x'] → { hikaru: 2, bin: 1 } → [['hikaru',2]]
function _computePromoPrefixGroups(allPromos) {
  const counts = Object.create(null);
  (allPromos || []).forEach(s => {
    if (!s || typeof s !== 'string') return;
    const idx = s.indexOf('_');
    if (idx <= 0) return;
    const p = s.slice(0, idx);
    counts[p] = (counts[p] || 0) + 1;
  });
  return Object.keys(counts)
    .filter(p => counts[p] >= 2)
    .sort()
    .map(p => ({ prefix: p, count: counts[p] }));
}

// Phase 9: グループバー HTML (プレフィックスボタン + プレビュー行)
function _renderPromoGroupBarHtml(groups, idPrefix) {
  if (!groups || !groups.length) return '';
  const btns = groups.map(g => (
    `<button type="button" class="${idPrefix}-promo-group-btn" data-prefix="${escapeHtml(g.prefix)}"
       style="font-size:11px;padding:3px 10px;border:1px solid var(--border);border-radius:12px;background:#fff;cursor:pointer;white-space:nowrap">
       ${escapeHtml(g.prefix)}_* (${g.count}件)
     </button>`
  )).join('');
  return `
    <div style="margin:6px 0 8px 0;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <strong style="font-size:11px;color:var(--text-sub);margin-right:2px">グループ:</strong>
      ${btns}
      <span style="font-size:10px;color:var(--text-muted)">※ 押すと "prefix_%" パターンを追加 (新プロモも自動で含む)</span>
    </div>
    <div class="${idPrefix}-promo-preview" style="margin:4px 0 6px 0;font-size:11px;color:var(--text-sub);min-height:14px"></div>
  `;
}

// Phase 9: グループボタン + チェックボックスのイベントを配線
// activePatterns: Set<string> (例: {"hikaru_%"}) - 呼び出し側で保持する状態オブジェクト
// listEl: チェックボックスを含むコンテナ (data-wildcard で % 全許可モード管理)
function _wirePromoGroupBar(rootEl, idPrefix, listEl, activePatterns) {
  const updatePreview = () => {
    const preview = rootEl.querySelector(`.${idPrefix}-promo-preview`);
    if (!preview) return;
    const chks = Array.from(listEl.querySelectorAll(`.${idPrefix}-promo-chk:checked`))
      .map(c => c.value)
      .filter(v => {
        // パターンでカバーされる個別値は個別表示から外す
        for (const pat of activePatterns) {
          if (pat.endsWith('_%') && v.startsWith(pat.slice(0, -1))) return false;
        }
        return true;
      });
    const parts = [];
    if (activePatterns.size) parts.push([...activePatterns].map(p => `<code style="background:#dbeafe;color:#1e3a8a;padding:1px 4px;border-radius:3px">${escapeHtml(p)}</code>`).join(' '));
    if (chks.length) parts.push(chks.length + '件の個別プロモ');
    preview.innerHTML = parts.length ? ('選択中: ' + parts.join(' + ')) : '<span style="color:var(--text-muted)">未選択</span>';
  };

  // 既存の activePatterns に応じてグループボタンと個別チェックをハイライト
  const applyPatternVisual = (prefix, on) => {
    const btn = rootEl.querySelector(`.${idPrefix}-promo-group-btn[data-prefix="${CSS.escape(prefix)}"]`);
    if (btn) {
      btn.style.background = on ? '#dbeafe' : '#fff';
      btn.style.borderColor = on ? '#3b82f6' : 'var(--border)';
      btn.style.color = on ? '#1e3a8a' : '';
      btn.style.fontWeight = on ? '600' : '';
    }
    // 対応する個別チェックもまとめて ON/OFF (視覚的に分かりやすく)
    listEl.querySelectorAll(`.${idPrefix}-promo-chk`).forEach(chk => {
      const v = chk.value || '';
      if (v.startsWith(prefix + '_')) {
        chk.checked = on ? true : chk.checked;
      }
    });
  };

  // 初期状態を復元: activePatterns に入っているプレフィックスのボタン/チェックを ON に
  [...activePatterns].forEach(pat => {
    if (pat.endsWith('_%')) {
      const prefix = pat.slice(0, -2);
      applyPatternVisual(prefix, true);
    }
  });

  // グループボタンクリック: パターンの add/remove
  rootEl.querySelectorAll(`.${idPrefix}-promo-group-btn`).forEach(btn => {
    btn.addEventListener('click', () => {
      const prefix = btn.dataset.prefix;
      const pattern = prefix + '_%';
      if (activePatterns.has(pattern)) {
        activePatterns.delete(pattern);
        applyPatternVisual(prefix, false);
      } else {
        activePatterns.add(pattern);
        applyPatternVisual(prefix, true);
      }
      updatePreview();
    });
  });

  // チェックボックス変更時もプレビュー更新
  listEl.querySelectorAll(`.${idPrefix}-promo-chk`).forEach(chk => {
    chk.addEventListener('change', updatePreview);
  });

  updatePreview();
  return { updatePreview, applyPatternVisual };
}

// Phase 9: 保存値を整形 (パターン + 個別チェックをユニーク化、パターンでカバーされる個別値は除外)
function _composePromoList(activePatterns, checkedValues) {
  const result = new Set();
  activePatterns.forEach(p => result.add(p));
  (checkedValues || []).forEach(v => {
    if (!v) return;
    let covered = false;
    for (const pat of activePatterns) {
      if (pat.endsWith('_%') && v.startsWith(pat.slice(0, -1))) { covered = true; break; }
    }
    if (!covered) result.add(v);
  });
  return [...result];
}

async function renderAuthMigration() {
  const container = document.getElementById('auth-migration-container');
  if (!container) return;
  container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-sub)">読み込み中...</div>';

  const { data, error } = await sb.rpc('admin_list_accounts_for_migration');
  if (error) {
    container.innerHTML = '<div style="padding:20px;color:#c00">エラー: ' + escapeHtml(error.message || String(error)) + '</div>';
    return;
  }
  const rows = Array.isArray(data) ? data : [];
  const total = rows.length;
  const adminCount = rows.filter(a => a.role === 'admin').length;
  const staffCount = rows.filter(a => a.role === 'staff_promo').length;
  const agencyCount = rows.filter(a => a.role === 'agency').length;

  // Worker 稼働確認 (非同期で並行チェック、初期表示後に反映)
  const workerAvailable = await isAuthAdminWorkerAvailable();

  // 既存のプロモ source 一覧 (新規発行フォームで使用)
  const allPromos = [...new Set((bookingsData || []).map(d => d && d.source).filter(Boolean))].sort();
  const promoGroups = _computePromoPrefixGroups(allPromos);
  const groupBarHtml = _renderPromoGroupBarHtml(promoGroups, 'new-acct');

  const tableRows = rows.map(a => {
    const promos = Array.isArray(a.allowed_promos) ? a.allowed_promos : [];
    const promoStr = promos.length ? promos.map(p => `<code style="background:#f3f4f6;padding:1px 5px;border-radius:3px;font-size:10px;margin-right:3px">${escapeHtml(p)}</code>`).join('') : '<span style="color:var(--text-muted);font-size:11px">-</span>';
    const tabsStr = (a.role === 'admin') ? '<span style="color:#059669;font-size:10px">全表示</span>' : _tabsToBadges(a.visible_tabs);
    const linked = a.supabase_user_id
      ? `<span style="color:#059669;font-size:11px">🔗 ${a.migrated_at ? new Date(a.migrated_at).toLocaleDateString() : '済'}</span>`
      : '<span style="color:#d97706;font-size:11px">未連携</span>';
    const resetBtn = (workerAvailable && a.supabase_user_id)
      ? `<button class="btn btn-outline btn-acct-reset" data-id="${a.id}" data-uid="${escapeHtml(a.supabase_user_id)}" data-name="${escapeHtml(a.name || '')}" style="padding:3px 8px;font-size:10px;margin-right:3px">🔑 PW再発行</button>`
      : '';
    const deleteBtn = a.role === 'admin'
      ? '<span style="font-size:10px;color:var(--text-muted)">保護</span>'
      : `<button class="btn btn-outline btn-acct-delete" data-id="${a.id}" data-uid="${escapeHtml(a.supabase_user_id || '')}" data-name="${escapeHtml(a.name || '')}" style="padding:3px 8px;font-size:10px;color:#c00;border-color:#fecaca">🗑 削除</button>`;
    // 共有URL (admin以外)
    const LOGIN_URL = 'https://seishokai.github.io/clinic-analysis/?login';
    const shareCell = (a.role === 'admin')
      ? '<span style="font-size:10px;color:var(--text-muted)">-</span>'
      : `<button class="btn btn-outline btn-acct-share" data-email="${escapeHtml(a.email||'')}" data-url="${LOGIN_URL}" style="padding:3px 8px;font-size:10px;white-space:nowrap" title="ログインURL＋メールをコピー">🔗 URLコピー</button>`;
    return `<tr>
      <td>${a.id}</td>
      <td>${escapeHtml(a.name || '')}</td>
      <td>${_roleBadge(a.role)}</td>
      <td>${escapeHtml(a.agency || '')}</td>
      <td style="font-size:11px">${escapeHtml(a.email || '-')}</td>
      <td>${promoStr}</td>
      <td>${tabsStr}</td>
      <td>${linked}</td>
      <td>${shareCell}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-outline btn-acct-edit" data-id="${a.id}"
          data-name="${escapeHtml(a.name || '')}"
          data-role="${escapeHtml(a.role || '')}"
          data-agency="${escapeHtml(a.agency || '')}"
          data-promos="${escapeHtml(JSON.stringify(promos))}"
          data-tabs="${escapeHtml(JSON.stringify(a.visible_tabs || _defaultTabsForRole(a.role)))}"
          style="padding:3px 8px;font-size:10px;margin-right:3px">✏ 編集</button>
        ${resetBtn}
        ${deleteBtn}
      </td>
    </tr>`;
  }).join('');

  // 発行フォーム: Worker 稼働中なら 1クリック式 / 未デプロイなら旧 UUID 入力式
  const issueFormHtml = workerAvailable ? `
    <div class="card" style="padding:16px">
      <h3 style="margin-top:0;margin-bottom:8px">➕ 新規アカウント発行 <span style="color:#059669;font-size:11px;font-weight:400">(1クリック発行モード)</span></h3>
      <div style="font-size:12px;color:var(--text-sub);margin-bottom:12px;line-height:1.6">
        名前・ロール・代理店名を入力するだけで、メアド・パスワードを自動生成して発行します。<br>
        メアドを空にすると <code>partner-{名前}-{時刻}@seishokai.local</code> 形式で自動生成されます。
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:10px">
        <div>
          <label class="form-label" style="font-size:11px">名前 <span style="color:#c00">*</span></label>
          <input type="text" class="form-input" id="new-acct-name" placeholder="例: 小池 隆史" style="font-size:13px;padding:6px 10px">
        </div>
        <div>
          <label class="form-label" style="font-size:11px">メール (任意、空なら自動生成)</label>
          <input type="email" class="form-input" id="new-acct-email" placeholder="例: taro@example.com" style="font-size:13px;padding:6px 10px">
        </div>
        <div>
          <label class="form-label" style="font-size:11px">ロール <span style="color:#c00">*</span></label>
          <select class="form-select" id="new-acct-role" style="font-size:13px;padding:6px 10px">
            <option value="agency">agency (代理店)</option>
            <option value="staff_promo">staff_promo (社員プロモ)</option>
            <option value="admin">admin (全権)</option>
          </select>
        </div>
        <div>
          <label class="form-label" style="font-size:11px">代理店名 (任意)</label>
          <input type="text" class="form-input" id="new-acct-agency" placeholder="例: ヒカル" style="font-size:13px;padding:6px 10px">
        </div>
        <div style="grid-column:1/-1">
          <label class="form-label" style="font-size:11px">担当プロモ
            <button type="button" id="new-acct-promos-all" class="btn btn-outline" style="font-size:10px;padding:1px 6px;margin-left:8px">全選択</button>
            <button type="button" id="new-acct-promos-none" class="btn btn-outline" style="font-size:10px;padding:1px 6px">全解除</button>
            <button type="button" id="new-acct-promos-wildcard" class="btn btn-outline" style="font-size:10px;padding:1px 6px">全許可(%)</button>
            <span style="color:var(--text-muted);font-size:10px;margin-left:6px">※「全許可(%)」は現在・今後の全プロモを含む</span>
          </label>
          ${groupBarHtml}
          <div id="new-acct-promos-list" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;padding:8px;background:#fff;display:flex;flex-wrap:wrap;gap:6px">
            ${allPromos.length ? allPromos.map(p => `<label style="display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap"><input type="checkbox" value="${escapeHtml(p)}" class="new-acct-promo-chk"> ${escapeHtml(p)}</label>`).join('') : '<span style="color:var(--text-muted);font-size:11px">プロモ候補がまだ読み込まれていません</span>'}
          </div>
        </div>
        <div style="grid-column:1/-1">
          <label class="form-label" style="font-size:11px">閲覧可能タブ <span style="color:var(--text-muted);font-size:10px">※ ロール変更で自動プリセット (admin は全タブ強制表示)</span></label>
          <div id="new-acct-tabs-list" style="display:flex;gap:12px;flex-wrap:wrap;padding:8px;border:1px solid var(--border);border-radius:4px;background:#fff">
            ${AUTH_TAB_DEFS.map(t => `<label style="display:flex;align-items:center;gap:4px;font-size:12px"><input type="checkbox" class="new-acct-tab-chk" data-tab="${t.key}"> ${t.label}</label>`).join('')}
          </div>
        </div>
      </div>
      <button class="btn btn-dark" id="new-acct-submit" style="padding:8px 20px;font-size:13px">発行する</button>
      <div id="new-acct-msg" style="margin-top:10px;font-size:12px"></div>
    </div>
  ` : `
    <div class="card" style="padding:16px">
      <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:10px;margin-bottom:12px;font-size:12px">
        ⚠️ <strong>Worker 未デプロイのようです</strong>。手動発行モードに切替えています。<br>
        <code>worker/auth-admin/SETUP.md</code> の手順で Cloudflare Worker をデプロイすると
        UUID不要の1クリック発行が使えるようになります。
      </div>
      <h3 style="margin-top:0;margin-bottom:8px">➕ 新規アカウント発行 <span style="color:#d97706;font-size:11px;font-weight:400">(手動モード)</span></h3>
      <div style="font-size:12px;color:var(--text-sub);margin-bottom:12px;line-height:1.6">
        <strong>手順</strong><br>
        1) <a href="https://supabase.com/dashboard/project/ndlfqrvoejwgqfdtghmg/auth/users" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:underline">Supabase Dashboard → Authentication → Users</a> を開く<br>
        2) <strong>Add user</strong> → メールとパスワードを入力 → <strong>Auto Confirm User: ON</strong> で作成<br>
        3) 作成されたユーザの行をクリックすると UUID が表示される。それをコピー<br>
        4) ↓ このフォームに情報を入力して「発行する」を押す<br>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:10px">
        <div>
          <label class="form-label" style="font-size:11px">名前</label>
          <input type="text" class="form-input" id="new-acct-name" placeholder="例: 小池 隆史" style="font-size:13px;padding:6px 10px">
        </div>
        <div>
          <label class="form-label" style="font-size:11px">メール</label>
          <input type="email" class="form-input" id="new-acct-email" placeholder="例: taro@example.com" style="font-size:13px;padding:6px 10px">
        </div>
        <div>
          <label class="form-label" style="font-size:11px">Auth UUID (Dashboardでコピー)</label>
          <input type="text" class="form-input" id="new-acct-uuid" placeholder="00000000-0000-0000-0000-000000000000" style="font-size:11px;padding:6px 10px;font-family:monospace">
        </div>
        <div>
          <label class="form-label" style="font-size:11px">ロール</label>
          <select class="form-select" id="new-acct-role" style="font-size:13px;padding:6px 10px">
            <option value="agency">agency (代理店)</option>
            <option value="staff_promo">staff_promo (社員プロモ)</option>
            <option value="admin">admin (全権)</option>
          </select>
        </div>
        <div>
          <label class="form-label" style="font-size:11px">代理店名 (任意)</label>
          <input type="text" class="form-input" id="new-acct-agency" placeholder="例: ヒカル" style="font-size:13px;padding:6px 10px">
        </div>
        <div style="grid-column:1/-1">
          <label class="form-label" style="font-size:11px">担当プロモ
            <button type="button" id="new-acct-promos-all" class="btn btn-outline" style="font-size:10px;padding:1px 6px;margin-left:8px">全選択</button>
            <button type="button" id="new-acct-promos-none" class="btn btn-outline" style="font-size:10px;padding:1px 6px">全解除</button>
            <button type="button" id="new-acct-promos-wildcard" class="btn btn-outline" style="font-size:10px;padding:1px 6px">全許可(%)</button>
          </label>
          ${groupBarHtml}
          <div id="new-acct-promos-list" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;padding:8px;background:#fff;display:flex;flex-wrap:wrap;gap:6px">
            ${allPromos.length ? allPromos.map(p => `<label style="display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap"><input type="checkbox" value="${escapeHtml(p)}" class="new-acct-promo-chk"> ${escapeHtml(p)}</label>`).join('') : '<span style="color:var(--text-muted);font-size:11px">プロモ候補なし</span>'}
          </div>
        </div>
        <div style="grid-column:1/-1">
          <label class="form-label" style="font-size:11px">閲覧可能タブ</label>
          <div id="new-acct-tabs-list" style="display:flex;gap:12px;flex-wrap:wrap;padding:8px;border:1px solid var(--border);border-radius:4px;background:#fff">
            ${AUTH_TAB_DEFS.map(t => `<label style="display:flex;align-items:center;gap:4px;font-size:12px"><input type="checkbox" class="new-acct-tab-chk" data-tab="${t.key}"> ${t.label}</label>`).join('')}
          </div>
        </div>
      </div>
      <button class="btn btn-dark" id="new-acct-submit-legacy" style="padding:8px 20px;font-size:13px">発行する</button>
      <div id="new-acct-msg" style="margin-top:10px;font-size:12px"></div>
    </div>
  `;

  container.innerHTML = `
    <div class="card" style="margin-bottom:16px;padding:16px">
      <div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div style="font-size:13px">
          合計 <strong>${total}</strong> 名
          &nbsp;｜&nbsp; admin: <strong>${adminCount}</strong>
          &nbsp;｜&nbsp; staff_promo: <strong>${staffCount}</strong>
          &nbsp;｜&nbsp; agency: <strong>${agencyCount}</strong>
          &nbsp;｜&nbsp; ${workerAvailable ? '<span style="color:#059669">🟢 Worker稼働中</span>' : '<span style="color:#d97706">🟡 Worker未デプロイ</span>'}
        </div>
        <button class="btn btn-outline" id="auth-mig-reload" style="padding:4px 10px;font-size:11px">🔄 再読み込み</button>
      </div>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead><tr>
            <th>ID</th><th>名前</th><th>ロール</th><th>代理店</th><th>メール</th><th>担当プロモ</th><th>閲覧タブ</th><th>Auth</th><th style="white-space:nowrap">共有URL</th><th>操作</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--text-muted)">
        ※ admin アカウントは UI から削除できません。${workerAvailable ? '削除・PW再発行は Worker 経由で auth user も同時に処理されます。' : 'Worker未デプロイ時は auth.users 側は Supabase Dashboard で手動削除してください。'}
      </div>
    </div>

    ${issueFormHtml}
  `;

  container.querySelector('#auth-mig-reload')?.addEventListener('click', () => renderAuthMigration());

  // Phase 9: グループバー配線 (パターン状態を保持する Set を関数ローカルに作る)
  const newAcctPatterns = new Set();
  const _newAcctListEl = container.querySelector('#new-acct-promos-list');
  if (_newAcctListEl && promoGroups.length) {
    _wirePromoGroupBar(container, 'new-acct', _newAcctListEl, newAcctPatterns);
  }

  // 新規発行フォーム: プロモ全選択/全解除/全許可
  const promosListEl = container.querySelector('#new-acct-promos-list');
  container.querySelector('#new-acct-promos-all')?.addEventListener('click', () => {
    promosListEl?.querySelectorAll('.new-acct-promo-chk').forEach(c => { c.checked = true; });
  });
  container.querySelector('#new-acct-promos-none')?.addEventListener('click', () => {
    promosListEl?.querySelectorAll('.new-acct-promo-chk').forEach(c => { c.checked = false; });
  });
  container.querySelector('#new-acct-promos-wildcard')?.addEventListener('click', () => {
    // 「%」を特別チェックボックスとして表現する代わりに、data 属性に立てる
    if (!promosListEl) return;
    const on = promosListEl.dataset.wildcard !== '1';
    promosListEl.dataset.wildcard = on ? '1' : '0';
    promosListEl.style.outline = on ? '2px solid #059669' : '';
    const note = container.querySelector('#new-acct-promos-wild-note');
    if (note) note.remove();
    if (on) {
      const n = document.createElement('div');
      n.id = 'new-acct-promos-wild-note';
      n.style.cssText = 'margin-top:4px;font-size:11px;color:#059669;font-weight:600';
      n.textContent = '★ 全プロモ許可 (%) を送信します。個別チェックは無視されます。';
      promosListEl.after(n);
    }
  });

  // 新規発行フォーム: ロール変更で visible_tabs 既定値を自動プリセット
  const roleSelect = container.querySelector('#new-acct-role');
  const applyRolePreset = () => {
    const r = roleSelect?.value || 'agency';
    const def = _defaultTabsForRole(r);
    _setTabsOnCheckboxes(container, 'new-acct-tab-chk', def);
  };
  if (roleSelect) {
    roleSelect.addEventListener('change', applyRolePreset);
    applyRolePreset(); // 初回
  }

  // 共有URLコピー
  container.querySelectorAll('.btn-acct-share').forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.dataset.url || '';
      const email = btn.dataset.email || '';
      const text = `ログインURL: ${url}\nメール: ${email}\nパスワード: (管理者に問い合わせ / PW再発行ボタンで再生成)`;
      const ok = await _copyToClipboard(text);
      const orig = btn.innerHTML;
      btn.innerHTML = ok ? '✅ コピー済' : '⚠️ 失敗';
      btn.disabled = true;
      setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1400);
    });
  });

  // 編集ボタン → モーダルで プロモ複数選択 + タブ別閲覧権限 を編集
  container.querySelectorAll('.btn-acct-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const name = btn.dataset.name || '';
      const curRole = btn.dataset.role || 'agency';
      const curAgency = btn.dataset.agency || '';
      let curPromos = [];
      try { curPromos = JSON.parse(btn.dataset.promos || '[]'); } catch(_) {}
      let curTabs = null;
      try { curTabs = JSON.parse(btn.dataset.tabs || 'null'); } catch(_) {}
      if (!curTabs || typeof curTabs !== 'object') curTabs = _defaultTabsForRole(curRole);
      _openEditAccountModal({ id, name, curRole, curAgency, curPromos, curTabs, allPromos });
    });
  });

  // PW再発行ボタン (Worker 経由)
  container.querySelectorAll('.btn-acct-reset').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = btn.dataset.uid;
      const name = btn.dataset.name || '';
      if (!uid) { alert('Auth 未連携のため PW再発行できません'); return; }
      if (!confirm(`${name} のパスワードを再発行します。よろしいですか?`)) return;
      const newPw = genRandomPassword(14);
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = '処理中...';
      const r = await callAuthAdminWorker('/auth-admin/reset-password', { user_id: uid, new_password: newPw });
      btn.disabled = false;
      btn.textContent = orig;
      if (!r.ok) { alert('エラー: ' + (r.error || '不明')); return; }
      await _copyToClipboard(newPw);
      alert(`✅ パスワード再発行完了\n\nユーザ: ${name}\n新パスワード: ${newPw}\n\n(クリップボードにコピー済み)`);
    });
  });

  // 削除ボタン
  container.querySelectorAll('.btn-acct-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const uid = btn.dataset.uid || '';
      const name = btn.dataset.name || '';
      if (!confirm(`${name} (ID=${id}) を削除します。よろしいですか?\n\n${workerAvailable ? '※ Auth user と accounts の両方を削除します。' : '※ auth.users 側は別途 Supabase Dashboard で削除してください。'}`)) return;

      // Worker 経由なら 1発で両方消える
      if (workerAvailable && uid) {
        const r = await callAuthAdminWorker('/auth-admin/delete', { user_id: uid, account_id: id });
        if (!r.ok) { alert('エラー: ' + (r.error || '不明')); return; }
        alert('✅ 削除しました (Auth user + accounts)');
        renderAuthMigration();
        return;
      }

      // フォールバック: accounts のみ削除 (Worker 未デプロイ時)
      const { data, error } = await sb.rpc('admin_delete_account', { p_account_id: id });
      if (error || !data?.ok) {
        alert('エラー: ' + (error?.message || data?.error || '不明'));
        return;
      }
      alert('✅ 削除しました\n\n' + (data.note || '') + '\n\n忘れずに Supabase Dashboard → Authentication → Users から auth user を削除してください。');
      renderAuthMigration();
    });
  });

  // 新規発行 (Worker 経由・1クリック)
  container.querySelector('#new-acct-submit')?.addEventListener('click', async () => {
    const btn = container.querySelector('#new-acct-submit');
    const msg = container.querySelector('#new-acct-msg');
    const name   = container.querySelector('#new-acct-name').value.trim();
    let   email  = container.querySelector('#new-acct-email').value.trim();
    const role   = container.querySelector('#new-acct-role').value;
    const agency = container.querySelector('#new-acct-agency').value.trim();
    // プロモ: チェックボックス選択値 (「全許可」モード時は ['%'])
    const promosListEl2 = container.querySelector('#new-acct-promos-list');
    let promos;
    if (promosListEl2 && promosListEl2.dataset.wildcard === '1') {
      promos = ['%'];
    } else {
      const checked = Array.from(container.querySelectorAll('#new-acct-promos-list .new-acct-promo-chk:checked')).map(c => c.value);
      promos = _composePromoList(newAcctPatterns, checked);
    }
    // 閲覧タブ
    const visible_tabs = _readTabsFromCheckboxes(container, 'new-acct-tab-chk');

    msg.textContent = '';
    msg.style.color = '';
    if (!name || !role) {
      msg.textContent = '名前・ロールは必須です';
      msg.style.color = '#c00';
      return;
    }
    if (!email) {
      // 自動生成 (英数のみ、タイムスタンプ付き)
      const slug = name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'user';
      const ts = Date.now().toString(36);
      email = `partner-${slug}-${ts}@seishokai.local`;
    }
    const password = genRandomPassword(14);

    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = '発行中...';
    const r = await callAuthAdminWorker('/auth-admin/create', {
      email, password, name, role,
      agency: agency || '',
      allowed_promos: promos,
      visible_tabs,
    });
    btn.disabled = false;
    btn.textContent = origText;

    if (!r.ok) {
      // ネットワークエラーなら再描画して手動モードにフォールバック
      if (r.networkError) {
        msg.innerHTML = '❌ Worker 接続失敗。手動モードに切替えます...';
        msg.style.color = '#c00';
        setTimeout(() => renderAuthMigration(), 1200);
        return;
      }
      // Phase 9: admin only など権限エラー時は debug 情報を表示 (原因切り分け用)
      const dbgStr = r.debug ? ('\n\n[debug]\n' + JSON.stringify(r.debug, null, 2)) : '';
      const detailStr = r.detail ? ('\n\n[detail]\n' + (typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail))) : '';
      msg.innerHTML = 'エラー: ' + escapeHtml(r.error || '不明') + (r.debug ? ' <span style="color:var(--text-muted);font-size:10px">(詳細はコンソール/アラート参照)</span>' : '');
      msg.style.color = '#c00';
      if (r.debug || r.detail) {
        try { console.error('[auth-admin/create]', r); } catch(_) {}
        alert('❌ ' + (r.error || '発行失敗') + dbgStr + detailStr);
      }
      return;
    }

    const loginUrl = (role === 'admin') ? 'https://seishokai.github.io/clinic-analysis/' : 'https://seishokai.github.io/clinic-analysis/?login';
    const info = `ログインURL: ${loginUrl}\nメール: ${r.email}\nパスワード: ${r.password}\nロール: ${role}` + (agency ? `\n代理店: ${agency}` : '');
    await _copyToClipboard(info);
    msg.innerHTML = '✅ 発行しました (認証情報をクリップボードにコピー済み)';
    msg.style.color = '#059669';
    _showCredModal(info);

    // フォームクリア
    ['new-acct-name','new-acct-email','new-acct-agency']
      .forEach(idv => { const el = container.querySelector('#' + idv); if (el) el.value = ''; });
    container.querySelectorAll('#new-acct-promos-list .new-acct-promo-chk').forEach(c => { c.checked = false; });
    if (promosListEl2) { promosListEl2.dataset.wildcard = '0'; promosListEl2.style.outline = ''; }
    newAcctPatterns.clear();
    setTimeout(() => renderAuthMigration(), 600);
  });

  // 旧: 手動 UUID 入力モード (Worker 未デプロイ時のみ)
  container.querySelector('#new-acct-submit-legacy')?.addEventListener('click', async () => {
    const btn = container.querySelector('#new-acct-submit-legacy');
    const msg = container.querySelector('#new-acct-msg');
    const name   = container.querySelector('#new-acct-name').value.trim();
    const email  = container.querySelector('#new-acct-email').value.trim();
    const uuid   = container.querySelector('#new-acct-uuid').value.trim();
    const role   = container.querySelector('#new-acct-role').value;
    const agency = container.querySelector('#new-acct-agency').value.trim();
    const promosListElL = container.querySelector('#new-acct-promos-list');
    let promos;
    if (promosListElL && promosListElL.dataset.wildcard === '1') {
      promos = ['%'];
    } else {
      const checked = Array.from(container.querySelectorAll('#new-acct-promos-list .new-acct-promo-chk:checked')).map(c => c.value);
      promos = _composePromoList(newAcctPatterns, checked);
    }
    const visible_tabs = _readTabsFromCheckboxes(container, 'new-acct-tab-chk');

    msg.textContent = '';
    msg.style.color = '';
    if (!name || !email || !uuid) {
      msg.textContent = '名前・メール・UUID は必須です';
      msg.style.color = '#c00';
      return;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
      msg.textContent = 'UUID の形式が不正です (00000000-0000-0000-0000-000000000000 形式)';
      msg.style.color = '#c00';
      return;
    }
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = '発行中...';
    const { data, error } = await sb.rpc('admin_create_account_with_role', {
      p_user_uuid: uuid,
      p_email: email,
      p_name: name,
      p_role: role,
      p_agency: agency,
      p_allowed_promos: promos,
      p_visible_tabs: visible_tabs
    });
    btn.disabled = false;
    btn.textContent = origText;
    if (error || !data?.ok) {
      msg.textContent = 'エラー: ' + (error?.message || data?.error || '不明');
      msg.style.color = '#c00';
      return;
    }
    msg.textContent = '✅ 発行しました';
    msg.style.color = '#059669';
    ['new-acct-name','new-acct-email','new-acct-uuid','new-acct-agency']
      .forEach(idv => { const el = container.querySelector('#' + idv); if (el) el.value = ''; });
    container.querySelectorAll('#new-acct-promos-list .new-acct-promo-chk').forEach(c => { c.checked = false; });
    if (promosListElL) { promosListElL.dataset.wildcard = '0'; promosListElL.style.outline = ''; }
    setTimeout(() => renderAuthMigration(), 600);
  });
}

// Phase 8: アカウント編集モーダル (ロール / 代理店 / プロモ複数選択 / 閲覧タブ)
function _openEditAccountModal({ id, name, curRole, curAgency, curPromos, curTabs, curCanViewPII, allPromos }) {
  // 既存モーダル削除
  const old = document.getElementById('edit-acct-modal');
  if (old) old.remove();

  const wrap = document.createElement('div');
  wrap.id = 'edit-acct-modal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  const promosSet = new Set((curPromos || []).map(String));
  const wildcard = promosSet.has('%');
  // Phase 9: パターン (prefix_%) と 個別値を分離
  const existingPatterns = new Set();
  (curPromos || []).forEach(p => {
    if (typeof p === 'string' && p.endsWith('_%') && p.length > 2) existingPatterns.add(p);
  });
  // 個別チェックボックス: パターンに該当するものも、既存保存値で match するものは ON にする (視覚的にまとめて含む表示)
  const isCoveredByPattern = (v) => {
    for (const pat of existingPatterns) {
      if (v.startsWith(pat.slice(0, -1))) return true;
    }
    return false;
  };
  const promoChks = (allPromos || []).map(p => {
    const checked = promosSet.has(p) || isCoveredByPattern(p);
    return `<label style="display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap"><input type="checkbox" value="${escapeHtml(p)}" class="edit-acct-promo-chk"${checked ? ' checked' : ''}> ${escapeHtml(p)}</label>`;
  }).join('');
  // allPromos に含まれない & パターンでもない カスタム値 (従来表示)
  const extraPromos = (curPromos || []).filter(p => p !== '%' && !(p.endsWith && p.endsWith('_%')) && !(allPromos || []).includes(p));
  const extraChks = extraPromos.map(p => `<label style="display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap;background:#fef3c7;padding:2px 6px;border-radius:3px"><input type="checkbox" value="${escapeHtml(p)}" class="edit-acct-promo-chk" checked> ${escapeHtml(p)} <span style="color:#92400e;font-size:10px">(カスタム)</span></label>`).join('');
  const editPromoGroups = _computePromoPrefixGroups(allPromos);
  const editGroupBarHtml = _renderPromoGroupBarHtml(editPromoGroups, 'edit-acct');

  wrap.innerHTML = `
    <div style="background:#fff;border-radius:8px;padding:20px;max-width:720px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,0.25)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h3 style="margin:0;font-size:16px">✏ アカウント編集: ${escapeHtml(name)}</h3>
        <button type="button" id="edit-acct-close" class="btn btn-outline" style="padding:4px 10px;font-size:12px">✕ 閉じる</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:14px">
        <div>
          <label class="form-label" style="font-size:11px">ロール</label>
          <select id="edit-acct-role" class="form-select" style="font-size:13px;padding:6px 10px">
            <option value="agency"${curRole==='agency'?' selected':''}>agency (代理店)</option>
            <option value="staff_promo"${curRole==='staff_promo'?' selected':''}>staff_promo (社員プロモ)</option>
            <option value="admin"${curRole==='admin'?' selected':''}>admin (全権)</option>
          </select>
        </div>
        <div>
          <label class="form-label" style="font-size:11px">代理店名</label>
          <input type="text" id="edit-acct-agency" class="form-input" value="${escapeHtml(curAgency || '')}" style="font-size:13px;padding:6px 10px">
        </div>
      </div>
      <div style="margin-bottom:14px">
        <label class="form-label" style="font-size:11px">担当プロモ
          <button type="button" id="edit-acct-promos-all" class="btn btn-outline" style="font-size:10px;padding:1px 6px;margin-left:8px">全選択</button>
          <button type="button" id="edit-acct-promos-none" class="btn btn-outline" style="font-size:10px;padding:1px 6px">全解除</button>
          <button type="button" id="edit-acct-promos-wildcard" class="btn btn-outline" style="font-size:10px;padding:1px 6px">全許可(%)</button>
        </label>
        ${editGroupBarHtml}
        <div id="edit-acct-promos-list" data-wildcard="${wildcard ? '1' : '0'}" style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;padding:8px;background:#fff;display:flex;flex-wrap:wrap;gap:6px;${wildcard ? 'outline:2px solid #059669' : ''}">
          ${promoChks || '<span style="color:var(--text-muted);font-size:11px">プロモ候補なし</span>'}
          ${extraChks}
        </div>
        ${wildcard ? '<div id="edit-acct-promos-wild-note" style="margin-top:4px;font-size:11px;color:#059669;font-weight:600">★ 全プロモ許可 (%) を送信します。個別チェックは無視されます。</div>' : ''}
      </div>
      <div style="margin-bottom:14px">
        <label class="form-label" style="font-size:11px">閲覧可能タブ <span style="color:var(--text-muted);font-size:10px">※ admin は全タブ強制表示 (この設定は無視)</span></label>
        <div id="edit-acct-tabs-list" style="display:flex;gap:12px;flex-wrap:wrap;padding:8px;border:1px solid var(--border);border-radius:4px;background:#fff">
          ${AUTH_TAB_DEFS.map(t => `<label style="display:flex;align-items:center;gap:4px;font-size:12px"><input type="checkbox" class="edit-acct-tab-chk" data-tab="${t.key}"${curTabs && curTabs[t.key] ? ' checked' : ''}> ${t.label}</label>`).join('')}
        </div>
      </div>
      <div style="margin-bottom:14px;padding:10px;border:1px dashed #f59e0b;border-radius:6px;background:#fffbeb">
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer">
          <input type="checkbox" id="edit-acct-pii" ${curCanViewPII ? 'checked' : ''} style="width:16px;height:16px">
          <span><strong>🔓 個人情報 (名前・電話・メール) を平文で閲覧可</strong><br>
          <span style="color:var(--text-sub);font-size:11px">電話追跡・顧客対応担当者など、業務上必要な場合のみ ON にしてください。admin は常に閲覧可。</span></span>
        </label>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button type="button" id="edit-acct-cancel" class="btn btn-outline" style="padding:6px 16px;font-size:13px">キャンセル</button>
        <button type="button" id="edit-acct-save" class="btn btn-dark" style="padding:6px 16px;font-size:13px">保存</button>
      </div>
      <div id="edit-acct-msg" style="margin-top:10px;font-size:12px"></div>
    </div>
  `;
  document.body.appendChild(wrap);

  const close = () => { wrap.remove(); };
  wrap.querySelector('#edit-acct-close').addEventListener('click', close);
  wrap.querySelector('#edit-acct-cancel').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

  const listEl = wrap.querySelector('#edit-acct-promos-list');
  // Phase 9: グループバー配線 (既存パターンを初期値として渡す)
  const editAcctPatterns = new Set(existingPatterns);
  if (listEl && editPromoGroups.length) {
    _wirePromoGroupBar(wrap, 'edit-acct', listEl, editAcctPatterns);
  }
  wrap.querySelector('#edit-acct-promos-all').addEventListener('click', () => {
    listEl.querySelectorAll('.edit-acct-promo-chk').forEach(c => { c.checked = true; });
  });
  wrap.querySelector('#edit-acct-promos-none').addEventListener('click', () => {
    listEl.querySelectorAll('.edit-acct-promo-chk').forEach(c => { c.checked = false; });
  });
  wrap.querySelector('#edit-acct-promos-wildcard').addEventListener('click', () => {
    const on = listEl.dataset.wildcard !== '1';
    listEl.dataset.wildcard = on ? '1' : '0';
    listEl.style.outline = on ? '2px solid #059669' : '';
    const existing = wrap.querySelector('#edit-acct-promos-wild-note');
    if (existing) existing.remove();
    if (on) {
      const n = document.createElement('div');
      n.id = 'edit-acct-promos-wild-note';
      n.style.cssText = 'margin-top:4px;font-size:11px;color:#059669;font-weight:600';
      n.textContent = '★ 全プロモ許可 (%) を送信します。個別チェックは無視されます。';
      listEl.after(n);
    }
  });

  // ロール変更 → タブ既定値プリセット (確認ダイアログ)
  wrap.querySelector('#edit-acct-role').addEventListener('change', (e) => {
    const newR = e.target.value;
    if (!confirm('ロールを「' + newR + '」に変更します。閲覧タブの既定値も適用しますか?\n(OK = 既定値にリセット / キャンセル = 現状維持)')) return;
    _setTabsOnCheckboxes(wrap, 'edit-acct-tab-chk', _defaultTabsForRole(newR));
  });

  wrap.querySelector('#edit-acct-save').addEventListener('click', async () => {
    const saveBtn = wrap.querySelector('#edit-acct-save');
    const msg = wrap.querySelector('#edit-acct-msg');
    const newRole = wrap.querySelector('#edit-acct-role').value;
    const newAgency = wrap.querySelector('#edit-acct-agency').value.trim();
    let newPromos;
    if (listEl.dataset.wildcard === '1') {
      newPromos = ['%'];
    } else {
      const checked = Array.from(wrap.querySelectorAll('.edit-acct-promo-chk:checked')).map(c => c.value);
      newPromos = _composePromoList(editAcctPatterns, checked);
    }
    const newTabs = _readTabsFromCheckboxes(wrap, 'edit-acct-tab-chk');
    const newCanViewPII = wrap.querySelector('#edit-acct-pii')?.checked || false;

    saveBtn.disabled = true;
    const orig = saveBtn.textContent;
    saveBtn.textContent = '保存中...';
    try {
      const { data, error } = await sb.rpc('admin_update_account', {
        p_account_id: id,
        p_role: newRole,
        p_allowed_promos: newPromos,
        p_agency: newAgency,
        p_visible_tabs: newTabs,
        p_can_view_pii: newCanViewPII
      });
      if (error || !data?.ok) {
        msg.textContent = 'エラー: ' + (error?.message || data?.error || '不明');
        msg.style.color = '#c00';
        saveBtn.disabled = false;
        saveBtn.textContent = orig;
        return;
      }
      close();
      renderAuthMigration();
    } catch (e) {
      msg.textContent = 'エラー: ' + (e?.message || String(e));
      msg.style.color = '#c00';
      saveBtn.disabled = false;
      saveBtn.textContent = orig;
    }
  });
}

// ══ 印刷用ヘルパー (ブラウザの印刷→PDF保存) ══
function printTable(beforeFn, afterFn) {
  try { if (beforeFn) beforeFn(); } catch(_) {}
  document.body.classList.add('printing');
  setTimeout(() => {
    try { window.print(); } catch(_) {}
    setTimeout(() => {
      document.body.classList.remove('printing');
      try { if (afterFn) afterFn(); } catch(_) {}
    }, 500);
  }, 100);
}
