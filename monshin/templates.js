// =====================================================================
// 治療別 問診票テンプレート (Vanilla JS 版)
//
// 各テンプレートは {treatment, title, description, includeCommonMedical,
//                  sections:[{id,title,description,fields:[...]}] } 形式
//
// 設計方針:
//   - 基本ボタン選択 (radio / checkbox) で UX を最大化
//   - 自由記述 (textarea) は最後の section に集約
//   - 各 checkbox は最大 7 個まで (画面が縦長になりすぎない)
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
// 共通: 「どこで知ったか」(referral source) 全治療共通
// =====================================================================
const REFERRAL_SOURCE_OPTIONS = [
  { value: 'instagram_ad',      label: 'インスタ広告' },
  { value: 'facebook_ad',       label: 'Facebook広告' },
  { value: 'tiktok_ad',         label: 'TikTok広告' },
  { value: 'google_search_ad',  label: 'ネット(グーグル検索)広告' },
  { value: 'instagram_account', label: 'インスタアカウント' },
  { value: 'tiktok_account',    label: 'ティックトックアカウント' },
  { value: 'referral',          label: '知人の紹介' },
];

// =====================================================================
// 矯正相談
// =====================================================================
const KYOSEI_TEMPLATE = {
  treatment: 'kyosei',
  title: '無料矯正相談 事前問診票',
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
          name: 'kyosei_concern_areas',
          label: '気になっている部位・症状を教えてください',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'crowded_teeth',         label: '歯並びがガタガタ（叢生）' },
            { value: 'maxillary_protrusion',  label: '出っ歯（上の歯が前に出ている）' },
            { value: 'fang_teeth',            label: '八重歯' },
            { value: 'gap_teeth',             label: 'すきっ歯' },
            { value: 'mandibular_protrusion', label: '受け口（下の歯が前に出ている）' },
            { value: 'mouth_protrusion',      label: '口元のもっこり感' },
            { value: 'biting_concern',        label: '噛み合わせが気になる' },
          ],
          allowOther: true,
        },
        {
          name: 'kyosei_concerns',
          label: '矯正治療を受けるにあたって心配な点はありますか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: false,
          options: [
            { value: 'pain',            label: '痛みが心配' },
            { value: 'cost',            label: '費用が心配' },
            { value: 'duration',        label: '治療期間が心配' },
            { value: 'appearance',      label: '装置の見た目が気になる' },
            { value: 'eating',          label: '食事の制限が心配' },
            { value: 'visit_frequency', label: '通院頻度が心配' },
            { value: 'no_concern',      label: '特に心配なし' },
          ],
          allowOther: true,
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
          options: REFERRAL_SOURCE_OPTIONS,
          allowOther: true,
        },
        {
          name: 'kyosei_appeal_reason',
          label: '当院が気になった理由はどれですか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'monthly_3000',     label: '月額3,000円〜から始められる' },
            { value: 'short_term',       label: '短期間（最短3ヶ月〜）で完了' },
            { value: 'invisible',        label: '透明で目立たない（マウスピース矯正）' },
            { value: 'partial_kyosei',   label: '部分矯正もできる' },
            { value: 'campaign',         label: '学割・キャンペーンがある' },
            { value: 'near_station',     label: '駅から近い' },
            { value: 'qualified_doctor', label: '経験豊富な歯科医師' },
          ],
          allowOther: true,
        },
      ],
    },
    {
      id: 'kyosei_freetext',
      title: 'その他ご質問・ご要望',
      description: 'ご自由にご記入ください（任意）',
      fields: [
        {
          name: 'kyosei_other_questions',
          label: '当日ご相談したいこと、ご希望、ご質問など',
          type: 'textarea',
          required: false,
          placeholder: 'ご自由にご記入ください',
        },
      ],
    },
  ],
};

// =====================================================================
// 削らないラミネートベニア (BF)
// =====================================================================
const BF_TEMPLATE = {
  treatment: 'bf',
  title: '削らないラミネートベニア 事前問診票',
  description:
    'ご来院前に、いくつかご質問にお答えください。スタッフ・ドクターが事前に内容を把握し、当日のご相談がスムーズになります。',
  includeCommonMedical: false,
  sections: [
    {
      id: 'bf_consultation',
      title: 'ご相談内容',
      fields: [
        {
          name: 'bf_past_treatment',
          label: '過去にラミネート/セラミック治療を受けたことはありますか？',
          type: 'radio',
          required: true,
          options: [
            { value: 'yes', label: 'はい' },
            { value: 'no',  label: 'いいえ' },
          ],
        },
        {
          name: 'bf_concern_areas',
          label: '気になっている点を教えてください',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'tooth_color',    label: '歯の色が気になる' },
            { value: 'gap_teeth',      label: '前歯のすきっ歯' },
            { value: 'tooth_shape',    label: '歯の形が気になる' },
            { value: 'minor_crowding', label: '歯並びの軽い乱れ' },
            { value: 'chipped_tooth',  label: '欠けた歯の修復' },
            { value: 'silver_crown',   label: '銀歯を白くしたい' },
            { value: 'overall_look',   label: '全体的な見た目を整えたい' },
          ],
          allowOther: true,
        },
        {
          name: 'bf_concerns',
          label: '心配な点はありますか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: false,
          options: [
            { value: 'cost',         label: '費用が心配' },
            { value: 'pain',         label: '痛みが心配' },
            { value: 'durability',   label: 'もちのよさが心配' },
            { value: 'natural_look', label: '自然な見た目になるか' },
            { value: 'visit_count',  label: '通院回数が心配' },
            { value: 'eating',       label: '食事制限が心配' },
            { value: 'no_concern',   label: '特に心配なし' },
          ],
          allowOther: true,
        },
        {
          name: 'bf_age',
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
      id: 'bf_marketing',
      title: '当院について',
      description: 'よりよいご案内のため、ご来院のきっかけについてお聞かせください。',
      fields: [
        {
          name: 'bf_referral_source',
          label: '{clinic_name}をどこで知りましたか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: REFERRAL_SOURCE_OPTIONS,
          allowOther: true,
        },
        {
          name: 'bf_appeal_reason',
          label: '当院が気になった理由はどれですか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'no_drilling',      label: '歯を削らない' },
            { value: 'short_term',       label: '短期間（最短1日〜）で完了' },
            { value: 'no_pain',          label: '痛くない・麻酔不要' },
            { value: 'natural_finish',   label: '自然な仕上がり（オーダーメイド）' },
            { value: 'special_occasion', label: '結婚式・特別な日に間に合う' },
            { value: 'reversible',       label: 'もとに戻せる（可逆的な治療）' },
            { value: 'near_station',     label: '駅から近い' },
          ],
          allowOther: true,
        },
      ],
    },
    {
      id: 'bf_freetext',
      title: 'その他ご質問・ご要望',
      description: 'ご自由にご記入ください（任意）',
      fields: [
        {
          name: 'bf_other_questions',
          label: '当日ご相談したいこと、ご希望、ご質問など',
          type: 'textarea',
          required: false,
          placeholder: 'ご自由にご記入ください',
        },
      ],
    },
  ],
};

// =====================================================================
// インプラント
// =====================================================================
const IMPLANT_TEMPLATE = {
  treatment: 'implant',
  title: 'インプラント相談 事前問診票',
  description:
    'ご来院前に、いくつかご質問にお答えください。スタッフ・ドクターが事前に内容を把握し、当日のご相談がスムーズになります。',
  includeCommonMedical: false,
  sections: [
    {
      id: 'implant_consultation',
      title: 'ご相談内容',
      fields: [
        {
          name: 'implant_lost_count',
          label: '失った歯の本数を教えてください',
          type: 'radio',
          required: true,
          options: [
            { value: '1',       label: '1本' },
            { value: '2to3',    label: '2〜3本' },
            { value: '4plus',   label: '4本以上' },
            { value: 'unknown', label: 'わからない' },
          ],
        },
        {
          name: 'implant_lost_period',
          label: '歯を失ってからどのくらい経ちますか？',
          type: 'radio',
          required: true,
          options: [
            { value: 'within_1m', label: '1ヶ月以内' },
            { value: 'within_6m', label: '半年以内' },
            { value: 'within_1y', label: '1年以内' },
            { value: 'years',     label: '数年経過' },
            { value: 'unknown',   label: 'わからない' },
          ],
        },
        {
          name: 'implant_current_treatment',
          label: '現在の対処を教えてください',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'denture',   label: '入れ歯を使っている' },
            { value: 'bridge',    label: 'ブリッジを入れている' },
            { value: 'temporary', label: '仮歯' },
            { value: 'untreated', label: 'そのまま放置' },
          ],
          allowOther: true,
        },
        {
          name: 'implant_concerns',
          label: '心配な点はありますか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: false,
          options: [
            { value: 'pain',       label: '痛みが心配' },
            { value: 'surgery',    label: '手術が怖い' },
            { value: 'cost',       label: '費用が心配' },
            { value: 'duration',   label: '治療期間が心配' },
            { value: 'anesthesia', label: '麻酔が心配' },
            { value: 'underlying', label: '持病がある' },
            { value: 'no_concern', label: '特に心配なし' },
          ],
          allowOther: true,
        },
        {
          name: 'implant_age',
          label: '年齢を教えてください',
          type: 'number',
          required: true,
          min: 0,
          max: 120,
          step: 1,
          placeholder: '例) 50',
        },
      ],
    },
    {
      id: 'implant_marketing',
      title: '当院について',
      description: 'よりよいご案内のため、ご来院のきっかけについてお聞かせください。',
      fields: [
        {
          name: 'implant_referral_source',
          label: '{clinic_name}をどこで知りましたか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: REFERRAL_SOURCE_OPTIONS,
          allowOther: true,
        },
        {
          name: 'implant_appeal_reason',
          label: '当院が気になった理由はどれですか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'experienced',     label: '医師の症例数・経験豊富' },
            { value: 'equipment',       label: 'CT・手術室など設備充実' },
            { value: 'painless',        label: '静脈内鎮静法など痛み配慮' },
            { value: 'warranty',        label: '長期保証あり' },
            { value: 'same_day',        label: '即日インプラント対応' },
            { value: 'near_station',    label: '駅から近い' },
            { value: 'cost_acceptable', label: '費用感が合った' },
          ],
          allowOther: true,
        },
      ],
    },
    {
      id: 'implant_freetext',
      title: 'その他ご質問・ご要望',
      description: 'ご自由にご記入ください（任意）',
      fields: [
        {
          name: 'implant_other_questions',
          label: '当日ご相談したいこと、ご希望、ご質問など',
          type: 'textarea',
          required: false,
          placeholder: 'ご自由にご記入ください',
        },
      ],
    },
  ],
};

// =====================================================================
// ホワイトニング
// =====================================================================
const WHITENING_TEMPLATE = {
  treatment: 'whitening',
  title: 'ホワイトニング相談 事前問診票',
  description:
    'ご来院前に、いくつかご質問にお答えください。スタッフ・ドクターが事前に内容を把握し、当日のご相談がスムーズになります。',
  includeCommonMedical: false,
  sections: [
    {
      id: 'whitening_consultation',
      title: 'ご相談内容',
      fields: [
        {
          name: 'whitening_experience',
          label: 'ホワイトニングの経験はありますか？',
          type: 'radio',
          required: true,
          options: [
            { value: 'first_time', label: '初めて' },
            { value: 'clinic',     label: 'クリニックで経験あり' },
            { value: 'home_kit',   label: '自宅キットで経験あり' },
            { value: 'both',       label: '両方経験あり' },
          ],
        },
        {
          name: 'whitening_concern_areas',
          label: '気になっている部位を教えてください',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'all_teeth',          label: '歯全体の色' },
            { value: 'front_teeth',        label: '前歯だけ' },
            { value: 'specific_teeth',     label: '1〜2本だけ変色' },
            { value: 'visible_when_smile', label: '笑った時に見える歯' },
            { value: 'dead_tooth',         label: '失活歯（神経のない歯）' },
            { value: 'around_filling',     label: '詰め物の周辺' },
          ],
          allowOther: true,
        },
        {
          name: 'whitening_goal',
          label: '希望する仕上がりを教えてください',
          type: 'radio',
          required: true,
          options: [
            { value: 'natural',     label: '自然な白さ' },
            { value: 'clear_white', label: 'はっきり白く' },
            { value: 'celebrity',   label: '芸能人並みに白く' },
            { value: 'wedding',     label: '結婚式・特別な日に向けて' },
            { value: 'job_hunting', label: '就活・面接に向けて' },
            { value: 'undecided',   label: '特に決まっていない' },
          ],
        },
        {
          name: 'whitening_concerns',
          label: '心配な点はありますか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: false,
          options: [
            { value: 'sensitivity',   label: 'しみるのが心配' },
            { value: 'pain',          label: '痛みが心配' },
            { value: 'rebound',       label: '後戻り' },
            { value: 'cost',          label: '費用が心配' },
            { value: 'effectiveness', label: '効果があるか' },
            { value: 'underlying',    label: '持病がある' },
            { value: 'no_concern',    label: '特に心配なし' },
          ],
          allowOther: true,
        },
        {
          name: 'whitening_age',
          label: '年齢を教えてください',
          type: 'number',
          required: true,
          min: 0,
          max: 120,
          step: 1,
          placeholder: '例) 30',
        },
      ],
    },
    {
      id: 'whitening_marketing',
      title: '当院について',
      description: 'よりよいご案内のため、ご来院のきっかけについてお聞かせください。',
      fields: [
        {
          name: 'whitening_referral_source',
          label: '{clinic_name}をどこで知りましたか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: REFERRAL_SOURCE_OPTIONS,
          allowOther: true,
        },
        {
          name: 'whitening_appeal_reason',
          label: '当院が気になった理由はどれですか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'professional',     label: '歯科医院でしっかり施術したい' },
            { value: 'home',             label: '自宅で続けられる（ホームホワイトニング）' },
            { value: 'long_lasting',     label: '持続期間が長い' },
            { value: 'painless',         label: 'しみない・痛み対策が充実' },
            { value: 'special_occasion', label: '結婚式・特別な日に間に合う' },
            { value: 'near_station',     label: '駅から近い' },
            { value: 'cost_acceptable',  label: '費用感が合った' },
          ],
          allowOther: true,
        },
      ],
    },
    {
      id: 'whitening_freetext',
      title: 'その他ご質問・ご要望',
      description: 'ご自由にご記入ください（任意）',
      fields: [
        {
          name: 'whitening_other_questions',
          label: '当日ご相談したいこと、ご希望、ご質問など',
          type: 'textarea',
          required: false,
          placeholder: 'ご自由にご記入ください',
        },
      ],
    },
  ],
};

// =====================================================================
// 一般診療
// =====================================================================
const GENERAL_TEMPLATE = {
  treatment: 'general',
  title: '事前問診票',
  description:
    'ご来院前に、いくつかご質問にお答えください。スタッフ・ドクターが事前に内容を把握し、当日のご相談がスムーズになります。',
  includeCommonMedical: false,
  sections: [
    {
      id: 'general_consultation',
      title: 'ご相談内容',
      fields: [
        {
          name: 'general_concern_topics',
          label: '今日のご相談内容を教えてください',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'cavity',       label: '虫歯の治療' },
            { value: 'gum_disease',  label: '歯ぐきの腫れ・出血' },
            { value: 'pain',         label: '痛みがある' },
            { value: 'checkup',      label: '定期検診・クリーニング' },
            { value: 'crown_repair', label: '詰め物・かぶせ物の修理' },
            { value: 'wisdom_tooth', label: '親知らず' },
            { value: 'denture',      label: '入れ歯' },
          ],
          allowOther: true,
        },
        {
          name: 'general_pain_level',
          label: '痛みの程度を教えてください',
          type: 'radio',
          required: true,
          options: [
            { value: 'no_pain',          label: '痛みなし' },
            { value: 'discomfort',       label: '違和感程度' },
            { value: 'biting_pain',      label: '噛むと痛い' },
            { value: 'cold_sensitive',   label: '冷たいものでしみる' },
            { value: 'spontaneous_pain', label: '何もしなくても痛い' },
            { value: 'throbbing',        label: 'ズキズキする' },
          ],
        },
        {
          name: 'general_last_visit',
          label: '最後に歯科を受診したのはいつですか？',
          type: 'radio',
          required: true,
          options: [
            { value: 'first_time', label: '今回が初めて' },
            { value: 'within_6m',  label: '半年以内' },
            { value: '1to2y',      label: '1〜2年前' },
            { value: '3to5y',      label: '3〜5年前' },
            { value: 'over_5y',    label: '5年以上前' },
            { value: 'unknown',    label: '覚えていない' },
          ],
        },
        {
          name: 'general_concerns',
          label: '心配な点はありますか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: false,
          options: [
            { value: 'pain',          label: '痛みが心配' },
            { value: 'cost',          label: '費用が心配' },
            { value: 'visit_count',   label: '治療回数が心配' },
            { value: 'anesthesia',    label: '麻酔が心配' },
            { value: 'unknown_proc',  label: '何をされるか不安' },
            { value: 'no_concern',    label: '特に心配なし' },
          ],
          allowOther: true,
        },
        {
          name: 'general_age',
          label: '年齢を教えてください',
          type: 'number',
          required: true,
          min: 0,
          max: 120,
          step: 1,
          placeholder: '例) 35',
        },
      ],
    },
    {
      id: 'general_marketing',
      title: '当院について',
      description: 'よりよいご案内のため、ご来院のきっかけについてお聞かせください。',
      fields: [
        {
          name: 'general_referral_source',
          label: '{clinic_name}をどこで知りましたか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: REFERRAL_SOURCE_OPTIONS,
          allowOther: true,
        },
        {
          name: 'general_appeal_reason',
          label: '当院が気になった理由はどれですか？',
          description: '当てはまるものをすべて選択してください',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'near_station',     label: '駅から近い・通いやすい' },
            { value: 'painless',         label: '痛みに配慮した治療' },
            { value: 'clear_explain',    label: '説明がわかりやすい' },
            { value: 'emergency',        label: '急患対応してもらえる' },
            { value: 'insurance',        label: '保険診療' },
            { value: 'modern_equipment', label: '設備が新しい' },
            { value: 'good_atmosphere',  label: '院内の雰囲気がよい' },
          ],
          allowOther: true,
        },
      ],
    },
    {
      id: 'general_freetext',
      title: 'その他ご質問・ご要望',
      description: 'ご自由にご記入ください（任意）',
      fields: [
        {
          name: 'general_other_questions',
          label: '当日ご相談したいこと、ご希望、ご質問など',
          type: 'textarea',
          required: false,
          placeholder: 'ご自由にご記入ください',
        },
      ],
    },
  ],
};

// =====================================================================
// テンプレート一覧
// =====================================================================
const TEMPLATES = {
  kyosei:    KYOSEI_TEMPLATE,
  bf:        BF_TEMPLATE,
  implant:   IMPLANT_TEMPLATE,
  whitening: WHITENING_TEMPLATE,
  general:   GENERAL_TEMPLATE,
  // 旧: ラブリエ → bf に統合 (URL からの後方互換)
  laburie:   BF_TEMPLATE,
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
  // BF / ラミネート / ラブリエ は全て「削らないラミネートベニア」に統合
  if (/bf|black\s*film|ブラック|ﾌﾞﾗｯｸ|ラミネート|laminate|ベニア|ラブリエ|laburie|labu|削らない/i.test(s)) return 'bf';
  if (/矯正|kyosei|kyousei|invisalign|インビザ|ワイヤー|マウスピース|aligner/i.test(s))    return 'kyosei';
  if (/インプラント|implant/i.test(s))                                                       return 'implant';
  if (/ホワイトニング|whitening|ホワイト|wt/i.test(s))                                       return 'whitening';
  if (/general|一般|その他/i.test(s))                                                        return 'general';
  return null;
}

// 公開
window.TEMPLATES               = TEMPLATES;
window.COMMON_MEDICAL_FIELDS   = COMMON_MEDICAL_FIELDS;
window.detectTreatment         = detectTreatment;
