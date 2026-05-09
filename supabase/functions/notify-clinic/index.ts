// =====================================================================
// Supabase Edge Function: notify-clinic
//
// 動作:
//   1. medical_questionnaires に新規 INSERT があると Database Webhook が呼ぶ
//   2. このファンクションは payload.record から問診票内容を抽出
//   3. 医院別メアドを resolveClinicEmail() で解決
//   4. Brevo HTTP API でメール送信 (UTF-8 完全対応)
//
// 環境変数 (Supabase Edge Function Secrets):
//   BREVO_API_KEY:      Brevo の API キー (xkeysib-xxxx...)
//                       https://app.brevo.com/settings/keys/api で生成
//   SENDER_EMAIL:       送信元メアド (Brevo で認証済み、例: seishokai.office@gmail.com)
//   SENDER_NAME:        送信者表示名 (例: 清翔会 事前問診票)
//   FALLBACK_TO_EMAIL:  マップに無い医院の届け先
//
// デプロイ:
//   supabase functions deploy notify-clinic --no-verify-jwt
//
// テスト:
//   curl -X POST https://[project].supabase.co/functions/v1/notify-clinic \
//     -H "Content-Type: application/json" \
//     -d '{"record": { ... }}'
// =====================================================================

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const BREVO_API_KEY      = Deno.env.get('BREVO_API_KEY')      || '';
const SENDER_EMAIL       = Deno.env.get('SENDER_EMAIL')       || 'seishokai.office@gmail.com';
const SENDER_NAME        = Deno.env.get('SENDER_NAME')        || '清翔会 事前問診票';
const FALLBACK_TO_EMAIL  = Deno.env.get('FALLBACK_TO_EMAIL')  || 'seishokai.office@gmail.com';
const APP_URL            = 'https://seishokai.github.io/clinic-analysis/';

// =====================================================================
// 医院別メアドマップ
// =====================================================================
const CLINIC_EMAIL_MAP: Record<string, string> = {
  'BF銀座歯科・矯正歯科':                       'ginzabf.dc@gmail.com',
  '大森駅ファミリー歯科・矯正歯科':              'official@omori-family-dental.com',
  'エスカ歯科・矯正歯科':                       'esukadental@gmail.com',
  '名駅アール歯科・矯正歯科':                   'meieki.rdental@gmail.com',
  '名古屋ウィズ歯科・矯正歯科':                 'nagoya.withdc@gmail.com',
  '名古屋ルミナス歯科・矯正歯科':               'nagoya.luminousdc@gmail.com',
  '名古屋茶屋歯科・矯正歯科':                   'chaya.dental@gmail.com',
  'ワイズ歯科矯正歯科+KIDS イオン小牧店':       'ys.komakikyosei@gmail.com',
  'アピタ知立ファミリー歯科・矯正歯科':         'chiryu.dc@gmail.com',
  '名古屋やごと歯科・矯正歯科 イオン八事店':    'nagoya.yagotodc@gmail.com',
  '京都河原町スマイルデザイン歯科・矯正歯科':   'k.kawaramachi.sddo@gmail.com',
};

// shareconnect の医院名表記が微妙にズレた場合の保険 (キーワード部分一致)
const CLINIC_KEYWORD_FALLBACK: Array<[RegExp, string]> = [
  [/銀座/,     'ginzabf.dc@gmail.com'],
  [/大森/,     'official@omori-family-dental.com'],
  [/エスカ/,   'esukadental@gmail.com'],
  [/名駅|アール/, 'meieki.rdental@gmail.com'],
  [/ウィズ/,   'nagoya.withdc@gmail.com'],
  [/ルミナス/, 'nagoya.luminousdc@gmail.com'],
  [/茶屋/,     'chaya.dental@gmail.com'],
  [/小牧|ワイズ/, 'ys.komakikyosei@gmail.com'],
  [/アピタ|知立/, 'chiryu.dc@gmail.com'],
  [/やごと|八事/, 'nagoya.yagotodc@gmail.com'],
  [/京都|河原町/, 'k.kawaramachi.sddo@gmail.com'],
];

function resolveClinicEmail(clinicName: string): string {
  if (!clinicName) return FALLBACK_TO_EMAIL;
  if (CLINIC_EMAIL_MAP[clinicName]) return CLINIC_EMAIL_MAP[clinicName];
  // 空白除去・小文字化して再確認
  const norm = clinicName.replace(/\s/g, '').toLowerCase();
  for (const [key, email] of Object.entries(CLINIC_EMAIL_MAP)) {
    if (key.replace(/\s/g, '').toLowerCase() === norm) return email;
  }
  // キーワード一致
  for (const [pattern, email] of CLINIC_KEYWORD_FALLBACK) {
    if (pattern.test(clinicName)) return email;
  }
  return FALLBACK_TO_EMAIL;
}

// =====================================================================
// ラベルマップ (生キー → 日本語)
// =====================================================================
const TREATMENT_LABELS: Record<string, string> = {
  kyosei:    '矯正相談',
  bf:        '削らないラミネートベニア',
  implant:   'インプラント',
  whitening: 'ホワイトニング',
  laburie:   'ラミネートベニア',
  general:   '一般診療・その他',
};

const FIELD_LABELS: Record<string, string> = {
  // 矯正
  kyosei_past_consultation:    '今までに矯正治療相談をされたことはありますか？',
  kyosei_consultation_content: '相談したい内容',
  kyosei_concerns:             '矯正治療を受けることに関して、心配な点',
  kyosei_other_questions:      'その他気になること',
  kyosei_age:                  '年齢',
  kyosei_referral_source:      '当院をどこで知りましたか？',
  kyosei_appeal_reason:        '当院が気になった理由',
  // 共通スタブ
  consultation_content: 'ご相談したい内容',
  concerns:             '心配な点',
  age:                  '年齢',
  // 共通医療
  has_underlying_disease:    '現在治療中・通院中のご病気',
  underlying_disease_detail: 'ご病気の内容',
  taking_medication:         '現在服用中のお薬',
  medication_detail:         'お薬の名前',
  has_allergy:               'アレルギー',
  allergy_detail:            'アレルギーの内容',
  is_pregnant:               '妊娠/授乳',
  free_remarks:              'その他連絡事項',
};

const VALUE_LABELS: Record<string, string> = {
  yes: 'はい', no: 'いいえ',
  pregnant: '妊娠中', nursing: '授乳中', possibly: '可能性あり', na: '該当なし',
  instagram_ad:     'インスタ広告',
  facebook_ad:      'Facebook広告',
  google_search_ad: 'ネット(グーグル検索)広告',
  referral:         '知人の紹介',
  monthly_3000:     '月額3,000円〜',
  short_term:       '期間が3ヶ月からと短期間',
  near_station:     '駅から近い',
  invisible:        '透明で気づかれにくい',
  multiple_options: '多数の選択肢から治療を選べる',
  qualified_doctor: 'ちゃんとした歯科医師に診てもらえる',
};

// =====================================================================
// 回答を読みやすいテキストに整形
// =====================================================================
function formatAnswers(answers: Record<string, unknown> | null | undefined): string {
  if (!answers || typeof answers !== 'object') return '(回答なし)';
  const entries = Object.entries(answers);
  if (entries.length === 0) return '(回答なし)';
  return entries.map(([key, value]) => {
    const label = FIELD_LABELS[key] || key;
    let valStr: string;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        valStr = '(未選択)';
      } else {
        valStr = value.map((v) => {
          if (typeof v === 'string' && v.startsWith('other:')) {
            return 'その他: ' + v.substring(6);
          }
          return VALUE_LABELS[String(v)] || String(v);
        }).join('、');
      }
    } else if (value === '' || value == null) {
      valStr = '(空欄)';
    } else {
      valStr = VALUE_LABELS[String(value)] || String(value);
    }
    return `【${label}】\n${valStr}`;
  }).join('\n\n');
}

// =====================================================================
// メール本文を組み立て
// =====================================================================
function buildEmail(record: Record<string, unknown>): { subject: string; body: string } {
  const treatment      = String(record.treatment ?? '');
  const treatmentLabel = TREATMENT_LABELS[treatment] || treatment || '(不明)';
  const clinicName     = String(record.clinic_name ?? '(不明な医院)');
  const patientName    = String(record.patient_name ?? '-');
  const submittedAt    = record.submitted_at
    ? new Date(String(record.submitted_at)).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    : '-';

  const subject = `【問診票】${patientName} 様 / ${treatmentLabel} / ${clinicName}`;

  const body = `事前問診票が記入されました。

━━━━━━━━━━━━━━━━━━━━
■ 基本情報
━━━━━━━━━━━━━━━━━━━━
治療種別: ${treatmentLabel}
クリニック: ${clinicName}
予約日時: ${record.booking_book_date ?? '-'} ${record.booking_book_time ?? ''}

━━━━━━━━━━━━━━━━━━━━
■ 患者情報
━━━━━━━━━━━━━━━━━━━━
お名前: ${patientName}
メール: ${record.patient_email ?? '-'}
電話番号: ${record.patient_phone ?? '-'}
記入日時: ${submittedAt}

━━━━━━━━━━━━━━━━━━━━
■ 回答内容
━━━━━━━━━━━━━━━━━━━━
${formatAnswers(record.treatment_answers as Record<string, unknown>)}
${(record.common_answers && typeof record.common_answers === 'object' && Object.keys(record.common_answers as object).length)
  ? '\n━━━ 医療情報 ━━━\n' + formatAnswers(record.common_answers as Record<string, unknown>)
  : ''}

━━━━━━━━━━━━━━━━━━━━
詳細はアラジン「問診票」タブでご確認ください。
${APP_URL}

問診票ID: ${record.id ?? '-'}
`;

  return { subject, body };
}

// =====================================================================
// HTML エスケープ
// =====================================================================
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// =====================================================================
// Brevo HTTP API でメール送信
// =====================================================================
async function sendViaBrevo(to: string, subject: string, body: string): Promise<{ ok: boolean; id?: string; error?: unknown }> {
  if (!BREVO_API_KEY) {
    return { ok: false, error: 'BREVO_API_KEY が未設定' };
  }

  // body を HTML にラップ (改行を維持)
  const htmlBody = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
<pre style="font-family: -apple-system, 'Segoe UI', 'Hiragino Sans', sans-serif; white-space: pre-wrap; font-size: 14px; line-height: 1.6; margin: 0;">${escapeHtml(body)}</pre>
</body></html>`;

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: {
          name: SENDER_NAME,
          email: SENDER_EMAIL,
        },
        to: [{ email: to }],
        subject: subject,
        htmlContent: htmlBody,
        textContent: body,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data };
    }
    return { ok: true, id: data.messageId || `brevo_${Date.now()}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// =====================================================================
// HTTP ハンドラ (Supabase Database Webhook が呼び出す)
// =====================================================================
serve(async (req) => {
  // CORS preflight (一応対応、Webhook では不要だが手動テスト時用)
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }

  try {
    const payload = await req.json();
    // Supabase Database Webhook 形式: { type, table, record, old_record, schema }
    const record = payload.record || payload; // テスト時に直接 record を投げてもOK
    if (!record || typeof record !== 'object') {
      return new Response(JSON.stringify({ ok: false, error: 'no record' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const clinicName = String(record.clinic_name ?? '');
    const to = resolveClinicEmail(clinicName);
    const { subject, body } = buildEmail(record as Record<string, unknown>);

    // デバッグ: 送信先確認
    console.log('[notify-clinic] SEND:', {
      clinicName,
      resolved_to: to,
      subject,
      brevo_key_set: !!BREVO_API_KEY,
      sender_email: SENDER_EMAIL,
    });

    const result = await sendViaBrevo(to, subject, body);

    if (!result.ok) {
      console.error('[notify-clinic] Brevo error:', result.error);
      return new Response(JSON.stringify({
        ok: false,
        to,
        clinic_name: clinicName,
        error: result.error,
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      to,
      clinic_name: clinicName,
      resend_id: result.id,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[notify-clinic] Exception:', e);
    return new Response(JSON.stringify({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
