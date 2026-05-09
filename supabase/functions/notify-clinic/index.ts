// =====================================================================
// Supabase Edge Function: notify-clinic
//
// 動作:
//   1. medical_questionnaires に新規 INSERT があると Database Webhook が呼ぶ
//   2. このファンクションは payload.record から問診票内容を抽出
//   3. 医院別メアドを resolveClinicEmail() で解決
//   4. Brevo HTTP API でメール送信 (UTF-8 完全対応)
//   5. Google Sheets に問診票を1行追加 (任意・GOOGLE_* secret が設定されてる時のみ)
//
// 環境変数 (Supabase Edge Function Secrets):
//   BREVO_API_KEY:               Brevo の API キー (xkeysib-xxxx...)
//   SENDER_EMAIL:                送信元メアド (Brevo 認証済み)
//   SENDER_NAME:                 送信者表示名
//   FALLBACK_TO_EMAIL:           マップに無い医院の届け先
//   GOOGLE_SHEET_ID:             書き込み先スプレッドシートID (URL から取得)
//   GOOGLE_SERVICE_ACCOUNT_JSON: GCP Service Account JSON 全文
//
// デプロイ:
//   supabase functions deploy notify-clinic --no-verify-jwt
// =====================================================================

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const BREVO_API_KEY                 = Deno.env.get('BREVO_API_KEY')                 || '';
const SENDER_EMAIL                  = Deno.env.get('SENDER_EMAIL')                  || 'seishokai.office@gmail.com';
const SENDER_NAME                   = Deno.env.get('SENDER_NAME')                   || '清翔会 事前問診票';
const FALLBACK_TO_EMAIL             = Deno.env.get('FALLBACK_TO_EMAIL')             || 'seishokai.office@gmail.com';
const GOOGLE_SHEET_ID               = Deno.env.get('GOOGLE_SHEET_ID')               || '';
const GOOGLE_SERVICE_ACCOUNT_JSON   = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')   || '';
const APP_URL                       = 'https://seishokai.github.io/clinic-analysis/';

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
  kyosei_past_consultation: '今までに矯正治療相談をされたことはありますか？',
  kyosei_concern_areas:     '気になっている部位・症状',
  kyosei_concerns:          '心配な点',
  kyosei_age:               '年齢',
  kyosei_referral_source:   '当院をどこで知りましたか？',
  kyosei_appeal_reason:     '当院が気になった理由',
  kyosei_other_questions:   'ご質問・ご要望',
  // BF (削らないラミネートベニア)
  bf_past_treatment:        '過去にラミネート/セラミック治療歴',
  bf_concern_areas:         '気になっている点',
  bf_concerns:              '心配な点',
  bf_age:                   '年齢',
  bf_referral_source:       '当院をどこで知りましたか？',
  bf_appeal_reason:         '当院が気になった理由',
  bf_other_questions:       'ご質問・ご要望',
  // インプラント
  implant_lost_count:        '失った歯の本数',
  implant_lost_period:       '歯を失ってからの期間',
  implant_current_treatment: '現在の対処',
  implant_concerns:          '心配な点',
  implant_age:               '年齢',
  implant_referral_source:   '当院をどこで知りましたか？',
  implant_appeal_reason:     '当院が気になった理由',
  implant_other_questions:   'ご質問・ご要望',
  // ホワイトニング
  whitening_experience:      'ホワイトニング経験',
  whitening_concern_areas:   '気になっている部位',
  whitening_goal:            '希望する仕上がり',
  whitening_concerns:        '心配な点',
  whitening_age:             '年齢',
  whitening_referral_source: '当院をどこで知りましたか？',
  whitening_appeal_reason:   '当院が気になった理由',
  whitening_other_questions: 'ご質問・ご要望',
  // 一般診療
  general_concern_topics:    'ご相談内容',
  general_pain_level:        '痛みの程度',
  general_last_visit:        '最後の歯科受診時期',
  general_concerns:          '心配な点',
  general_age:               '年齢',
  general_referral_source:   '当院をどこで知りましたか？',
  general_appeal_reason:     '当院が気になった理由',
  general_other_questions:   'ご質問・ご要望',
  // 旧スタブ
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
  // 共通
  yes: 'はい', no: 'いいえ',
  pregnant: '妊娠中', nursing: '授乳中', possibly: '可能性あり', na: '該当なし',
  // どこで知ったか (全治療共通)
  instagram_ad:      'インスタ広告',
  facebook_ad:       'Facebook広告',
  tiktok_ad:         'TikTok広告',
  google_search_ad:  'ネット(グーグル検索)広告',
  instagram_account: 'インスタアカウント',
  tiktok_account:    'ティックトックアカウント',
  referral:          '知人の紹介',
  // 矯正 - 気になっている部位・症状
  crowded_teeth:         '歯並びがガタガタ（叢生）',
  maxillary_protrusion:  '出っ歯（上の歯が前に出ている）',
  fang_teeth:            '八重歯',
  gap_teeth:             'すきっ歯',
  mandibular_protrusion: '受け口（下の歯が前に出ている）',
  mouth_protrusion:      '口元のもっこり感',
  biting_concern:        '噛み合わせが気になる',
  // 共通の心配な点 (矯正/BF/インプラント/ホワイトニング/一般 で重複)
  pain:            '痛みが心配',
  cost:            '費用が心配',
  duration:        '治療期間が心配',
  appearance:      '装置の見た目が気になる',
  eating:          '食事の制限が心配',
  visit_frequency: '通院頻度が心配',
  no_concern:      '特に心配なし',
  // 矯正 - 当院が気になった理由
  monthly_3000:     '月額3,000円〜から始められる',
  short_term:       '短期間（最短〜）で完了',
  invisible:        '透明で目立たない（マウスピース矯正）',
  partial_kyosei:   '部分矯正もできる',
  campaign:         '学割・キャンペーンがある',
  near_station:     '駅から近い',
  qualified_doctor: '経験豊富な歯科医師',
  multiple_options: '多数の選択肢から治療を選べる',
  // BF - 気になっている点
  tooth_color:    '歯の色が気になる',
  tooth_shape:    '歯の形が気になる',
  minor_crowding: '歯並びの軽い乱れ',
  chipped_tooth:  '欠けた歯の修復',
  silver_crown:   '銀歯を白くしたい',
  overall_look:   '全体的な見た目を整えたい',
  // BF - 心配な点
  durability:   'もちのよさが心配',
  natural_look: '自然な見た目になるか',
  visit_count:  '通院回数が心配',
  // BF - 当院が気になった理由
  no_drilling:      '歯を削らない',
  no_pain:          '痛くない・麻酔不要',
  natural_finish:   '自然な仕上がり（オーダーメイド）',
  special_occasion: '結婚式・特別な日に間に合う',
  reversible:       'もとに戻せる（可逆的な治療）',
  // インプラント - 失った歯の本数
  '1': '1本', '2to3': '2〜3本', '4plus': '4本以上', unknown: 'わからない',
  // インプラント - 失ってからの期間
  within_1m: '1ヶ月以内',
  within_6m: '半年以内',
  within_1y: '1年以内',
  years:     '数年経過',
  // インプラント - 現在の対処
  denture:   '入れ歯を使っている',
  bridge:    'ブリッジを入れている',
  temporary: '仮歯',
  untreated: 'そのまま放置',
  // インプラント - 心配な点
  surgery:    '手術が怖い',
  anesthesia: '麻酔が心配',
  underlying: '持病がある',
  // インプラント - 当院が気になった理由
  experienced:     '医師の症例数・経験豊富',
  equipment:       'CT・手術室など設備充実',
  painless:        '痛みに配慮した治療',
  warranty:        '長期保証あり',
  same_day:        '即日インプラント対応',
  cost_acceptable: '費用感が合った',
  // ホワイトニング - 経験
  first_time: '初めて',
  clinic:     'クリニックで経験あり',
  home_kit:   '自宅キットで経験あり',
  both:       '両方経験あり',
  // ホワイトニング - 気になっている部位
  all_teeth:          '歯全体の色',
  front_teeth:        '前歯だけ',
  specific_teeth:     '1〜2本だけ変色',
  visible_when_smile: '笑った時に見える歯',
  dead_tooth:         '失活歯（神経のない歯）',
  around_filling:     '詰め物の周辺',
  // ホワイトニング - 仕上がり
  natural:     '自然な白さ',
  clear_white: 'はっきり白く',
  celebrity:   '芸能人並みに白く',
  wedding:     '結婚式・特別な日に向けて',
  job_hunting: '就活・面接に向けて',
  undecided:   '特に決まっていない',
  // ホワイトニング - 心配な点
  sensitivity:   'しみるのが心配',
  rebound:       '後戻り',
  effectiveness: '効果があるか',
  // ホワイトニング - 当院が気になった理由
  professional:  '歯科医院でしっかり施術したい',
  home:          '自宅で続けられる（ホームホワイトニング）',
  long_lasting:  '持続期間が長い',
  // 一般診療 - ご相談内容
  cavity:       '虫歯の治療',
  gum_disease:  '歯ぐきの腫れ・出血',
  checkup:      '定期検診・クリーニング',
  crown_repair: '詰め物・かぶせ物の修理',
  wisdom_tooth: '親知らず',
  // 一般診療 - 痛みの程度
  no_pain_lvl:      '痛みなし',  // collision avoidance (使われない)
  discomfort:       '違和感程度',
  biting_pain:      '噛むと痛い',
  cold_sensitive:   '冷たいものでしみる',
  spontaneous_pain: '何もしなくても痛い',
  throbbing:        'ズキズキする',
  // 一般診療 - 最後の歯科受診時期
  '1to2y': '1〜2年前',
  '3to5y': '3〜5年前',
  over_5y: '5年以上前',
  // 一般診療 - 心配な点
  unknown_proc: '何をされるか不安',
  // 一般診療 - 当院が気になった理由
  clear_explain:    '説明がわかりやすい',
  emergency:        '急患対応してもらえる',
  insurance:        '保険診療',
  modern_equipment: '設備が新しい',
  good_atmosphere:  '院内の雰囲気がよい',
};

// =====================================================================
// 回答をコンパクトに整形 (Google Sheets セル用)
// 形式: ラベル: 値\nラベル: 値\n...
// 値が空の項目はスキップ
// =====================================================================
function formatAnswersCompact(answers: Record<string, unknown> | null | undefined): string {
  if (!answers || typeof answers !== 'object') return '';
  const entries = Object.entries(answers);
  if (entries.length === 0) return '';
  const lines: string[] = [];
  for (const [key, value] of entries) {
    const label = FIELD_LABELS[key] || key;
    let valStr = '';
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      valStr = value.map((v) => {
        if (typeof v === 'string' && v.startsWith('other:')) {
          return 'その他: ' + v.substring(6);
        }
        return VALUE_LABELS[String(v)] || String(v);
      }).join('、');
    } else if (value === '' || value == null) {
      continue;
    } else {
      valStr = VALUE_LABELS[String(value)] || String(value);
    }
    lines.push(`${label}: ${valStr}`);
  }
  return lines.join('\n');
}

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
// Google Sheets API: Service Account JWT → access token → 行追加
// =====================================================================
function base64UrlEncode(s: string | Uint8Array): string {
  const bin = typeof s === 'string' ? s : String.fromCharCode(...s);
  return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

let cachedAccessToken: { token: string; exp: number } | null = null;

async function getGoogleAccessToken(): Promise<string> {
  // 5分以上残ってたらキャッシュ流用
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessToken.exp > now + 300) {
    return cachedAccessToken.token;
  }
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 未設定');

  const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const claimB64  = base64UrlEncode(JSON.stringify(claim));
  const signingInput = `${headerB64}.${claimB64}`;

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );
  const sigB64 = base64UrlEncode(new Uint8Array(sigBuf));
  const jwt = `${signingInput}.${sigB64}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${JSON.stringify(tokenData)}`);
  }
  cachedAccessToken = {
    token: tokenData.access_token,
    exp: now + (tokenData.expires_in || 3600),
  };
  return tokenData.access_token;
}

// 単一フィールドの値を読みやすい文字列に変換
function getFieldValue(answers: Record<string, unknown> | undefined | null, fieldKey: string): string {
  if (!answers || typeof answers !== 'object') return '';
  const value = (answers as Record<string, unknown>)[fieldKey];
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    return value.map(v => {
      if (typeof v === 'string' && v.startsWith('other:')) return 'その他: ' + v.substring(6);
      return VALUE_LABELS[String(v)] || String(v);
    }).join('、');
  }
  return VALUE_LABELS[String(value)] || String(value);
}

async function appendToGoogleSheet(record: Record<string, unknown>): Promise<{ ok: boolean; error?: unknown }> {
  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_JSON) {
    return { ok: false, error: 'GOOGLE_SHEET_ID または GOOGLE_SERVICE_ACCOUNT_JSON 未設定 (Sheets連携スキップ)' };
  }
  try {
    const token = await getGoogleAccessToken();
    const treatmentRaw = String(record.treatment ?? 'general');
    // 旧 laburie は bf に集約
    const t = treatmentRaw === 'laburie' ? 'bf' : treatmentRaw;
    const treatmentLabel = TREATMENT_LABELS[t] || t;
    const submittedAt = (() => {
      const v = record.submitted_at || record.created_at;
      if (!v) return '';
      try {
        const d = new Date(String(v));
        if (Number.isNaN(d.getTime())) return String(v);
        // JST 日時表示 (Sheetsで読みやすい形式)
        const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
        return jst.toISOString().replace('T', ' ').slice(0, 19);
      } catch { return String(v); }
    })();

    // 治療回答から「マーケティング系」5項目を抽出
    const a = (record.treatment_answers as Record<string, unknown>) || {};
    const age            = getFieldValue(a, `${t}_age`);
    const referralSource = getFieldValue(a, `${t}_referral_source`);
    const appealReason   = getFieldValue(a, `${t}_appeal_reason`);
    const concerns       = getFieldValue(a, `${t}_concerns`);
    const otherQuestions = getFieldValue(a, `${t}_other_questions`);
    // 主な症状/悩み: 治療によってフィールド名が違う
    let mainSymptom = '';
    if (t === 'general') {
      mainSymptom = getFieldValue(a, 'general_concern_topics');
    } else if (t !== 'implant') {
      mainSymptom = getFieldValue(a, `${t}_concern_areas`);
    }
    // 治療別詳細: 上記7項目以外の treatment_answers をフォーマット
    const usedKeys = new Set([
      `${t}_age`, `${t}_referral_source`, `${t}_appeal_reason`,
      `${t}_concerns`, `${t}_other_questions`,
      `${t}_concern_areas`, 'general_concern_topics',
    ]);
    const remaining: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) {
      if (!usedKeys.has(k)) remaining[k] = v;
    }
    // 共通医療情報も「治療別詳細」に統合 (現状未使用だが将来用)
    const commonExtra = formatAnswersCompact(record.common_answers as Record<string, unknown>);
    const treatmentDetails = [formatAnswersCompact(remaining), commonExtra].filter(Boolean).join('\n---\n');

    const values = [[
      submittedAt,                              // A: 提出日時
      treatmentLabel,                            // B: 治療
      String(record.patient_name  ?? ''),       // C: 名前
      String(record.patient_email ?? ''),       // D: メール
      String(record.patient_phone ?? ''),       // E: 電話
      String(record.clinic_name   ?? ''),       // F: 医院
      String(record.booking_book_date ?? ''),   // G: 予約日
      String(record.booking_book_time ?? ''),   // H: 予約時間
      age,                                       // I: 年齢
      referralSource,                            // J: 認知経路
      appealReason,                              // K: 気になった理由
      mainSymptom,                               // L: 主な症状/悩み
      concerns,                                  // M: 心配な点
      treatmentDetails,                          // N: 治療別詳細
      otherQuestions,                            // O: ご質問・ご要望
    ]];
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: err };
    }
    return { ok: true };
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

    // Google Sheets に追記 (失敗してもメール送信は成功扱い)
    let sheetResult: { ok: boolean; error?: unknown } = { ok: false, error: 'skipped' };
    if (GOOGLE_SHEET_ID && GOOGLE_SERVICE_ACCOUNT_JSON) {
      sheetResult = await appendToGoogleSheet(record as Record<string, unknown>);
      if (sheetResult.ok) {
        console.log('[notify-clinic] Sheets append success');
      } else {
        console.error('[notify-clinic] Sheets append error:', sheetResult.error);
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      to,
      clinic_name: clinicName,
      brevo_id: result.id,
      sheet_appended: sheetResult.ok,
      sheet_error: sheetResult.ok ? undefined : sheetResult.error,
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
