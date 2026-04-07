// === Config ===
const CORRECT_PASSWORD = 'Edoyadepon1';
// プロモ別パスワード: パスワード → フィルターするプロモコードのプレフィックス
const PROMO_PASSWORDS = {
  'hikaru': 'hikaru',
  'third': 'third',
  'murase': 'murase',
  'sasaki': 'sasaki',
  'ceramic': 'ceramic',
  'implant': 'implant',
  'blackfilm': 'blackfilm',
};
let userRole = 'admin'; // 'admin' or 'promo'
let promoFilter = ''; // プロモ別ログイン時のフィルター
const FACILITIES = ['全体','エスカ','アール','ウィズ','ルミナス','茶屋','アサノ','知立','小牧','八事','岩田','大森','京都','銀座','訪問'];

// === State ===
let clinics = [];
let currentView = 'tc';
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
  if (sessionStorage.getItem('authenticated') === 'true') {
    userRole = sessionStorage.getItem('role') || 'admin';
    promoFilter = sessionStorage.getItem('promoFilter') || '';
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
  function attemptLogin() {
    const pw = document.getElementById('password').value;
    if (pw === CORRECT_PASSWORD) {
      document.getElementById('password').value = '';
      sessionStorage.setItem('authenticated', 'true');
      sessionStorage.setItem('role', 'admin');
      userRole = 'admin';
      promoFilter = '';
      showApp();
    } else if (PROMO_PASSWORDS[pw]) {
      document.getElementById('password').value = '';
      sessionStorage.setItem('authenticated', 'true');
      sessionStorage.setItem('role', 'promo');
      sessionStorage.setItem('promoFilter', PROMO_PASSWORDS[pw]);
      userRole = 'promo';
      promoFilter = PROMO_PASSWORDS[pw];
      showApp();
    } else {
      // 管理タブで発行したアカウントをチェック
      const accounts = JSON.parse(localStorage.getItem('admin-accounts') || '[]');
      const matched = accounts.find(a => a.password === pw);
      if (matched) {
        document.getElementById('password').value = '';
        sessionStorage.setItem('authenticated', 'true');
        sessionStorage.setItem('role', 'custom');
        sessionStorage.setItem('customPerms', JSON.stringify(matched.permissions));
        sessionStorage.setItem('customPromos', JSON.stringify(matched.promos || []));
        sessionStorage.setItem('customServices', JSON.stringify(matched.services || []));
        sessionStorage.setItem('customFacilities', JSON.stringify(matched.facilities || []));
        sessionStorage.setItem('customEditRole', matched.role || 'view');
        showApp();
        return;
      }
      document.getElementById('login-error').hidden = false;
      document.getElementById('password').value = '';
    }
  }
  document.getElementById('login-btn').addEventListener('click', attemptLogin);
  document.getElementById('password').addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('logout-btn-mobile').addEventListener('click', logout);

  // Main nav
  document.querySelectorAll('.desktop-nav .nav-btn').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  document.querySelectorAll('.bottom-nav-btn').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

  // Sub nav
  document.querySelectorAll('.sub-nav-btn').forEach(b => {
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
      }
      // プロモ別タブ切替時にデータ更新
      if (sub === 'bk-promo-dash' && bookingsData.length > 0) renderPromoDash();
    });
  });

  // Modal
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.querySelector('.modal-overlay').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

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

  // Bookings filters
  ['bk-facility','bk-promo','bk-service','bk-status','bk-month'].forEach(id => {
    document.getElementById(id).addEventListener('change', renderBookings);
  });
  document.getElementById('bk-refresh').addEventListener('click', loadBookings);
  document.getElementById('bk-csv').addEventListener('click', exportCSV);

  // Admin
  document.getElementById('adm-create').addEventListener('click', createAccount);
  renderAccounts();

  // Add clinic
  document.getElementById('add-clinic-btn').addEventListener('click', () => { document.getElementById('clinic-add-modal').hidden = false; });
  document.getElementById('nc-save').addEventListener('click', saveNewClinic);

  // Documents
  document.getElementById('doc-save').addEventListener('click', saveDocument);

  // Notes
  document.getElementById('save-notes').addEventListener('click', () => {
    localStorage.setItem('strategy-notes', document.getElementById('strategy-notes').value);
    const s = document.getElementById('save-status');
    s.textContent = '保存しました';
    setTimeout(() => s.textContent = '', 2000);
  });
  const savedNotes = localStorage.getItem('strategy-notes');
  if (savedNotes) document.getElementById('strategy-notes').value = savedNotes;

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

  // プロモユーザーの場合、予約タブのみ表示
  userRole = sessionStorage.getItem('role') || 'admin';
  promoFilter = sessionStorage.getItem('promoFilter') || '';
  if (userRole === 'promo') {
    document.querySelectorAll('.desktop-nav .nav-btn').forEach(b => {
      b.style.display = b.dataset.view === 'bookings' ? '' : 'none';
    });
    document.querySelectorAll('.bottom-nav-btn').forEach(b => {
      b.style.display = ['bookings','settings'].includes(b.dataset.view) ? '' : 'none';
    });
    document.getElementById('tc-filters') && (document.getElementById('tc-filters').style.display = 'none');
    switchView('bookings');
    loadBookings();
    return;
  }

  if (userRole === 'custom') {
    const perms = JSON.parse(sessionStorage.getItem('customPerms') || '[]');
    const cPromos = JSON.parse(sessionStorage.getItem('customPromos') || '[]');
    promoFilter = cPromos.length ? cPromos[0] : '';
    document.querySelectorAll('.desktop-nav .nav-btn').forEach(b => {
      b.style.display = perms.includes(b.dataset.view) ? '' : 'none';
    });
    document.querySelectorAll('.bottom-nav-btn').forEach(b => {
      b.style.display = perms.includes(b.dataset.view) || b.dataset.view === 'settings' ? '' : 'none';
    });
    const tcFilters = document.getElementById('tc-filters');
    if (tcFilters && !perms.includes('tc')) tcFilters.style.display = 'none';
    switchView(perms[0] || 'bookings');
    if (perms.includes('bookings')) loadBookings();
    if (perms.includes('tc')) { seedConsultationData(); loadClinics(); }
    if (perms.includes('sales')) { seedSalesData(); renderSales(); }
    return;
  }

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
}

// === Navigation ===
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.desktop-nav .nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.bottom-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== `view-${view}`);
  window.scrollTo(0, 0);
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
    <td>${d.visitDate || '-'}</td><td>${d.name}</td><td>${d.purpose}</td><td>${d.source}</td>
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
      <div class="bar-label">${d.name}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(d.rate, 5)}%"><span>${d.rate}%</span></div></div>
      <div class="bar-value">${d.decided}/${d.consulted}</div>
    </div>
  `).join('');
}

// === Clinics (TC) ===
async function loadClinics() {
  try { const r = await fetch('data/clinics.json'); clinics = await r.json(); } catch { clinics = []; }
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

// === Admin: Account Management ===
function generatePassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 8; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

function getAccounts() { return loadData('admin-accounts', []); }

function createAccount() {
  const name = document.getElementById('adm-name').value.trim();
  if (!name) return;
  const perms = [];
  if (document.getElementById('adm-perm-tc').checked) perms.push('tc');
  if (document.getElementById('adm-perm-sales').checked) perms.push('sales');
  if (document.getElementById('adm-perm-bookings').checked) perms.push('bookings');
  if (!perms.length) { alert('閲覧タブを1つ以上選択してください'); return; }
  const selectedPromos = [...document.getElementById('adm-promos').selectedOptions].map(o => o.value);
  const selectedServices = [...document.getElementById('adm-services').selectedOptions].map(o => o.value);
  const selectedFacilities = [...document.getElementById('adm-facilities').selectedOptions].map(o => o.value);
  const role = document.getElementById('adm-role').value;
  const pw = generatePassword();
  const account = { id: Date.now(), name, password: pw, role, permissions: perms, promos: selectedPromos, services: selectedServices, facilities: selectedFacilities, created: new Date().toISOString().slice(0,10) };
  const accounts = getAccounts();
  accounts.push(account);
  saveData('admin-accounts', accounts);
  document.getElementById('adm-name').value = '';
  renderAccounts();
}

function deleteAccount(id) {
  const accounts = getAccounts().filter(a => a.id !== id);
  saveData('admin-accounts', accounts);
  renderAccounts();
}

function renderAccounts() {
  const el = document.getElementById('adm-accounts-list');
  if (!el) return;
  const accounts = getAccounts();
  if (!accounts.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">発行済みアカウントなし</p>'; return; }
  const baseUrl = location.origin + location.pathname;
  el.innerHTML = accounts.map(a => `
    <div style="padding:16px;margin-bottom:10px;background:var(--bg);border-radius:var(--radius-sm);border:1px solid var(--border-light)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong style="font-size:14px">${a.name}</strong>
        <button class="resource-delete" onclick="deleteAccount(${a.id})" style="width:28px;height:28px;font-size:13px">×</button>
      </div>
      <div style="font-size:12px;color:var(--text-sub);margin-bottom:8px">
        <span class="badge ${a.role==='edit'?'badge-success':'badge-default'}" style="margin-right:4px">${a.role==='edit'?'編集':'閲覧のみ'}</span>
        ${a.permissions.map(p => p==='tc'?'TC':p==='sales'?'売上':'予約').join(', ')}
        ${a.promos && a.promos.length ? '<br>プロモ: ' + a.promos.join(', ') : ''}
        ${a.services && a.services.length ? '<br>施術: ' + a.services.map(s=>s.length>15?s.slice(0,15)+'…':s).join(', ') : ''}
        ${a.facilities && a.facilities.length ? '<br>店舗: ' + a.facilities.map(f=>f.length>10?f.slice(0,10)+'…':f).join(', ') : ''}
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <div style="font-size:12px;background:var(--card);padding:6px 12px;border-radius:6px;border:1px solid var(--border)">
          <span style="color:var(--text-sub)">URL:</span> <span style="user-select:all">${baseUrl}</span>
        </div>
        <div style="font-size:12px;background:var(--card);padding:6px 12px;border-radius:6px;border:1px solid var(--border)">
          <span style="color:var(--text-sub)">PW:</span> <strong style="user-select:all;color:var(--text)">${a.password}</strong>
        </div>
      </div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:6px">発行日: ${a.created}</div>
    </div>
  `).join('');
}

function closeModal() {
  document.getElementById('clinic-modal').hidden = true;
  document.body.style.overflow = '';
}

// === Documents ===
function getDocuments() { return loadData('documents-data', []); }

function saveNewClinic() {
  const name = document.getElementById('nc-name').value.trim();
  if (!name) return;
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
}

function openDocModal(clinicName, type) {
  document.getElementById('doc-clinic').value = clinicName;
  document.getElementById('doc-modal-title').textContent = clinicName + ' - ' + type + 'を追加';
  document.getElementById('doc-type').value = type || '見積書';
  document.getElementById('doc-name').value = '';
  document.getElementById('doc-url').value = '';
  document.getElementById('doc-modal').hidden = false;
}

function saveDocument() {
  const name = document.getElementById('doc-name').value.trim();
  const url = document.getElementById('doc-url').value.trim();
  if (!name || !url) return;
  const docs = getDocuments();
  docs.push({
    id: Date.now(),
    name,
    type: document.getElementById('doc-type').value,
    clinic: document.getElementById('doc-clinic').value.trim(),
    url,
    date: new Date().toISOString().split('T')[0]
  });
  saveData('documents-data', docs);
  document.getElementById('doc-modal').hidden = true;
  renderDocuments();
  renderClinicDocs();
}

function deleteDocument(id) {
  const docs = getDocuments().filter(d => d.id !== id);
  saveData('documents-data', docs);
  renderDocuments();
  renderClinicDocs();
}

function renderDocuments() {
  const docs = getDocuments();
  document.getElementById('tc-docs').textContent = docs.length;
}

function renderClinicDocs() {
  const docs = getDocuments();
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
    const url = `https://docs.google.com/spreadsheets/d/${BK_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=%E5%85%83%E3%83%87%E3%83%BC%E3%82%BF`;
    const res = await fetch(url);
    const csv = await res.text();
    bookingsData = parseCSV(csv);
    populateBookingFilters();
    renderBookings();
    renderPromoDash();
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
    document.getElementById('bk-tbody').innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">データ取得に失敗しました</td></tr>';
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

function populateBookingFilters() {
  const facilities = [...new Set(bookingsData.map(d => d.facility).filter(Boolean))].sort();
  const promos = [...new Set(bookingsData.map(d => d.source).filter(Boolean))].sort();
  const services = [...new Set(bookingsData.map(d => d.service).filter(Boolean))].sort();

  const facEl = document.getElementById('bk-facility');
  facEl.innerHTML = '<option value="">全て</option>' + facilities.map(f => `<option>${f}</option>`).join('');

  const promoEl = document.getElementById('bk-promo');
  promoEl.innerHTML = '<option value="">全て</option>' + promos.map(p => `<option>${p}</option>`).join('');

  const svcEl = document.getElementById('bk-service');
  svcEl.innerHTML = '<option value="">全て</option>' + services.map(s => `<option>${s}</option>`).join('');

  // クイックプロモボタン（上位5件）
  const promoCounts = {};
  bookingsData.forEach(d => { if (d.source) { promoCounts[d.source] = (promoCounts[d.source]||0) + 1; } });
  const top5 = Object.entries(promoCounts).sort((a,b) => b[1]-a[1]).slice(0, 5);
  const quickEl = document.getElementById('bk-quick-promos');
  if (quickEl) {
    quickEl.innerHTML = '<span style="font-size:11px;color:var(--text-muted);margin-right:4px">Quick:</span>' + top5.map(([name]) =>
      `<button class="btn btn-outline bk-quick-promo" style="font-size:10px;padding:3px 8px;min-height:24px">${name.length > 18 ? name.slice(0,18)+'…' : name}</button>`
    ).join('');
    quickEl.querySelectorAll('.bk-quick-promo').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        promoEl.value = top5[i][0];
        renderBookings();
      });
    });
  }
}

function renderBookings() {
  const facFilterVal = document.getElementById('bk-facility').value;
  const promoFilterVal = document.getElementById('bk-promo').value;
  const svcFilter = document.getElementById('bk-service').value;
  const statusFilter = document.getElementById('bk-status').value;
  const monthFilter = document.getElementById('bk-month').value;

  let filtered = bookingsData;
  // プロモユーザーの場合、自分のプロモのみ表示
  if (userRole === 'promo' && promoFilter) {
    filtered = filtered.filter(d => d.source && d.source.toLowerCase().includes(promoFilter.toLowerCase()));
    document.getElementById('bk-promo').closest('.form-group').style.display = 'none';
  }
  // カスタムユーザーの制限
  if (userRole === 'custom') {
    const cPromos = JSON.parse(sessionStorage.getItem('customPromos') || '[]');
    const cServices = JSON.parse(sessionStorage.getItem('customServices') || '[]');
    const cFacilities = JSON.parse(sessionStorage.getItem('customFacilities') || '[]');
    if (cPromos.length > 0) {
      filtered = filtered.filter(d => d.source && cPromos.some(p => d.source.toLowerCase().includes(p.toLowerCase())));
    }
    if (cServices.length > 0) {
      filtered = filtered.filter(d => d.service && cServices.some(s => d.service.includes(s)));
    }
    if (cFacilities.length > 0) {
      filtered = filtered.filter(d => d.facility && cFacilities.some(f => d.facility.includes(f)));
    }
  }
  if (facFilterVal) filtered = filtered.filter(d => d.facility === facFilterVal);
  if (promoFilterVal) filtered = filtered.filter(d => d.source === promoFilterVal);
  if (svcFilter) filtered = filtered.filter(d => d.service === svcFilter);
  if (statusFilter) {
    if (statusFilter === '要対応') {
      const td = new Date(); td.setHours(0,0,0,0);
      filtered = filtered.filter(d => (!d.status || d.status === '未対応') && d.bookDate && new Date(d.bookDate.replace(/\//g,'-')) < td);
    } else if (statusFilter === '未対応') filtered = filtered.filter(d => !d.status || d.status === '未対応');
    else filtered = filtered.filter(d => d.status === statusFilter);
  }
  if (monthFilter) {
    filtered = filtered.filter(d => {
      const bd = d.bookDate.replace(/\//g, '-').slice(0, 7);
      return bd === monthFilter;
    });
  }

  // Stats
  const total = filtered.length;
  const cancelled = filtered.filter(d => d.status === 'キャンセル').length;
  const pending = filtered.filter(d => !d.status || d.status === '未対応').length;
  const visited = filtered.filter(d => d.status === '来院済').length;
  const contracted = filtered.filter(d => d.status === '成約').length;

  // 成約金額集計（localStorageから）
  const bkExtraStats = loadData('bk-extra', {});
  let totalAmount = 0;
  Object.values(bkExtraStats).forEach(v => { if (v.contractAmount) totalAmount += Number(v.contractAmount); });

  // 未対応アラート数
  const todayCheck = new Date(); todayCheck.setHours(0,0,0,0);
  const overdueCount = filtered.filter(d => {
    if (d.status && d.status !== '未対応') return false;
    if (!d.bookDate) return false;
    return new Date(d.bookDate.replace(/\//g, '-')) < todayCheck;
  }).length;

  document.getElementById('bk-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">予約数</span><span class="stat-num">${total}</span></div>
    ${overdueCount > 0 ? `<div class="stat-card" style="border-color:var(--red)"><span class="stat-label" style="color:var(--red)">要対応</span><span class="stat-num" style="color:var(--red)">${overdueCount}</span></div>` : ''}
    <div class="stat-card"><span class="stat-label">未対応</span><span class="stat-num">${pending}</span></div>
    <div class="stat-card"><span class="stat-label">キャンセル</span><span class="stat-num" style="color:var(--red)">${cancelled}</span></div>
    <div class="stat-card"><span class="stat-label">来院済</span><span class="stat-num">${visited}</span></div>
    <div class="stat-card"><span class="stat-label">成約</span><span class="stat-num" style="color:var(--green)">${contracted}</span></div>
    <div class="stat-card"><span class="stat-label">成約金額</span><span class="stat-num">¥${fmt(totalAmount)}</span></div>
  `;

  document.getElementById('bk-count').textContent = `${filtered.length}件`;

  // Table
  const tbody = document.getElementById('bk-tbody');
  const sorted = [...filtered].sort((a, b) => (b.applyDate || '').localeCompare(a.applyDate || ''));

  const statusBadge = (s) => {
    if (!s || s === '未対応') return '<span class="badge badge-default">未対応</span>';
    if (s === 'キャンセル') return '<span class="badge badge-danger">キャンセル</span>';
    if (s === '来院済') return '<span class="badge badge-warning">来院済</span>';
    if (s === '成約') return '<span class="badge badge-success">成約</span>';
    if (s === '確認済') return '<span class="badge badge-default" style="border-color:#6366f1;color:#6366f1">確認済</span>';
    return `<span class="badge badge-default">${s}</span>`;
  };

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
    const bd = new Date(d.bookDate.replace(/\//g, '-'));
    return bd < today;
  };

  const isAdmin = userRole === 'admin' || (userRole === 'custom' && sessionStorage.getItem('customEditRole') === 'edit');
  tbody.innerHTML = sorted.slice(0, 200).map((d, idx) => {
    const overdue = isOverdue(d);
    return `<tr style="${overdue ? 'background:#fef2f2' : ''}">
    <td style="white-space:nowrap;font-size:10px;color:var(--text-sub)">${d.applyDate ? d.applyDate.slice(5) : '-'}</td>
    <td style="white-space:nowrap;font-size:10px">${d.bookDate ? d.bookDate.replace(/^2026\//,'').replace(/\//g,'/') : '-'}${overdue ? '<span style="color:var(--red);font-weight:700">!</span>' : ''}</td>
    <td style="white-space:nowrap;font-size:11px;font-weight:500">${d.name}</td>
    <td style="font-size:10px;white-space:nowrap">${shortService(d.service)}</td>
    <td style="font-size:10px;white-space:nowrap">${shortFac(d.facility)}</td>
    <td style="font-size:10px;white-space:nowrap">${isAdmin ? fmtPhone(d.phone) : '***'}</td>
    <td style="font-size:10px;color:var(--text-sub);white-space:nowrap;max-width:100px;overflow:hidden;text-overflow:ellipsis">${isAdmin ? (d.email || '-') : '***'}</td>
    <td style="font-size:9px;color:var(--text-muted);white-space:nowrap;max-width:80px;overflow:hidden;text-overflow:ellipsis">${d.source || '-'}</td>
    <td>${isAdmin ? `<select class="form-select bk-status-select" data-name="${d.name}" data-apply="${d.applyDate}" style="font-size:10px;padding:2px 4px;min-width:70px">
      <option ${(!d.status||d.status==='未対応')?'selected':''}>未対応</option>
      <option ${d.status==='確認済'?'selected':''}>確認済</option>
      <option ${d.status==='来院済'?'selected':''}>来院済</option>
      <option ${d.status==='成約'?'selected':''}>成約</option>
      <option ${d.status==='キャンセル'?'selected':''}>キャンセル</option>
    </select>` : statusBadge(d.status)}</td>
    <td>${isAdmin ? `<select class="form-select bk-field-select" data-name="${d.name}" data-apply="${d.applyDate}" data-field="contractService" style="font-size:10px;padding:2px 4px;min-width:60px">
      <option value="">-</option>
      <option ${d.contractService==='BF'?'selected':''}>BF</option>
      <option ${d.contractService==='矯正(表)'?'selected':''}>矯正(表)</option>
      <option ${d.contractService==='矯正(裏)'?'selected':''}>矯正(裏)</option>
      <option ${d.contractService==='矯正(ﾋﾟｰｽ)'?'selected':''}>矯正(ﾋﾟｰｽ)</option>
      <option ${d.contractService==='ﾗﾌﾞﾘｴ'?'selected':''}>ﾗﾌﾞﾘｴ</option>
      <option ${d.contractService==='ｲﾝﾌﾟﾗﾝﾄ'?'selected':''}>ｲﾝﾌﾟﾗﾝﾄ</option>
    </select>` : (d.contractService || '-')}</td>
    <td>${isAdmin ? `<input type="number" class="form-input bk-field-input" data-name="${d.name}" data-apply="${d.applyDate}" data-field="contractAmount" value="${d.contractAmount||''}" placeholder="0" style="font-size:10px;padding:2px 4px;width:70px">` : (d.contractAmount ? '¥'+fmt(d.contractAmount) : '-')}</td>
    <td>${isAdmin ? `<input type="month" class="form-input bk-field-input" data-name="${d.name}" data-apply="${d.applyDate}" data-field="paymentMonth" value="${d.paymentMonth||''}" style="font-size:10px;padding:2px 4px;width:100px">` : (d.paymentMonth || '-')}</td>
    <td>${isAdmin ? `<input type="month" class="form-input bk-field-input" data-name="${d.name}" data-apply="${d.applyDate}" data-field="incentiveMonth" value="${d.incentiveMonth||''}" style="font-size:10px;padding:2px 4px;width:100px">` : (d.incentiveMonth || '-')}</td>
  </tr>`}).join('') || '<tr><td colspan="13" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';

  if (sorted.length > 200) {
    tbody.innerHTML += `<tr><td colspan="13" style="text-align:center;color:var(--text-muted);font-size:12px">最新200件を表示中（全${sorted.length}件）</td></tr>`;
  }

  // ステータス変更イベント
  if (isAdmin) {
    tbody.querySelectorAll('.bk-status-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const name = sel.dataset.name;
        const applyDate = sel.dataset.apply;
        const newStatus = sel.value;
        const match = bookingsData.find(d => d.name === name && d.applyDate === applyDate);
        if (match) match.status = newStatus;
        sel.style.borderColor = 'var(--green)';
        setTimeout(() => { sel.style.borderColor = ''; }, 1000);
        fetch(GAS_API_URL, {
          method: 'POST', mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, applyDate, status: newStatus })
        }).catch(err => console.error('Update error:', err));
      });
    });

    // 追加フィールド（成約施術・金額・入金月・インセ月）のイベント
    const bkExtra = loadData('bk-extra', {});
    const saveExtra = (name, apply, field, value) => {
      const key = name + '|' + apply;
      if (!bkExtra[key]) bkExtra[key] = {};
      bkExtra[key][field] = value;
      saveData('bk-extra', bkExtra);
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
      if (bkExtra[key] && bkExtra[key][inp.dataset.field]) inp.value = bkExtra[key][inp.dataset.field];
      inp.addEventListener('change', () => {
        saveExtra(inp.dataset.name, inp.dataset.apply, inp.dataset.field, inp.value);
        inp.style.borderColor = 'var(--green)';
        setTimeout(() => { inp.style.borderColor = ''; }, 1000);
      });
    });
  }
}

function exportCSV() {
  const pw = prompt('CSV出力パスワードを入力してください');
  if (pw !== '5858') { alert('パスワードが正しくありません'); return; }
  const headers = ['申込日','予約日','名前','施術','医院','電話番号','メール','流入元','ステータス'];
  const rows = bookingsData.map(d => [
    d.applyDate, d.bookDate, d.name, d.service, d.facility,
    d.phone ? (String(d.phone).startsWith('0') ? d.phone : '0'+d.phone) : '',
    d.email, d.source, d.status || '未対応'
  ]);
  const bom = '\uFEFF';
  const csv = bom + [headers.join(','), ...rows.map(r => r.map(c => '"'+(c||'').replace(/"/g,'""')+'"').join(','))].join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `予約データ_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function renderPromoDash() {
  const bkExtra = loadData('bk-extra', {});
  const promoGroups = {};
  bookingsData.forEach(d => {
    const p = d.source || '(なし)';
    if (!promoGroups[p]) promoGroups[p] = { total: 0, cancelled: 0, visited: 0, contracted: 0, amount: 0 };
    promoGroups[p].total++;
    if (d.status === 'キャンセル') promoGroups[p].cancelled++;
    if (d.status === '来院済' || d.status === '成約') promoGroups[p].visited++;
    if (d.status === '成約') promoGroups[p].contracted++;
    const key = d.name + '|' + d.applyDate;
    if (bkExtra[key] && bkExtra[key].contractAmount) promoGroups[key] && (promoGroups[p].amount += Number(bkExtra[key].contractAmount));
  });
  // 金額を正しく集計
  Object.keys(bkExtra).forEach(key => {
    if (bkExtra[key].contractAmount) {
      const [name, apply] = key.split('|');
      const match = bookingsData.find(d => d.name === name && d.applyDate === apply);
      if (match) {
        const p = match.source || '(なし)';
        if (promoGroups[p]) promoGroups[p].amount += Number(bkExtra[key].contractAmount);
      }
    }
  });

  const sorted = Object.entries(promoGroups).sort((a, b) => b[1].total - a[1].total);
  const totalAll = sorted.reduce((s, [, v]) => s + v.total, 0);
  const contractedAll = sorted.reduce((s, [, v]) => s + v.contracted, 0);

  document.getElementById('promo-dash-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">プロモ数</span><span class="stat-num">${sorted.length}</span></div>
    <div class="stat-card"><span class="stat-label">総予約数</span><span class="stat-num">${totalAll}</span></div>
    <div class="stat-card"><span class="stat-label">総成約</span><span class="stat-num" style="color:var(--green)">${contractedAll}</span></div>
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

  // テーブル
  document.getElementById('promo-dash-tbody').innerHTML = sorted.map(([name, v]) => {
    const rate = v.visited > 0 ? pct(v.contracted, v.visited) : 0;
    return `<tr>
      <td style="font-size:12px">${name}</td>
      <td>${v.total}</td>
      <td style="color:var(--red)">${v.cancelled}</td>
      <td>${v.visited}</td>
      <td style="color:var(--green)">${v.contracted}</td>
      <td><span style="color:${rate>=30?'var(--green)':'var(--red)'};font-weight:600">${rate}%</span></td>
      <td>${v.amount ? '¥' + fmt(v.amount) : '-'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';
}

function showPromoDetail(promoName) {
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
  const visited = data.filter(d => d.status === '来院済' || d.status === '成約').length;
  const contracted = data.filter(d => d.status === '成約').length;
  let totalAmt = 0;
  data.forEach(d => {
    const key = d.name + '|' + d.applyDate;
    if (bkExtra[key] && bkExtra[key].contractAmount) totalAmt += Number(bkExtra[key].contractAmount);
  });

  document.getElementById('promo-detail-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">予約数</span><span class="stat-num">${total}</span></div>
    <div class="stat-card"><span class="stat-label">キャンセル</span><span class="stat-num" style="color:var(--red)">${cancelled}</span></div>
    <div class="stat-card"><span class="stat-label">来院</span><span class="stat-num">${visited}</span></div>
    <div class="stat-card"><span class="stat-label">成約</span><span class="stat-num" style="color:var(--green)">${contracted}</span></div>
    <div class="stat-card"><span class="stat-label">成約率</span><span class="stat-num">${visited > 0 ? pct(contracted, visited) : 0}%</span></div>
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
