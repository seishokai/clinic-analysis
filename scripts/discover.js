#!/usr/bin/env node
/**
 * discover.js — shareconnect 画面構造調査ツール（一回限り、commit対象外）
 *
 * 各ステップでスクリーンショット + HTML スナップショット + 構造サマリーを出力
 *   .debug-screenshots/discover_*.png
 *   .debug-screenshots/discover_*.html
 *   .debug-screenshots/discover_summary.json
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 矯正無料相談 のみ (treatment_id=1766627271947)
const BASE_URL = 'https://reserve.shareconnect.co.jp/?r=u5iewf&treatment_ids=1766627271947';
const OUT_DIR = path.join(__dirname, '..', '.debug-screenshots');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function dump(page, label) {
  const png = path.join(OUT_DIR, `discover_${label}.png`);
  const html = path.join(OUT_DIR, `discover_${label}.html`);
  await page.screenshot({ path: png, fullPage: true });
  fs.writeFileSync(html, await page.content());
  console.log(`  [${label}] PNG=${path.basename(png)}, HTML=${path.basename(html)}`);
}

async function summarizeButtons(page) {
  return await page.evaluate(() => {
    const out = [];
    const all = document.querySelectorAll('button, [role="button"], a');
    for (const el of all) {
      const t = (el.innerText || '').trim().slice(0, 60);
      if (!t) continue;
      const cls = el.className?.toString().slice(0, 80) || '';
      const tag = el.tagName.toLowerCase();
      out.push({ tag, text: t, class: cls });
    }
    return out.slice(0, 100);
  });
}

async function summarizeClinicCards(page) {
  return await page.evaluate(() => {
    // 医院名らしきテキストを含む要素を探索
    const keywords = ['銀座', 'エスカ', 'アール', 'ウィズ', 'ルミナス', '茶屋', '知立', '小牧', '八事', '大森', '京都', '矯正', '歯科'];
    const matches = [];
    document.querySelectorAll('*').forEach(el => {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 200) return;
      const has = keywords.some(k => t.includes(k));
      if (!has) return;
      const tag = el.tagName.toLowerCase();
      if (['html', 'body', 'main', 'section'].includes(tag)) return;
      const childTextEl = Array.from(el.children).filter(c => c.innerText && c.innerText.trim()).length;
      if (childTextEl > 5) return; // 親すぎる要素は除外
      matches.push({
        tag,
        text: t.slice(0, 80),
        class: el.className?.toString().slice(0, 80) || '',
        clickable: ['button', 'a'].includes(tag) || el.hasAttribute('role') || !!el.onclick,
      });
    });
    return matches.slice(0, 50);
  });
}

(async () => {
  console.log('Discovery start →', BASE_URL);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  page.setDefaultTimeout(30000);

  console.log('\n[1] 初期ロード');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  // shareconnect は Firestore の長時間接続があるので networkidle 不可。
  // 代わりに「クリニックを選ぶ」テキストの出現を待つ。
  await page.waitForFunction(
    () => /クリニック|医院|選/.test(document.body?.innerText || ''),
    { timeout: 20000 }
  ).catch(() => console.log('  ⚠ 初期テキスト未検出（タイムアウト）'));
  await page.waitForTimeout(2000);
  await dump(page, '01_initial');
  console.log('  Title:', await page.title());

  const summary = {};
  summary['01_initial'] = {
    title: await page.title(),
    url: page.url(),
    clinicCards: await summarizeClinicCards(page),
    buttons: await summarizeButtons(page),
  };

  // BF銀座 を含む要素をクリック
  console.log('\n[2] BF銀座 候補を検索');
  const bfLocator = page.locator('text=/BF.{0,3}銀座/').first();
  const bfCount = await page.locator('text=/BF.{0,3}銀座/').count();
  console.log('  該当数:', bfCount);

  if (bfCount > 0) {
    try {
      await bfLocator.scrollIntoViewIfNeeded();
      await bfLocator.click({ timeout: 5000 });
      console.log('  → クリック成功');
      await page.waitForTimeout(2500);
      await dump(page, '02_after_clinic');
      summary['02_after_clinic'] = {
        url: page.url(),
        clinicCards: await summarizeClinicCards(page),
        buttons: await summarizeButtons(page),
      };
    } catch (e) {
      console.log('  ✗ クリック失敗:', e.message);
      // 親要素クリックを試す
      try {
        const parent = bfLocator.locator('xpath=ancestor::*[self::button or self::a or @role="button"][1]');
        if (await parent.count() > 0) {
          await parent.first().click();
          console.log('  → 親要素クリック成功');
          await page.waitForTimeout(2500);
          await dump(page, '02_after_clinic');
          summary['02_after_clinic'] = {
            url: page.url(),
            clinicCards: await summarizeClinicCards(page),
            buttons: await summarizeButtons(page),
          };
        }
      } catch (e2) {
        console.log('  ✗ 親も失敗:', e2.message);
      }
    }
  }

  // 矯正相談 を探す
  console.log('\n[3] 矯正相談ボタンを検索');
  const kyoseiCount = await page.locator('text=/矯正相談/').count();
  console.log('  該当数:', kyoseiCount);
  summary['03_kyosei_search'] = { count: kyoseiCount };

  if (kyoseiCount > 0) {
    try {
      await page.locator('text=/矯正相談/').first().click({ timeout: 5000 });
      console.log('  → クリック成功');
      await page.waitForTimeout(2500);
      await dump(page, '03_after_treatment');
      summary['03_after_treatment'] = {
        url: page.url(),
        buttons: await summarizeButtons(page),
      };
    } catch (e) {
      console.log('  ✗ 失敗:', e.message);
    }
  }

  // 「予約内容の確認へ」ボタンをクリックして次のステップへ進む
  console.log('\n[4] 予約内容の確認へ をクリック');
  const confirmBtn = page.locator('button', { hasText: '予約内容の確認へ' }).first();
  if (await confirmBtn.count() > 0) {
    try {
      await confirmBtn.scrollIntoViewIfNeeded();
      await confirmBtn.click();
      console.log('  → クリック成功');
      await page.waitForTimeout(3500);
      await dump(page, '04_after_confirm');
      summary['04_after_confirm'] = {
        url: page.url(),
        bodyText: (await page.evaluate(() => document.body.innerText)).slice(0, 1500),
        buttons: await summarizeButtons(page),
      };
    } catch (e) {
      console.log('  ✗ 失敗:', e.message);
    }
  } else {
    console.log('  ✗ ボタン未検出');
  }

  // カレンダーらしき要素を探す
  console.log('\n[5] カレンダー/日付要素探索');
  const calCheck = await page.evaluate(() => {
    const m = {};
    m.hasMonth = !!document.body.innerText.match(/\d+\s*年\s*\d+\s*月/);
    m.bodyText = document.body.innerText.slice(0, 800);
    m.dayElements = document.querySelectorAll('[class*="day"], [class*="date"], [class*="cell"]').length;
    m.hasCalendar = !!document.querySelector('[class*="calendar"], [class*="cal-"], [aria-label*="カレンダー"]');
    // 数字のみ含む button を集める
    const numberButtons = Array.from(document.querySelectorAll('button')).filter(b => /^\d{1,2}$/.test((b.innerText||'').trim()));
    m.numberButtonCount = numberButtons.length;
    m.numberButtonSample = numberButtons.slice(0, 5).map(b => ({
      text: b.innerText.trim(),
      class: b.className?.toString().slice(0, 100) || '',
      disabled: b.disabled,
      ariaLabel: b.getAttribute('aria-label') || '',
    }));
    return m;
  });
  console.log('  ', JSON.stringify(calCheck, null, 2));
  summary['05_calendar_check'] = calCheck;
  await dump(page, '05_calendar_state');

  // [6] ステップ2画面で 治療一覧を全部抽出
  console.log('\n[6] 治療一覧スキャン');
  const treatments = await page.evaluate(() => {
    // 「治療を選ぶ」セクション以下のテキストブロックを取得
    const sections = Array.from(document.querySelectorAll('h2, h3, h4, [class*="title"], [class*="section"]'));
    const all = Array.from(document.querySelectorAll('button, label, [role="button"], [class*="treatment"], [class*="card"]'));
    const out = [];
    for (const el of all) {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 200) continue;
      // 治療っぽいキーワード
      if (/相談|無料|矯正|インプラント|ホワイトニング|ベニア|矯正|歯科|フィルム|ラミネート/.test(t)) {
        out.push({
          tag: el.tagName.toLowerCase(),
          text: t.slice(0, 100),
          class: el.className?.toString().slice(0, 100) || '',
          checked: el.getAttribute('aria-checked') || el.getAttribute('data-state') || (el.querySelector('input[type=checkbox]')?.checked) || null,
        });
      }
    }
    // 重複除去
    const seen = new Set();
    return out.filter(o => {
      const k = o.text;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
  console.log(`  治療候補: ${treatments.length}個`);
  treatments.slice(0, 30).forEach(t => console.log(`  - [${t.tag}] ${t.text.slice(0, 60)} (checked: ${t.checked})`));
  summary['06_treatments'] = treatments;

  // [7] 矯正相談 を含む選択肢のクリックを試す
  console.log('\n[7] 矯正系の選択肢クリックテスト');
  const kyoseiCandidates = treatments.filter(t => /矯正/.test(t.text)).slice(0, 5);
  console.log(`  矯正系候補: ${kyoseiCandidates.length}個`);
  kyoseiCandidates.forEach(t => console.log(`  - ${t.text.slice(0, 80)}`));

  // [7b] 矯正無料相談 ボタンを直接クリック（治療選択）
  console.log('\n[7b] 矯正無料相談 ボタンを直接クリック');
  const kyoseiBtn = page.locator('button', { hasText: '矯正無料相談' }).first();
  if (await kyoseiBtn.count() > 0) {
    try {
      await kyoseiBtn.scrollIntoViewIfNeeded();
      await kyoseiBtn.click();
      console.log('  → クリック成功');
      await page.waitForTimeout(3500);
      await dump(page, '07b_after_kyosei_click');
      const afterTreat = await page.evaluate(() => ({
        bodyText: document.body.innerText.slice(0, 2500),
        url: location.href,
      }));
      summary['07b_after_kyosei'] = afterTreat;
      console.log('  body[0..500]:', afterTreat.bodyText.slice(0, 500));
    } catch (e) {
      console.log('  ✗ 失敗:', e.message);
    }
  }

  // [8] カレンダー要素探索
  console.log('\n[8] カレンダー要素探索（治療選択後）');
  const confirm2 = page.locator('button', { hasText: '予約内容の確認へ' }).last();
  if (await confirm2.count() > 0) {
    try {
      await confirm2.scrollIntoViewIfNeeded();
      await confirm2.click();
      console.log('  → クリック成功');
      await page.waitForTimeout(4000);
      await dump(page, '08_after_confirm2');
      const cal = await page.evaluate(() => {
        const m = {};
        m.bodyText = document.body.innerText.slice(0, 2000);
        m.url = location.href;
        m.hasMonth = !!document.body.innerText.match(/\d{4}\s*年\s*\d{1,2}\s*月/);
        // 数字のみの button = 日付セル候補
        const numberButtons = Array.from(document.querySelectorAll('button')).filter(b => /^\d{1,2}$/.test((b.innerText||'').trim()));
        m.numberButtonCount = numberButtons.length;
        m.numberButtonSample = numberButtons.slice(0, 32).map(b => ({
          text: b.innerText.trim(),
          class: b.className?.toString().slice(0, 120) || '',
          disabled: b.disabled,
          ariaLabel: b.getAttribute('aria-label') || '',
          ariaDisabled: b.getAttribute('aria-disabled') || '',
        }));
        // 月切替矢印候補
        const monthArrows = Array.from(document.querySelectorAll('button[aria-label], svg, button')).filter(el => {
          const a = el.getAttribute('aria-label') || '';
          return /next|prev|前月|翌月|次月|月へ|chev/i.test(a);
        }).slice(0, 5);
        m.monthArrows = monthArrows.map(b => ({
          tag: b.tagName,
          ariaLabel: b.getAttribute('aria-label') || '',
          class: b.className?.toString().slice(0, 80) || '',
        }));
        return m;
      });
      console.log('  ', JSON.stringify(cal, null, 2));
      summary['08_calendar'] = cal;
    } catch (e) {
      console.log('  ✗ 失敗:', e.message);
    }
  } else {
    console.log('  ✗ 確認ボタン未検出');
  }

  fs.writeFileSync(path.join(OUT_DIR, 'discover_summary.json'), JSON.stringify(summary, null, 2));
  console.log('\n✓ Summary saved:', path.join(OUT_DIR, 'discover_summary.json'));

  await browser.close();
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
