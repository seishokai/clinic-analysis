#!/usr/bin/env node
/**
 * check-slots.js — shareconnect 予約枠監視 (v298 Phase 1B)
 *
 * 実行例:
 *   npm run check                    # 全医院チェック → data/reservation-status.json 更新
 *   npm run check:one                # BF銀座のみ (保存しない)
 *   npm run check:debug              # BF銀座を可視ブラウザで詳細ログ
 *
 * 引数:
 *   --only=<医院名>  # 1医院だけチェック (JSON保存スキップ)
 *   --headed         # 可視ブラウザで実行
 *   --debug          # スクリーンショット出力 + 詳細ログ
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ==================== Config ====================
// 矯正無料相談 専用URL (treatment_id=1766627271947)
const BASE_URL = 'https://reserve.shareconnect.co.jp/?r=u5iewf&treatment_ids=1766627271947';
const RANGE_START_DAYS = 14;
const RANGE_END_DAYS = 30;
const TREATMENT_NAME = '矯正無料相談';
const PER_CLINIC_TIMEOUT_MS = 60000;

// shareconnect 上の正式名称と Aladdin 表記のマッピング
// 注: シフト未登録の医院は shareconnect から非表示になるので、エラー = 緊急アラート
const CLINICS = [
  { name: 'BF銀座',   match: 'BF銀座歯科' },
  { name: '大森',     match: '大森駅ファミリー歯科' },
  { name: 'エスカ',   match: 'エスカ歯科' },
  { name: 'アール',   match: '名駅アール歯科' },
  { name: 'ウィズ',   match: '名古屋ウィズ歯科' },
  { name: 'ルミナス', match: '名古屋ルミナス歯科' },
  { name: '茶屋',     match: '茶屋' },  // shareconnect上の正式名称TBD、シフト復活時に確認
  { name: '小牧',     match: 'ワイズ歯科矯正歯科＋KIDS' },
  { name: '知立',     match: 'アピタ知立ファミリー歯科' },
  { name: '八事',     match: '名古屋やごと歯科' },
  { name: '京都',     match: '京都河原町スマイルデザイン歯科' },
];

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
  const file = path.join(dir, `slot_${Date.now()}_${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(()=>{});
}

// ==================== Page interactions ====================

async function waitForClinicList(page) {
  await page.waitForFunction(
    () => /BF銀座|エスカ|アール/.test(document.body?.innerText || ''),
    { timeout: 20000 }
  );
}

async function clickClinic(page, matchText) {
  // 医院ボタン: <button class="group w-full px-4 py-3..."> の中の <h4> にテキスト
  // 全 button から h4 のテキストでマッチ
  const matched = await page.evaluate((needle) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const b of buttons) {
      const h4 = b.querySelector('h4');
      if (h4 && h4.innerText.includes(needle)) {
        b.scrollIntoView({ block: 'center' });
        b.click();
        return h4.innerText.trim();
      }
    }
    return null;
  }, matchText);
  return matched;
}

async function clickTreatment(page, treatmentName) {
  return await page.evaluate((needle) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const b of buttons) {
      const t = (b.innerText || '').trim();
      // 治療ボタン: 「矯正無料相談」のみ + 説明テキスト
      if (t.startsWith(needle) || t.includes(`\n${needle}`) || t === needle) {
        b.scrollIntoView({ block: 'center' });
        b.click();
        return true;
      }
    }
    return false;
  }, treatmentName);
}

async function waitForCalendar(page) {
  await page.waitForFunction(
    () => /\d{4}\s*年\s*\d{1,2}\s*月/.test(document.body?.innerText || ''),
    { timeout: 15000 }
  );
}

async function readCurrentMonth(page) {
  // ヘッダ「2026年 5月」を取得
  return await page.evaluate(() => {
    const m = (document.body.innerText || '').match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (!m) return null;
    return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
  });
}

async function readCalendarAvailability(page, year, month) {
  // カレンダーの日付ボタンを順に読む。disabled=false かつ表示中の月の日付を抽出
  const data = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    // 日付セルらしき button: aspect-square クラスを持つもの (発見済み)
    // 念のためテキストが純粋な数字のものに絞る
    return buttons
      .filter(b => /aspect-square/.test(b.className || '') && /^\d{1,2}$/.test((b.innerText || '').trim()))
      .map(b => ({ day: parseInt(b.innerText.trim(), 10), disabled: b.disabled }));
  });

  // 配列の中で、最初に day=1 が出る位置 = 表示中の月の1日
  // それ以前は前月、最後の方の day=1 以降は翌月
  const firstIdx = data.findIndex(d => d.day === 1);
  if (firstIdx < 0) return [];

  // 表示中の月の日数
  const lastDayOfMonth = new Date(year, month, 0).getDate();

  const available = [];
  for (let i = firstIdx; i < data.length; i++) {
    const d = data[i];
    // 翌月の 1 が来たら終了 (i > firstIdx で d.day=1)
    if (i > firstIdx && d.day === 1) break;
    if (d.day > lastDayOfMonth) break; // 安全網
    if (!d.disabled) {
      available.push(new Date(year, month - 1, d.day));
    }
  }
  return available;
}

async function clickNextMonth(page) {
  return await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const b of buttons) {
      const t = (b.innerText || '').trim();
      if (t === '次の月' || /次の月|翌月|次月/.test(t)) {
        b.scrollIntoView({ block: 'center' });
        b.click();
        return true;
      }
    }
    return false;
  });
}

async function checkClinic(page, clinic, args, range) {
  console.log(`\n[${clinic.name}] チェック開始 (${clinic.match})`);
  const startTime = Date.now();

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForClinicList(page);
  await page.waitForTimeout(800);
  await snap(page, args, `${clinic.name}_1_loaded`);

  // 1. 医院クリック
  const hit = await clickClinic(page, clinic.match);
  if (!hit) throw new Error(`医院非表示（シフト未登録の可能性）`);
  if (args.debug) console.log(`  ✓ 医院選択: ${hit}`);
  await page.waitForTimeout(800);

  // 2. 矯正無料相談 クリック
  const treatOK = await clickTreatment(page, TREATMENT_NAME);
  if (!treatOK) throw new Error(`治療ボタン未検出: ${TREATMENT_NAME}`);
  if (args.debug) console.log(`  ✓ 治療選択: ${TREATMENT_NAME}`);
  await page.waitForTimeout(1500);

  // 3. カレンダー出現待ち
  await waitForCalendar(page);
  await page.waitForTimeout(800);
  await snap(page, args, `${clinic.name}_2_calendar`);

  // 4. 当月読み取り
  const m1 = await readCurrentMonth(page);
  if (!m1) throw new Error('月ヘッダ未検出');
  const month1Avail = await readCalendarAvailability(page, m1.year, m1.month);
  if (args.debug) console.log(`  ${m1.year}年${m1.month}月: 利用可能 ${month1Avail.length}日`);

  // 5. 翌月へ進んで読み取り (range が翌月にまたがる場合)
  let month2Avail = [];
  if (await clickNextMonth(page)) {
    await page.waitForTimeout(2000);
    const m2 = await readCurrentMonth(page);
    if (m2) {
      month2Avail = await readCalendarAvailability(page, m2.year, m2.month);
      if (args.debug) console.log(`  ${m2.year}年${m2.month}月: 利用可能 ${month2Avail.length}日`);
    }
    await snap(page, args, `${clinic.name}_3_next_month`);
  }

  // 6. range で絞り込み
  const all = [...month1Avail, ...month2Avail].sort((a, b) => a - b);
  const inRangeDates = all.filter(d => inRange(d, range));

  const elapsed = Date.now() - startTime;
  console.log(`  ⏱ ${elapsed}ms / 範囲内空き: ${inRangeDates.length}日`);

  return {
    name: clinic.name,
    available: inRangeDates.length > 0,
    availableDays: inRangeDates.length,
    totalSlots: inRangeDates.length, // PoC: 日数を slot 数として代用 (時間帯 × 日数の取得は次フェーズ)
    earliestDate: inRangeDates[0] ? ymd(inRangeDates[0]) : null,
    latestDate: inRangeDates[inRangeDates.length - 1] ? ymd(inRangeDates[inRangeDates.length - 1]) : null,
  };
}

// ==================== Main ====================
async function main() {
  const args = parseArgs();
  const targets = args.only ? CLINICS.filter(c => c.name === args.only) : CLINICS;
  if (targets.length === 0) {
    console.error(`医院が見つかりません: --only=${args.only}`);
    console.error('利用可能:', CLINICS.map(c => c.name).join(', '));
    process.exit(1);
  }

  const range = buildDateRange();
  console.log(`予約枠チェック: ${targets.length}医院 / 治療: ${TREATMENT_NAME}`);
  console.log(`範囲: ${ymd(range.start)} 〜 ${ymd(range.end)} (${RANGE_START_DAYS}〜${RANGE_END_DAYS}日後)`);
  console.log(`URL: ${BASE_URL}`);

  const browser = await chromium.launch({ headless: !args.headed });

  const clinics = [];
  for (const clinic of targets) {
    // 医院ごとに独立コンテキスト (Firestore のセッション状態リーク防止)
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (compatible; SeishokaiSlotMonitor/1.0; +https://seishokai.github.io/clinic-analysis/)',
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(PER_CLINIC_TIMEOUT_MS);
    try {
      const data = await checkClinic(page, clinic, args, range);
      clinics.push(data);
    } catch (e) {
      console.error(`  ✗ [${clinic.name}] ${e.message}`);
      clinics.push({
        name: clinic.name,
        available: false,
        availableDays: 0,
        totalSlots: 0,
        earliestDate: null,
        latestDate: null,
        error: e.message,
      });
    } finally {
      await ctx.close().catch(()=>{});
    }
  }

  await browser.close();

  const output = {
    lastUpdated: new Date().toISOString(),
    checkRangeFrom: ymd(range.start),
    checkRangeTo: ymd(range.end),
    treatment: TREATMENT_NAME,
    source: BASE_URL,
    clinics,
  };

  if (!args.only) {
    const outPath = path.join(__dirname, '..', 'data', 'reservation-status.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
    console.log(`\n✓ 保存: ${outPath}`);
  } else {
    console.log('\n--- Result (--only mode, not saved) ---');
    console.log(JSON.stringify(output, null, 2));
  }

  const alerts = clinics.filter(c => !c.available);
  if (alerts.length > 0) {
    console.log(`\n⚠️  枠未開放/エラー: ${alerts.length}医院 (${alerts.map(c => c.name).join(', ')})`);
  } else {
    console.log('\n✓ 全医院 枠開放済み');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
