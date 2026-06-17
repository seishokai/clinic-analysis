-- 事務ダッシュボード (admin/) のツール定義を保管するテーブル
-- セクション = 'open' (オープン) / 'hr' (人事・労務) / 'fin' (財務・給料) はクライアント側で固定。
-- カテゴリーは自由テキストで section_key + category のペアでグルーピング。

-- =============================================
-- 1. テーブル
-- =============================================
create table if not exists public.admin_tools (
  id          uuid        primary key default gen_random_uuid(),
  section_key text        not null check (section_key in ('open','hr','fin')),
  category    text        not null,
  icon        text        not null default '📋',
  title       text        not null,
  description text        not null default '',
  url         text,                              -- NULL or '' = 準備中
  badge       text        not null default 'sheets' check (badge in ('sheets','internal','todo')),
  sort_order  int         not null default 0,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_admin_tools_section_sort
  on public.admin_tools(section_key, sort_order);

-- updated_at 自動更新
create or replace function public.touch_admin_tools_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end$$;

drop trigger if exists trg_admin_tools_touch on public.admin_tools;
create trigger trg_admin_tools_touch
  before update on public.admin_tools
  for each row execute function public.touch_admin_tools_updated_at();

-- =============================================
-- 2. RLS (anon フル CRUD — admin/ ページ側でゲート)
-- =============================================
alter table public.admin_tools enable row level security;

drop policy if exists admin_tools_anon_all on public.admin_tools;
create policy admin_tools_anon_all
  on public.admin_tools for all
  to anon, authenticated
  using (true) with check (true);

-- =============================================
-- 3. Seed (現状のハードコードを移植)
-- =============================================
-- すでに行がある場合はスキップ
do $$
begin
  if (select count(*) from public.admin_tools) = 0 then

    -- ===== オープン =====
    insert into public.admin_tools (section_key, category, icon, title, description, url, badge, sort_order) values
      ('open','入社・退社処理','🌸','入社時',          '入社手続きのご案内ページ (社員名簿フォーム含む 4ステップ)', '../welcome/', 'internal', 10),
      ('open','入社・退社処理','📤','退職手続き',      '退職時の手続きフォーム', 'https://forms.gle/8bvCP99ZHuTXrTxo9','sheets', 20),
      ('open','運営・予約',    '📅','予約枠監視',      'shareconnect の枠状況', '../sales/', 'internal', 10),
      ('open','運営・予約',    '🦷','ドクターシフト',  '医院別ドクター配置 (Google Sheets)', 'https://docs.google.com/spreadsheets/d/1tKjXNJNPInAl0CTXHKd3G-792JNiU37inY0p6hlUPwM/edit?usp=sharing', 'sheets', 20),
      ('open','運営・予約',    '🗓️','アポツール (stransa)', '外部アポ管理ツール', 'https://user.stransa.co.jp/login', 'sheets', 30),
      ('open','運営・予約',    '📆','新予約ツール',    'shareconnect 予約管理ダッシュ', 'https://reserve.shareconnect.co.jp/admin/dashboard', 'sheets', 40),
      ('open','運営・予約',    '📈','追いかけリスト',  '再アプローチ対象一覧', '../#follow-up', 'internal', 50),
      ('open','その他重要事項','🎓','スキル評価',      'ドクター・スタッフのスキル評価', 'https://skill-eval.tkm-koike.workers.dev', 'internal', 10),
      ('open','その他重要事項','📢','重要連絡事項',    '社内お知らせ・告知事項', null, 'todo', 20),
      ('open','その他重要事項','📝','議事録',          '会議録の蓄積', null, 'todo', 30);

    -- ===== 人事・労務 =====
    insert into public.admin_tools (section_key, category, icon, title, description, url, badge, sort_order) values
      ('hr','入社処理 (機密)','📥','新入社員 連絡票',   '新入社員の基本情報・配属を一覧集約', null, 'todo', 10),
      ('hr','入社処理 (機密)','📄','雇用契約書テンプレ', '医院・職種別の契約書ひな形', null, 'todo', 20),
      ('hr','勤怠・労務',    '⏰','勤怠管理',         'タイムカード集計', null, 'todo', 10),
      ('hr','勤怠・労務',    '📑','社労情報',         '労務関係資料・各種申請書', null, 'todo', 20),
      ('hr','勤怠・労務',    '🗂️','休暇・有給管理',    '有給・特別休暇の集計', null, 'todo', 30),
      ('hr','評価',          '⭐','評価面談記録',      '年次・半期面談の記録', null, 'todo', 10);

    -- ===== 財務・給料 =====
    insert into public.admin_tools (section_key, category, icon, title, description, url, badge, sort_order) values
      ('fin','給与',         '💰','給与計算',         '月次給与計算ワークシート', null, 'todo', 10),
      ('fin','給与',         '🏆','ボーナス計算',     '賞与の集計表', null, 'todo', 20),
      ('fin','インセン管理',  '🎯','PBM 申請管理',    'スタッフからのPBM 申請を承認', '../pbm.html', 'internal', 10),
      ('fin','インセン管理',  '📊','PBM 集計表',     '月次の支給額一覧', null, 'todo', 20),
      ('fin','インセン管理',  '💎','矯正・BFインセンティブ','矯正/BFの個別実績と支給計算', null, 'todo', 30),
      ('fin','経理',         '💹','月次売上集計',     '医院別の月次売上', null, 'todo', 10),
      ('fin','経理',         '💴','入金管理',         'デンタルローン入金確認', null, 'todo', 20),
      ('fin','経理',         '🧾','経費精算',         '経費申請のとりまとめ', null, 'todo', 30);

  end if;
end$$;

-- =============================================
-- 確認用クエリ
-- =============================================
-- select section_key, category, sort_order, title, url is null as 準備中
-- from public.admin_tools
-- order by section_key, category, sort_order;
