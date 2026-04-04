// === Config ===
const CORRECT_PASSWORD = 'Edoyadepon1';

// === State ===
let clinics = [];
let currentView = 'dashboard';

// === Init ===
document.addEventListener('DOMContentLoaded', () => {
  if (sessionStorage.getItem('authenticated') === 'true') {
    showApp();
  }
  setupEventListeners();
});

// === Auth ===
function logout() {
  sessionStorage.removeItem('authenticated');
  document.getElementById('app').hidden = true;
  document.getElementById('login-screen').hidden = false;
  document.getElementById('login-screen').style.display = '';
  document.getElementById('password').value = '';
  document.getElementById('login-error').hidden = true;
}

function setupEventListeners() {
  document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = document.getElementById('password').value;
    if (pw === CORRECT_PASSWORD) {
      sessionStorage.setItem('authenticated', 'true');
      showApp();
    } else {
      document.getElementById('login-error').hidden = false;
      document.getElementById('password').value = '';
    }
  });

  // Logout (desktop)
  document.getElementById('logout-btn').addEventListener('click', logout);

  // Logout (mobile settings)
  document.getElementById('logout-btn-mobile').addEventListener('click', logout);

  // Desktop navigation
  document.querySelectorAll('.desktop-nav .nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Bottom navigation (mobile)
  document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Modal close
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.querySelector('.modal-overlay').addEventListener('click', closeModal);

  // Notes save
  document.getElementById('save-notes').addEventListener('click', saveNotes);

  // Load saved notes
  const saved = localStorage.getItem('strategy-notes');
  if (saved) document.getElementById('strategy-notes').value = saved;
}

function showApp() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').hidden = false;
  loadClinics();
}

// === Data Loading ===
async function loadClinics() {
  try {
    const res = await fetch('data/clinics.json');
    clinics = await res.json();
  } catch {
    clinics = [];
  }
  renderDashboard();
  renderCompare();
  renderCompareCards();
  renderStrategy();
}

// === Dashboard ===
function renderDashboard() {
  document.getElementById('total-clinics').textContent = clinics.length;
  const avgAll = clinics.reduce((sum, c) => {
    const s = c.scores;
    return sum + (s.reception + s.counseling + s.hospitality + s.environment) / 4;
  }, 0) / clinics.length;
  document.getElementById('avg-score').textContent = avgAll.toFixed(1);

  const grid = document.getElementById('clinic-grid');
  grid.innerHTML = clinics.map(c => {
    const s = c.scores;
    const avg = ((s.reception + s.counseling + s.hospitality + s.environment) / 4).toFixed(1);
    const scoreClass = avg >= 4.5 ? 'score-high' : avg >= 3.5 ? 'score-mid' : 'score-low';

    const categories = [
      { label: '受付', score: s.reception, color: '#2980b9' },
      { label: 'カウンセリング', score: s.counseling, color: '#27ae60' },
      { label: '接遇', score: s.hospitality, color: '#8e44ad' },
      { label: '院内環境', score: s.environment, color: '#f39c12' },
    ];

    return `
      <div class="clinic-card" data-id="${c.id}">
        <div class="clinic-card-header">
          <h3>${c.name}</h3>
          <div class="overall-score ${scoreClass}">${avg}</div>
        </div>
        <div class="clinic-meta">
          <span>${c.visitDate}</span>
          <span>${c.address}</span>
        </div>
        <div class="score-bars">
          ${categories.map(cat => `
            <div class="score-row">
              <span class="label">${cat.label}</span>
              <div class="score-bar">
                <div class="score-bar-fill" style="width:${cat.score * 20}%;background:${cat.color}"></div>
              </div>
              <span class="value">${cat.score}</span>
            </div>
          `).join('')}
        </div>
        <div class="clinic-card-footer">${c.summary}</div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.clinic-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = parseInt(card.dataset.id);
      openClinicDetail(clinics.find(c => c.id === id));
    });
  });
}

// === Compare Table (Desktop) ===
function renderCompare() {
  const table = document.getElementById('compare-table');
  if (!table) return;
  const headers = ['項目', ...clinics.map(c => c.name)];
  const scoreColor = (s) => s >= 5 ? '#27ae60' : s >= 4 ? '#f39c12' : '#e74c3c';

  const rows = [
    {
      label: '総合スコア',
      values: clinics.map(c => {
        const avg = ((c.scores.reception + c.scores.counseling + c.scores.hospitality + c.scores.environment) / 4).toFixed(1);
        return `<span class="score-badge" style="background:${parseFloat(avg) >= 4.5 ? '#27ae60' : parseFloat(avg) >= 3.5 ? '#f39c12' : '#e74c3c'}">${avg}</span>`;
      })
    },
    { label: '受付対応', values: clinics.map(c => `<span class="score-badge" style="background:${scoreColor(c.scores.reception)}">${c.scores.reception}</span>`) },
    { label: 'カウンセリング', values: clinics.map(c => `<span class="score-badge" style="background:${scoreColor(c.scores.counseling)}">${c.scores.counseling}</span>`) },
    { label: '接遇', values: clinics.map(c => `<span class="score-badge" style="background:${scoreColor(c.scores.hospitality)}">${c.scores.hospitality}</span>`) },
    { label: '院内環境', values: clinics.map(c => `<span class="score-badge" style="background:${scoreColor(c.scores.environment)}">${c.scores.environment}</span>`) },
    { label: '待ち時間', values: clinics.map(c => c.reception.waitTime) },
    { label: '挨拶・表情', values: clinics.map(c => c.reception.greeting) },
    { label: 'ヒアリング', values: clinics.map(c => c.counseling.hearing.deepDive) },
    { label: '説明ツール', values: clinics.map(c => c.counseling.explanation.tools.join('<br>')) },
    { label: '費用説明', values: clinics.map(c => c.counseling.proposal.pricing) },
    { label: 'クロージング', values: clinics.map(c => c.counseling.closing.decisionPrompt) },
    { label: '強み', values: clinics.map(c => c.strengths.join('<br>')) },
    { label: '改善点', values: clinics.map(c => c.improvements.counseling) },
  ];

  table.innerHTML = `
    <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr><td>${r.label}</td>${r.values.map(v => `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody>
  `;
}

// === Compare Cards (Mobile) ===
function renderCompareCards() {
  const container = document.getElementById('compare-cards');
  if (!container) return;

  const scoreColor = (s) => s >= 5 ? '#27ae60' : s >= 4 ? '#f39c12' : '#e74c3c';

  container.innerHTML = clinics.map(c => {
    const s = c.scores;
    const avg = ((s.reception + s.counseling + s.hospitality + s.environment) / 4).toFixed(1);

    return `
      <div class="compare-card">
        <div class="compare-card-header">
          <span>${c.name}</span>
          <span class="card-avg">${avg}</span>
        </div>
        <div class="compare-card-body">
          <div class="compare-card-scores">
            <div class="compare-card-score">
              <div class="cs-val" style="color:${scoreColor(s.reception)}">${s.reception}</div>
              <span class="cs-label">受付</span>
            </div>
            <div class="compare-card-score">
              <div class="cs-val" style="color:${scoreColor(s.counseling)}">${s.counseling}</div>
              <span class="cs-label">カウンセリング</span>
            </div>
            <div class="compare-card-score">
              <div class="cs-val" style="color:${scoreColor(s.hospitality)}">${s.hospitality}</div>
              <span class="cs-label">接遇</span>
            </div>
            <div class="compare-card-score">
              <div class="cs-val" style="color:${scoreColor(s.environment)}">${s.environment}</div>
              <span class="cs-label">院内環境</span>
            </div>
          </div>
          <dl class="compare-card-details">
            <dt>待ち時間</dt><dd>${c.reception.waitTime}</dd>
            <dt>費用説明</dt><dd>${c.counseling.proposal.pricing}</dd>
            <dt>強み</dt><dd>${c.strengths.join('／')}</dd>
            <dt>改善点</dt><dd>${c.improvements.counseling}</dd>
          </dl>
        </div>
      </div>
    `;
  }).join('');
}

// === Strategy ===
function renderStrategy() {
  const container = document.getElementById('suggestions-summary');
  container.innerHTML = clinics.map(c => {
    if (!c.suggestions.adopt.length) return '';
    return `
      <div class="suggestion-by-clinic">
        <h4>${c.name}</h4>
        <ul>${c.suggestions.adopt.map(s => `<li>${s}</li>`).join('')}</ul>
      </div>
    `;
  }).join('');

  const immediateActions = [
    '担当DAが患者を待つ体制づくり',
    '診察入ってからの患者への挨拶徹底',
    'チェアー前にティッシュ・眼鏡入れ設置',
    '待ち時間対策（iPad雑誌の準備）',
  ];
  const shortActions = [
    'パッと見て分かる端的な資料の作成',
    '口腔写真撮影時の器具使用方法の改善',
    '受付とDAの連携強化で待ち時間削減',
    '数値化した説明資料の導入（歯の大きさ等）',
  ];
  const longActions = [
    'カウンセリングの2回制導入の検討',
    '自院の強み・差別化ポイントの明確化',
    '美容クリニック等との提携検討',
    '成約率向上のためのクロージング研修',
  ];

  document.getElementById('immediate-actions').innerHTML = immediateActions.map(a => `<li>${a}</li>`).join('');
  document.getElementById('short-actions').innerHTML = shortActions.map(a => `<li>${a}</li>`).join('');
  document.getElementById('long-actions').innerHTML = longActions.map(a => `<li>${a}</li>`).join('');
}

// === Clinic Detail Modal ===
function openClinicDetail(c) {
  const modal = document.getElementById('clinic-modal');
  const body = document.getElementById('modal-body');
  const s = c.scores;
  const scoreColor = (v) => v >= 5 ? '#27ae60' : v >= 4 ? '#f39c12' : '#e74c3c';

  body.innerHTML = `
    <div class="detail-header">
      <h2>${c.name}</h2>
      <div class="detail-meta">
        <span>${c.visitDate} ${c.visitTime}</span>
        <span>${c.address}</span>
      </div>
    </div>

    <div class="detail-scores">
      <div class="detail-score-card">
        <div class="score-val" style="color:${scoreColor(s.reception)}">${s.reception}</div>
        <span class="score-name">受付</span>
      </div>
      <div class="detail-score-card">
        <div class="score-val" style="color:${scoreColor(s.counseling)}">${s.counseling}</div>
        <span class="score-name">カウンセリング</span>
      </div>
      <div class="detail-score-card">
        <div class="score-val" style="color:${scoreColor(s.hospitality)}">${s.hospitality}</div>
        <span class="score-name">接遇</span>
      </div>
      <div class="detail-score-card">
        <div class="score-val" style="color:${scoreColor(s.environment)}">${s.environment}</div>
        <span class="score-name">院内環境</span>
      </div>
    </div>

    <div class="detail-section">
      <h3>受付・第一印象</h3>
      <dl class="detail-grid">
        <dt>挨拶・表情</dt><dd>${c.reception.greeting}</dd>
        <dt>身だしなみ</dt><dd>${c.reception.appearance}</dd>
        <dt>待ち時間</dt><dd>${c.reception.waitTime}</dd>
        <dt>スムーズさ</dt><dd>${c.reception.smoothness}</dd>
      </dl>
      <h4 style="margin-top:14px;font-size:12px;color:var(--text-light)">来院フロー</h4>
      <ol class="detail-flow">
        ${c.reception.flow.map(f => `<li>${f}</li>`).join('')}
      </ol>
    </div>

    <div class="detail-section">
      <h3>カウンセリング</h3>
      <p style="margin-bottom:12px;font-size:13px;background:var(--bg);padding:12px;border-radius:8px">${c.counseling.impression}</p>
      <dl class="detail-grid">
        <dt>主訴の深掘り</dt><dd>${c.counseling.hearing.deepDive}</dd>
        <dt>生活背景</dt><dd>${c.counseling.hearing.lifestyle}</dd>
        <dt>説明力</dt><dd>${c.counseling.explanation.clarity}</dd>
        <dt>専門用語</dt><dd>${c.counseling.explanation.terminology}</dd>
        <dt>治療選択肢</dt><dd>${c.counseling.proposal.options}</dd>
        <dt>メリデメ</dt><dd>${c.counseling.proposal.proscons}</dd>
        <dt>費用説明</dt><dd>${c.counseling.proposal.pricing}</dd>
        <dt>不安解消</dt><dd>${c.counseling.closing.anxietyRelief}</dd>
        <dt>意思決定</dt><dd>${c.counseling.closing.decisionPrompt}</dd>
        <dt>次回予約</dt><dd>${c.counseling.closing.nextBooking}</dd>
      </dl>
      <h4 style="margin-top:12px;font-size:12px;color:var(--text-light)">使用ツール</h4>
      <ul class="detail-list">
        ${c.counseling.explanation.tools.map(t => `<li>${t}</li>`).join('')}
      </ul>
    </div>

    <div class="detail-section">
      <h3>接遇</h3>
      <dl class="detail-grid">
        <dt>共感力</dt><dd>${c.hospitality.empathy}</dd>
        <dt>傾聴姿勢</dt><dd>${c.hospitality.listening}</dd>
        <dt>言葉遣い</dt><dd>${c.hospitality.language}</dd>
        <dt>距離感</dt><dd>${c.hospitality.distance}</dd>
      </dl>
    </div>

    <div class="detail-section">
      <h3>院内環境</h3>
      <dl class="detail-grid">
        <dt>清潔感</dt><dd>${c.environment.cleanliness}</dd>
        <dt>設備</dt><dd>${c.environment.equipment}</dd>
        <dt>プライバシー</dt><dd>${c.environment.privacy}</dd>
        <dt>連携</dt><dd>${c.environment.teamwork}</dd>
      </dl>
    </div>

    <div class="detail-section">
      <h3>強み・差別化</h3>
      ${c.strengths.map(s => `<div class="strength-item">${s}</div>`).join('')}
      ${c.impressivePoints.length ? '<h4 style="margin:10px 0 6px;font-size:12px;color:var(--text-light)">印象に残った点</h4>' : ''}
      ${c.impressivePoints.map(p => `<div class="strength-item">${p}</div>`).join('')}
    </div>

    <div class="detail-section">
      <h3>改善点</h3>
      ${c.improvements.counseling !== '特になし' && c.improvements.counseling !== '1回目の段階では特になし' ? `<div class="improve-item"><strong>カウンセリング:</strong> ${c.improvements.counseling}</div>` : ''}
      ${c.improvements.hospitality !== '特になし' && c.improvements.hospitality !== '特に問題なし' ? `<div class="improve-item"><strong>接遇:</strong> ${c.improvements.hospitality}</div>` : ''}
      ${c.improvements.operation !== '特になし' && c.improvements.operation !== '特に問題なし' ? `<div class="improve-item"><strong>オペレーション:</strong> ${c.improvements.operation}</div>` : ''}
      ${c.improvements.counseling === '特になし' || c.improvements.counseling === '1回目の段階では特になし' ? '<p style="font-size:13px;color:var(--text-light)">特に大きな改善点なし</p>' : ''}
    </div>

    <div class="detail-section">
      <h3>自院への示唆</h3>
      ${c.suggestions.adopt.map(s => `<div class="strength-item">${s}</div>`).join('')}
    </div>

    <div class="detail-section">
      <h3>総合評価</h3>
      <p style="font-size:14px;background:linear-gradient(135deg,#f0f7ff,#e8f8f0);padding:14px;border-radius:10px;line-height:1.8">${c.summary}</p>
    </div>
  `;

  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('clinic-modal').hidden = true;
  document.body.style.overflow = '';
}

// === View Switching ===
function switchView(view) {
  currentView = view;
  // Update desktop nav
  document.querySelectorAll('.desktop-nav .nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  // Update bottom nav
  document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  // Show/hide views
  document.querySelectorAll('.view').forEach(v => {
    v.hidden = v.id !== `view-${view}`;
  });
  // Scroll to top on view switch
  window.scrollTo(0, 0);
}

// === Notes ===
function saveNotes() {
  const notes = document.getElementById('strategy-notes').value;
  localStorage.setItem('strategy-notes', notes);
  const status = document.getElementById('save-status');
  status.textContent = '保存しました';
  setTimeout(() => status.textContent = '', 2000);
}

// === Keyboard shortcuts ===
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});
