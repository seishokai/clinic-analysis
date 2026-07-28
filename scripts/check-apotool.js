#!/usr/bin/env node
/**
 * check-apotool.js — Apotool / Box for Dentist 予約枠監視
 *
 * 相方: scripts/check-slots.js (shareconnect 版) と同じフローで、
 * Apotool の医院ごとの予約 URL から矯正相談枠を集める。
 *
 * 実行例:
 *   npm run check:apotool             # 全医院チェック → data/apotool-status.json 更新
 *   node scripts/check-apotool.js --headed --debug
 *
 * 引数:
 *   --only=<医院名>  # 1医院だけ (保存スキップ)
 *   --headed         # 可視ブラウザ
 *   --debug          # スクリーンショット出力 + 詳細ログ
 *
 * shareconnect との違い:
 *   - shareconnect: 1 つの URL に「医院選択 → 治療選択」を含む
 *   - Apotool:      医院ごとに URL が分かれている (ハッシュ付き)
 *                   ページ内で「治療メニュー」を選ぶ → カレンダー
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ==================== Config ====================
// 各医院の Apotool 予約 URL
// 追加する場合はこの配列に entry を足す (name は Aladdin 側の表記に合わせる)
const CLINICS = [
  {
    name: 'BF銀座',
    url:  'https://reservation.stransa.co.jp/d92670320b27d9f98cd77e608efc6698/reserve/select-menu',
  },
];

// メニュー名 (Apotool 上のボタン文字列)
// 「矯正相談」「無料矯正相談」等どちらでも拾えるようにワードリスト
const TREATMENT_KEYWORDS = ['矯正相談', '矯正無料相談', '矯正カウンセリング'];
const RANGE_START_DAYS = 0;    // 今日から
const RANGE_END_DAYS   = 60;   // 2ヶ月先まで (拓未さん指示)
const PER_CLINIC_TIMEOUT_MS = 90000;
const MAX_MONTHS_TO_SCAN = 3;  // 2ヶ月分 + 予備

// ==================== Utils ====================
function parseArgs() {
  const a = { headed: false, debug: false, only: null };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--headed') a.headed = true;
    if (arg === '--debug') a.debug = true;
    if (arg.startsWith('--only=')) a.only = arg.slice(7);
  }
  if (process.env.DEBUG) a.debug = true;
  return a;
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function buildDateRange() {
  const now = new Date();
  const start = new Date(now); start.setHours(0,0,0,0);
  start.setDate(start.getDate() + RANGE_START_DAYS);
  const end = new Date(now); end.setHours(0,0,0,0);
  end.setDate(end.getDate() + RANGE_END_DAYS);
  return { start, end };
}

function inRange(d, range) {
  return d.getTime() >= range.start.getTime() && d.getTime() <= range.end.getTime();
}

async function snap(page, args, name) {
  if (!args.debug) return;
  const dir = path.join(__dirname, '..', '.debug-screenshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `apotool_${Date.now()}_${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(()=>{});
}

// ==================== Page interactions ====================
// SPA なので描画完了まで待つ

async function waitForMenuList(page) {
  // メニューリストが出るまで待つ (「予約」「メニュー」「相談」等の文字列を期待)
  await page.waitForFunction(
    () => /予約|メニュー|相談|カウンセリング|診療/.test(document.body?.innerText || ''),
    { timeout: 20000 }
  );
}

async function clickMenuByKeyword(page, keywords) {
  // メニューボタンから keyword を含むものを探してクリック
  return await page.evaluate((needles) => {
    // まず一般的な button 要素、次に a 要素、次に li/div のクリック要素で探す
    const candidates = [
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('a[href]'),
      ...document.querySelectorAll('[role="button"]'),
      ...document.querySelectorAll('li[class*="menu"], div[class*="menu"]'),
    ];
    for (const el of candidates) {
      const text = ((el.innerText || el.textContent) || '').trim();
      if (!text) continue;
      for (const n of needles) {
        if (text.includes(n)) {
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { hit: n, text: text.slice(0, 80) };
        }
      }
    }
    return null;
  }, keywords);
}

async function waitForCalendar(page) {
  await page.waitForFunction(
    () => /\d{4}\s*年\s*\d{1,2}\s*月|\d{4}[\/\-]\d{1,2}/.test(document.body?.innerText || ''),
    { timeout: 20000 }
  );
}

async function readCurrentMonth(page) {
  return await page.evaluate(() => {
    const t = document.body?.innerText || '';
    let m = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (m) return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
    m = t.match(/(\d{4})[\/\-](\d{1,2})/);
    if (m) return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
    return null;
  });
}

async function readCalendarAvailability(page, year, month) {
  // カレンダーの各日ボタン取得。日付は 1〜31 の数字テキスト
  const data = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, td[role="button"], div[role="button"]'));
    return buttons
      .filter(b => {
        const t = ((b.innerText || b.textContent) || '').trim();
        return /^\d{1,2}$/.test(t);
      })
      .map(b => {
        const cls = (b.className || '') + ' ' + (b.getAttribute('aria-disabled') || '');
        const isDisabled = b.disabled
          || b.getAttribute('aria-disabled') === 'true'
          || /disabled|unavail|noselect|closed|off|empty|not-available/i.test(cls);
        return {
          day: parseInt(((b.innerText || b.textContent) || '').trim(), 10),
          disabled: isDisabled,
        };
      });
  });

  const firstIdx = data.findIndex(d => d.day === 1);
  if (firstIdx < 0) return [];
  const lastDayOfMonth = new Date(year, month, 0).getDate();

  const available = [];
  for (let i = firstIdx; i < data.length; i++) {
    const d = data[i];
    if (i > firstIdx && d.day === 1) break;
    if (d.day > lastDayOfMonth) break;
    if (!d.disabled) available.push(new Date(year, month - 1, d.day));
  }
  return available;
}

async function clickNextMonth(page) {
  return await page.evaluate(() => {
    // ボタン、aria-label、SVG 兄弟テキスト、記号 (>, ›, ▶, 次) から検出
    const els = Array.from(document.querySelectorAll('button, [role="button"], a'));
    for (const el of els) {
      const t = ((el.innerText || el.textContent) || '').trim();
      const label = (el.getAttribute('aria-label') || '').trim();
      if (
        /次の月|翌月|次月|次へ|Next/i.test(t) ||
        /次の月|翌月|next\s*month/i.test(label) ||
        /^[>›»]$/.test(t) ||
        el.querySelector?.('.arrow-next, .fa-chevron-right, .icon-next')
      ) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }
    }
    return false;
  });
}

async function clickDateAndCountTimeSlots(page, day) {
  const clicked = await page.evaluate((d) => {
    const buttons = Array.from(document.querySelectorAll('button, td[role="button"], div[role="button"]'));
    for (const b of buttons) {
      const t = ((b.innerText || b.textContent) || '').trim();
      if (t === String(d) && !b.disabled) {
        b.scrollIntoView({ block: 'center' });
        b.click();
        return true;
      }
    }
    return false;
  }, day);
  if (!clicked) return 0;

  await page.waitForTimeout(900);

  // 時間枠らしきボタン (HH:MM 形式) をカウント
  return await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], a'));
    return els.filter(el => {
      const t = ((el.innerText || el.textContent) || '').trim();
      return /^\d{1,2}:\d{2}$/.test(t) && !el.disabled;
    }).length;
  });
}

// ==================== 医院チェック本体 ====================

async function checkClinic(page, clinic, args, range) {
  console.log(`\n[${clinic.name}] チェック開始`);
  const startTime = Date.now();

  await page.goto(clinic.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForMenuList(page);
  await page.waitForTimeout(1200);
  await snap(page, args, `${clinic.name}_1_menu`);

  // 1. メニュー選択 (矯正相談)
  const menuHit = await clickMenuByKeyword(page, TREATMENT_KEYWORDS);
  if (!menuHit) throw new Error(`メニュー未検出: ${TREATMENT_KEYWORDS.join(' / ')}`);
  if (args.debug) console.log(`  ✓ メニュー選択: ${menuHit.hit} (${menuHit.text})`);
  await page.waitForTimeout(1500);
  await snap(page, args, `${clinic.name}_2_after_menu`);

  // 2. カレンダー描画待ち
  await waitForCalendar(page);
  await page.waitForTimeout(800);
  await snap(page, args, `${clinic.name}_3_calendar`);

  // 3. 月をまたぎながら範囲内の空き日を全部集める
  const availableDays = [];
  for (let mi = 0; mi < MAX_MONTHS_TO_SCAN; mi++) {
    const now = await readCurrentMonth(page);
    if (!now) break;
    const monthAvail = await readCalendarAvailability(page, now.year, now.month);
    for (const d of monthAvail) {
      if (inRange(d, range)) availableDays.push(d);
    }
    // 範囲末尾より先の月に入ったら終了
    const monthLastDay = new Date(now.year, now.month, 0);
    if (monthLastDay.getTime() >= range.end.getTime()) break;
    // 次月へ
    const nextClicked = await clickNextMonth(page);
    if (!nextClicked) break;
    await page.waitForTimeout(1200);
  }
  if (args.debug) console.log(`  ✓ 範囲内空き日数: ${availableDays.length}`);

  // 4. 空き日を上から順に開いて時間枠を数える (負荷抑制で最大 12 日)
  const perDay = [];
  const daysToSample = availableDays.slice(0, 12);
  for (const d of daysToSample) {
    // カレンダー戻し (念のため)
    // ここでは Apotool は日クリックで時間枠を横に出す前提 → もう一度カレンダーへ戻る
    // 最悪リトライ: 数え終わったらメニューから再突入
    const slots = await clickDateAndCountTimeSlots(page, d.getDate());
    perDay.push({ date: ymd(d), slotCount: slots });
    // 日クリックによってページが遷移しないよう「戻る」を試みる
    await page.evaluate(() => window.history.back()).catch(() => {});
    await page.waitForTimeout(600);
  }
  const totalSlots = perDay.reduce((s, x) => s + x.slotCount, 0);
  const elapsedMs = Date.now() - startTime;

  console.log(`[${clinic.name}] ✓ 空き日${availableDays.length}日 / 集計スロット${totalSlots}件 (${elapsedMs}ms)`);
  return {
    name: clinic.name,
    available: availableDays.length > 0,
    availableDays: availableDays.length,
    availableSlots: totalSlots,
    lastAvailableDate: availableDays.length ? ymd(availableDays[availableDays.length - 1]) : null,
    perDaySample: perDay,
    elapsedMs,
  };
}

// ==================== メイン ====================

async function main() {
  const args = parseArgs();
  const range = buildDateRange();
  console.log('==== Apotool 予約枠 定期チェック ====');
  console.log(`範囲: ${ymd(range.start)} 〜 ${ymd(range.end)} (${RANGE_START_DAYS}〜${RANGE_END_DAYS}日後)`);
  console.log(`医院数: ${CLINICS.length}`);

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1280, height: 900 },
  });

  const clinics = args.only ? CLINICS.filter(c => c.name === args.only) : CLINICS;
  const results = [];
  for (const c of clinics) {
    const page = await context.newPage();
    try {
      const r = await Promise.race([
        checkClinic(page, c, args, range),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), PER_CLINIC_TIMEOUT_MS)),
      ]);
      results.push(r);
    } catch (e) {
      console.error(`[${c.name}] エラー: ${e.message}`);
      results.push({
        name: c.name,
        available: null,
        error: e.message,
      });
    } finally {
      await page.close().catch(()=>{});
    }
  }

  await browser.close();

  const summary = {
    checkedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    source: 'apotool',
    checkRangeFrom: ymd(range.start),
    checkRangeTo: ymd(range.end),
    treatment: '矯正相談',
    clinics: results,
  };

  if (!args.only) {
    const outDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'apotool-status.json');
    fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`\n✓ 書き込み完了: ${outFile}`);
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }

  const failures = results.filter(r => r.error).length;
  console.log(`\n合計: 成功 ${results.length - failures} / 失敗 ${failures}`);
}

main().catch(e => { console.error(e); process.exit(1); });
