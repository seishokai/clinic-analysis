/* ============================================================
 * 清翔会スタッフ用 Aladdin ログインアカウント作成スクリプト
 *
 * 使い方 (PowerShell):
 *   $env:SUPABASE_SERVICE_KEY = "eyJhbG..."   # Supabase Dashboard の service_role キー
 *   node scripts/create-staff-users.js
 *
 * 出力:
 *   各社員の ID/パスワードを表示し、アカウントを Supabase Auth に作成する。
 *   既存アカウントがある場合はスキップ (password はリセットしない)。
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://ndlfqrvoejwgqfdtghmg.supabase.co';
const KEY = (process.env.SUPABASE_SERVICE_KEY || '').replace(/[^A-Za-z0-9._\-=]/g, '');
if (!KEY) {
  console.error('❌ SUPABASE_SERVICE_KEY 環境変数が未設定です');
  console.error('   PowerShell:   $env:SUPABASE_SERVICE_KEY = "eyJhbG..."');
  process.exit(1);
}

// 追加するスタッフ (id → 表示名)
// 新規追加時はこの配列に足すだけ
const STAFF = [
  { id: 'adachi',   name: '足立' },
  { id: 'uemura',   name: '上村' },
  { id: 'yasui',    name: '安井' },
  { id: 'kitajima', name: '北島' },
  { id: 'maruta',   name: '丸田' },
  { id: 'moriwaki', name: '森脇' },
  { id: 'fukuda',   name: '福田' },
];

const INITIAL_PASSWORD = 'Aladdin2026!';
const EMAIL_DOMAIN = 'aladdin.local';

async function main() {
  const sb = createClient(SUPABASE_URL, KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('清翔会スタッフ用 Aladdin アカウント作成');
  console.log('=========================================');
  console.log(`初期パスワード: ${INITIAL_PASSWORD}`);
  console.log(`(社員は初回ログイン後に必ず変更すること)`);
  console.log('');

  for (const s of STAFF) {
    const email = `${s.id}@${EMAIL_DOMAIN}`;
    process.stdout.write(`[${s.name}] ${email} ... `);
    try {
      const { data, error } = await sb.auth.admin.createUser({
        email,
        password: INITIAL_PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: s.name, staff_id: s.id, role: 'staff' },
      });
      if (error) {
        if (String(error.message).includes('already') || error.status === 422) {
          console.log('⏭  既に存在 (スキップ)');
        } else {
          console.log('❌ ' + error.message);
        }
      } else {
        console.log('✅ 作成');
      }
    } catch (e) {
      console.log('❌ ' + (e.message || e));
    }
  }

  console.log('');
  console.log('=========================================');
  console.log('社員への周知内容 (コピペ用):');
  console.log('=========================================');
  for (const s of STAFF) {
    console.log(`${s.name} さん`);
    console.log(`  ログイン URL: https://seishokai.github.io/clinic-analysis/v600/`);
    console.log(`  社員 ID     : ${s.id}`);
    console.log(`  初期 PW    : ${INITIAL_PASSWORD}`);
    console.log(`  ※ 初回ログイン後、右上「🔑 PW変更」から必ず変更してください`);
    console.log('');
  }
}

main().catch(e => { console.error('❌ Fatal:', e); process.exit(1); });
