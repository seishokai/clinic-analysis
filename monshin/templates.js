// =====================================================================
// 治療別 問診票テンプレート (Vanilla JS 版)
// 元: monshin-app/src/lib/questionnaire-templates/*.ts
//
// 各テンプレートは {treatment, title, description, includeCommonMedical,
//                  sections:[{id,title,description,fields:[...]}] } 形式
//
// 共通: COMMON_MEDICAL_FIELDS は すべての treatment で末尾に自動付与
// =====================================================================

const COMMON_MEDICAL_FIELDS = [
  {
    id: 'common_medical',
    title: '医療情報のご確認',
    description: '安全な治療のため、必ずお答えください。',
    fields: [
      {
        name: 'has_underlying_disease',
        label: '現在治療中・通院中のご病気はありますか？',
        type: 'radio',
        required: true,
        options: [
          { value: 'no',  label: 'いいえ' },
          { value: 'yes', label: 'はい' },
        ],
      },
      {
        name: 'underlying_disease_detail',
        label: 'ご病気の内容をご記入ください',
        type: 'textarea',
        required: false,
        placeholder: '（例）高血圧、糖尿病、心臓病、肝臓病 など',
        showWhen: { field: 'has_underlying_disease', equals: 'yes' },
      },
      {
        name: 'taking_medication',
        label: '現在服用中のお薬はありますか？',
        type: 'radio',
        required: true,
        options: [
          { value: 'no',  label: 'いいえ' },
          { value: 'yes', label: 'はい' },
        ],
      },
      {
        name: 'medication_detail',
        label: 'お薬の名前をご記入ください',
        type: 'textarea',
        required: false,
        placeholder: '（例）血液をサラサラにするお薬、ビスフォスフォネート 等',
        showWhen: { field: 'taking_medication', equals: 'yes' },
      },
      {
        name: 'has_allergy',
        label: 'アレルギーはありますか？（薬・金属・食物 等）',
        type: 'radio',
        required: true,
        options: [
          { value: 'no',  label: 'いいえ' },
          { value: 'yes', label: 'はい' },
        ],
      },
      {
        name: 'allergy_detail',
        label: 'アレルギーの内容をご記入ください',
        type: 'textarea',
        required: false,
        placeholder: '（例）ペニシリン、金属、ラテックス 等',
        showWhen: { field: 'has_allergy', equals: 'yes' },
      },
      {
        name: 'is_pregnant',
        label: '現在妊娠中・授乳中、または妊娠の可能性はありますか？',
        type: 'radio',
        required: false,
        options: [
          { value: 'no',         label: 'いいえ' },
          { value: 'pregnant',   label: '妊娠中' },
          { value: 'nursing',    label: '授乳中' },
          { value: 'possibly',   label: '可能性あり' },
          { value: 'na',         label: '該当なし（男性 等）' },
        ],
      },
      {
        name: 'free_remarks',
        label: 'その他、医師にお伝えしたいことがあればご記入ください',
        type: 'textarea',
        required: false,
      },
    ],
  },
];

// =====================================================================
// 矯正相談
// =====================================================================
const KYOSEI_TEMPLATE = {
  treatment: 'kyosei',
  title: '矯正相談 事前問診票',
  description:
    'ご来院前に、いくつかご質問にお答えください。スタッフ・ドクターが事前に内容を把握し、当日のご相談がスムーズになります。',
  includeCommonMedical: false,
  sections: [
    {
      id: 'kyosei_consultation',
      title: 'ご相談内容',
      fields: [
        {
          name: 'kyosei_past_consultation',
          label: '今までに矯正治療相談をされたことはありますか？',
          type: 'radio',
          required: true,
          options: [
            { value: 'yes', label: 'はい' },
            { value: 'no',  label: 'いいえ' },
          ],
        },
        {
          name: 'kyosei_consultation_content',
          label: '相談したい内容を具体的にご記入ください',
          description:
            '（例）前歯のがたつきが気になる／口元がもごっとして見える／きちんと噛めない　など',
          type: 'textarea',
          required: true,
          placeholder:
            '気になっている部位や、ご希望の仕上がりイメージなど自由にご記入ください',
        },
        {
          name: 'kyosei_concerns',
          label: '矯正治療を受けることに関して、心配な点はありますか？',
          description:
            '（例）痛みが心配／費用が心配／治療期間が心配／見た目が気になる　など',
          type: 'textarea',
          required: false,
          placeholder: '心配な点があればご記入ください',
        },
        {
          name: 'kyosei_other_questions',
          label: 'その他気になることはありますか？',
          type: 'textarea',
          required: false,
          placeholder: '当日ご相談したいことがあればご記入ください',
        },
        {
          name: 'kyosei_age',
          label: '年齢を教えてください',
          type: 'number',
          required: true,
          min: 0,
          max: 120,
          step: 1,
          placeholder: '例) 32',
        },
      ],
    },
    {
      id: 'kyosei_marketing',
      title: '当院について',
      description: 'よりよいご案内のため、ご来院のきっかけについてお聞かせください。',
      fields: [
        {
          name: 'kyosei_referral_source',
          label: '{clinic_name}をどこで知りましたか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'instagram_ad',     label: 'インスタ広告' },
            { value: 'facebook_ad',      label: 'Facebook広告' },
            { value: 'google_search_ad', label: 'ネット(グーグル検索)広告' },
            { value: 'referral',         label: '知人の紹介' },
          ],
          allowOther: true,
        },
        {
          name: 'kyosei_appeal_reason',
          label: '当院が気になった理由はどれですか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'monthly_3000',     label: '月額3,000円〜' },
            { value: 'short_term',       label: '期間が3ヶ月からと短期間' },
            { value: 'near_station',     label: '駅から近い' },
            { value: 'invisible',        label: '透明で気づかれにくい' },
            { value: 'multiple_options', label: '多数の選択肢から治療を選べる' },
            { value: 'qualified_doctor', label: 'ちゃんとした歯科医師に診てもらえる' },
          ],
          allowOther: true,
        },
      ],
    },
  ],
};

// =====================================================================
// 他の治療 (現状は最小スタブ。後で本実装に差し替え)
// =====================================================================
const STUB_FIELDS = [
  {
    id: 'stub_main',
    title: 'ご相談内容',
    description: '当日のご相談に向けて、お聞きしたい内容です。',
    fields: [
      {
        name: 'consultation_content',
        label: 'ご相談したい内容を具体的にご記入ください',
        type: 'textarea',
        required: true,
        placeholder: '気になっている部位や、ご希望の内容を自由にご記入ください',
      },
      {
        name: 'concerns',
        label: '治療を受けることに関して、心配な点はありますか？',
        type: 'textarea',
        required: false,
      },
      {
        name: 'age',
        label: '年齢を教えてください',
        type: 'number',
        required: true,
        min: 0,
        max: 120,
      },
    ],
  },
];

const BF_TEMPLATE        = { treatment: 'bf',        title: 'ブラックフィルム相談 事前問診票',     includeCommonMedical: false, sections: STUB_FIELDS };
const IMPLANT_TEMPLATE   = { treatment: 'implant',   title: 'インプラント相談 事前問診票',         includeCommonMedical: false, sections: STUB_FIELDS };
const WHITENING_TEMPLATE = { treatment: 'whitening', title: 'ホワイトニング相談 事前問診票',       includeCommonMedical: false, sections: STUB_FIELDS };
const LABURIE_TEMPLATE   = { treatment: 'laburie',   title: 'ラブリエ相談 事前問診票',             includeCommonMedical: false, sections: STUB_FIELDS };
const GENERAL_TEMPLATE   = { treatment: 'general',   title: '事前問診票',                           includeCommonMedical: false, sections: STUB_FIELDS };

const TEMPLATES = {
  kyosei:    KYOSEI_TEMPLATE,
  bf:        BF_TEMPLATE,
  implant:   IMPLANT_TEMPLATE,
  whitening: WHITENING_TEMPLATE,
  laburie:   LABURIE_TEMPLATE,
  general:   GENERAL_TEMPLATE,
};

// =====================================================================
// detectTreatment: 文字列から治療種別を判定
// 用途:
//   - URL の treatment パラメータ
//   - manual_bookings.service ("矯正" 等)
//   - manual_bookings.source  ("third_kyosei_inst" 等)
// =====================================================================
function detectTreatment(input) {
  if (!input) return null;
  const s = String(input).toLowerCase().normalize('NFKC');
  if (/bf|black\s*film|ブラック|ﾌﾞﾗｯｸ|ラミネート|laminate/i.test(s))                return 'bf';
  if (/矯正|kyosei|kyousei|invisalign|インビザ|ワイヤー|マウスピース|aligner/i.test(s)) return 'kyosei';
  if (/インプラント|implant/i.test(s))                                                  return 'implant';
  if (/ホワイトニング|whitening|ホワイト|wt/i.test(s))                                  return 'whitening';
  if (/ラブリエ|laburie|labu/i.test(s))                                                 return 'laburie';
  if (/general|一般|その他/i.test(s))                                                   return 'general';
  return null;
}

// 公開
window.TEMPLATES               = TEMPLATES;
window.COMMON_MEDICAL_FIELDS   = COMMON_MEDICAL_FIELDS;
window.detectTreatment         = detectTreatment;
