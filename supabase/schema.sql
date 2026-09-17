-- ============================================================================
-- WordCards 单词卡 —— Supabase 云同步数据库初始化脚本
-- ----------------------------------------------------------------------------
-- 使用方法：
--   1. 打开 Supabase 控制台 → 左侧 SQL Editor → New query
--   2. 把本文件全部内容粘贴进去，点击 Run（整段执行一次即可）
--   3. 脚本可重复执行（幂等）：表、索引、策略、函数都带 if not exists / or replace
--
-- 设计要点：
--   * 词库本身（dict.xlsx）不上云，仍然是每台设备本地导入的静态数据；
--     云端只保存「用户对词条的学习结果」+「用户设置」+「今日学习会话」。
--   * 词条用 dict_key 跨设备对齐，而不是用 IndexedDB 的自增 id
--     （不同设备导入同一份词典时 id 未必相同）。
--   * 两张表：word_progress（按词条一行）、user_state（每用户一行）。
--   * 所有表都开启 RLS，每个用户只能读写自己的数据。
--   * anon key 放在前端是安全的，前提是 RLS 已启用且没写 using (true)。
-- ============================================================================


-- ============================================================================
-- 1. 表结构
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1.1 word_progress：每个用户 × 每个词条 一条学习记录
-- ---------------------------------------------------------------------------
-- dict_key          词条跨设备稳定标识，格式 scope|文本|音标（均已规范化小写）
-- status            new 新词 / mastered 已掌握 / review 待复习
-- favorite          是否收藏
-- last_studied      最近一次学习时间（客户端 epoch 毫秒）
-- review_count      复习次数（预留，当前前端恒为 0 或已有值）
-- client_updated_at 客户端逻辑时间戳（毫秒）——冲突判定的唯一依据，越大越新
-- updated_at        服务端写入时间——只用作增量拉取的游标（服务端时钟单调）
-- ---------------------------------------------------------------------------
create table if not exists public.word_progress (
  user_id           uuid        not null references auth.users (id) on delete cascade,
  dict_key          text        not null,
  status            text        not null default 'new',
  favorite          boolean     not null default false,
  last_studied      bigint,
  review_count      integer     not null default 0,
  client_updated_at bigint      not null default 0,
  updated_at        timestamptz not null default now(),
  constraint word_progress_pkey primary key (user_id, dict_key),
  constraint word_progress_status_check check (status in ('new', 'mastered', 'review'))
);

-- 增量拉取：where user_id = ... and updated_at > cursor order by updated_at
create index if not exists word_progress_user_updated_idx
  on public.word_progress (user_id, updated_at);

-- 重置记录后按时间戳清理历史行时使用
create index if not exists word_progress_user_client_updated_idx
  on public.word_progress (user_id, client_updated_at);


-- ---------------------------------------------------------------------------
-- 1.2 user_state：每个用户一行，存放设置 / 今日会话 / 重置信号
-- ---------------------------------------------------------------------------
-- settings             需要同步的用户设置（JSON，键名与前端 settings 一致）
-- settings_updated_at  设置的客户端逻辑时间戳（LWW）
-- session              今日学习会话：{ date, currentCardIndex, goal, savedAt, dictKeys[] }
-- session_updated_at   会话的客户端逻辑时间戳（LWW）
-- progress_reset_at    「清除记录」的时间戳；其他设备拉到更大的值即本地清零
-- ---------------------------------------------------------------------------
create table if not exists public.user_state (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  settings            jsonb       not null default '{}'::jsonb,
  settings_updated_at bigint      not null default 0,
  session             jsonb,
  session_updated_at  bigint      not null default 0,
  progress_reset_at   bigint      not null default 0,
  updated_at          timestamptz not null default now()
);


-- ============================================================================
-- 2. 行级安全（RLS）—— 每个用户只能访问自己的数据
-- ============================================================================
alter table public.word_progress enable row level security;
alter table public.user_state   enable row level security;

-- 注意：策略名固定，先 drop 再 create，保证脚本可重复执行

-- ---- word_progress ----
drop policy if exists "word_progress_select_own" on public.word_progress;
create policy "word_progress_select_own"
  on public.word_progress for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "word_progress_insert_own" on public.word_progress;
create policy "word_progress_insert_own"
  on public.word_progress for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "word_progress_update_own" on public.word_progress;
create policy "word_progress_update_own"
  on public.word_progress for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "word_progress_delete_own" on public.word_progress;
create policy "word_progress_delete_own"
  on public.word_progress for delete
  to authenticated
  using (auth.uid() = user_id);

-- ---- user_state ----
drop policy if exists "user_state_select_own" on public.user_state;
create policy "user_state_select_own"
  on public.user_state for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "user_state_insert_own" on public.user_state;
create policy "user_state_insert_own"
  on public.user_state for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "user_state_update_own" on public.user_state;
create policy "user_state_update_own"
  on public.user_state for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ============================================================================
-- 3. 同步用的存储过程（RPC）
-- ============================================================================
-- 之所以用 RPC 而不是 PostgREST 的 upsert：冲突时要做「时间戳大的赢」这个
-- 条件更新（on conflict ... do update ... where excluded.x > table.x），
-- PostgREST 的 upsert 不支持带条件的 do update，只能走函数。
-- 两个函数都是 security invoker，RLS 依然生效。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 3.1 push_progress(p_rows)：批量上行学习记录，返回云端解决冲突后的最终值
--     p_rows 形如：
--     [{"dict_key":"word|你好|ni3 hao3","status":"mastered","favorite":true,
--       "last_studied":1735689600000,"review_count":0,
--       "client_updated_at":1735689600000}, ...]
-- ---------------------------------------------------------------------------
create or replace function public.push_progress(p_rows jsonb)
returns setof public.word_progress
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_keys text[];
begin
  if v_uid is null then
    raise exception 'push_progress: not authenticated' using errcode = '28000';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return;
  end if;

  -- 本次涉及到的词条标识（用于最后回传云端最终状态）
  select array_agg(distinct r.dict_key)
    into v_keys
    from jsonb_to_recordset(p_rows)
         as r(dict_key          text,
              status            text,
              favorite          boolean,
              last_studied      bigint,
              review_count      integer,
              client_updated_at bigint)
   where r.dict_key is not null
     and length(r.dict_key) > 0;

  if v_keys is null then
    return;
  end if;

  -- 只允许写入足够新的版本：client_updated_at 更大才覆盖云端已有值
  insert into public.word_progress as wp
    (user_id, dict_key, status, favorite, last_studied, review_count, client_updated_at, updated_at)
  select
    v_uid,
    r.dict_key,
    case when r.status in ('new', 'mastered', 'review') then r.status else 'new' end,
    coalesce(r.favorite, false),
    r.last_studied,
    greatest(coalesce(r.review_count, 0), 0),
    coalesce(r.client_updated_at, 0),
    now()
  from jsonb_to_recordset(p_rows)
       as r(dict_key          text,
            status            text,
            favorite          boolean,
            last_studied      bigint,
            review_count      integer,
            client_updated_at bigint)
  where r.dict_key is not null
    and length(r.dict_key) > 0
  on conflict (user_id, dict_key) do update
     set status            = excluded.status,
         favorite          = excluded.favorite,
         last_studied      = excluded.last_studied,
         review_count      = excluded.review_count,
         client_updated_at = excluded.client_updated_at,
         updated_at        = now()
   where excluded.client_updated_at > wp.client_updated_at;

  -- 回传这些词条在云端的最终状态：
  -- 若某行没被本次写入覆盖，说明云端版本更新，客户端据此纠正本地
  return query
    select *
      from public.word_progress
     where user_id = v_uid
       and dict_key = any (v_keys);
end;
$$;


-- ---------------------------------------------------------------------------
-- 3.2 push_user_state(...)：上行设置 / 今日会话 / 重置信号，返回合并后的行
--     任一参数传 null 表示「本次不改这一项」
-- ---------------------------------------------------------------------------
create or replace function public.push_user_state(
  p_settings            jsonb   default null,
  p_settings_updated_at bigint  default null,
  p_session             jsonb   default null,
  p_session_updated_at  bigint  default null,
  p_progress_reset_at   bigint  default null
)
returns public.user_state
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.user_state;
begin
  if v_uid is null then
    raise exception 'push_user_state: not authenticated' using errcode = '28000';
  end if;

  insert into public.user_state as us
    (user_id, settings, settings_updated_at, session, session_updated_at, progress_reset_at, updated_at)
  values (
    v_uid,
    coalesce(p_settings, '{}'::jsonb),
    coalesce(p_settings_updated_at, 0),
    p_session,
    coalesce(p_session_updated_at, 0),
    coalesce(p_progress_reset_at, 0),
    now()
  )
  on conflict (user_id) do update
     set settings            = case
                                 when p_settings is not null
                                  and coalesce(p_settings_updated_at, 0) > us.settings_updated_at
                                 then p_settings
                                 else us.settings
                               end,
         settings_updated_at = greatest(us.settings_updated_at, coalesce(p_settings_updated_at, 0)),
         session             = case
                                 when p_session is not null
                                  and coalesce(p_session_updated_at, 0) > us.session_updated_at
                                 then p_session
                                 else us.session
                               end,
         session_updated_at  = greatest(us.session_updated_at, coalesce(p_session_updated_at, 0)),
         -- 重置信号只增不减：任何设备执行过「清除记录」，其他设备都必须跟着清
         progress_reset_at   = greatest(us.progress_reset_at, coalesce(p_progress_reset_at, 0)),
         updated_at          = now()
  returning * into v_row;

  return v_row;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3.3 delete_progress_before(p_before)：清理重置时间点之前的历史行（可选）
--     仅用于让数据库保持干净；即使不调用也不影响同步正确性，
--     因为客户端拉取时会自行忽略 client_updated_at <= progress_reset_at 的行。
-- ---------------------------------------------------------------------------
create or replace function public.delete_progress_before(p_before bigint)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_count integer := 0;
begin
  if v_uid is null then
    raise exception 'delete_progress_before: not authenticated' using errcode = '28000';
  end if;

  delete from public.word_progress
   where user_id = v_uid
     and client_updated_at <= coalesce(p_before, 0);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


-- ============================================================================
-- 4. 执行权限：登录用户可用，匿名用户不可执行
-- ============================================================================
revoke all on function public.push_progress(jsonb)                       from public, anon;
revoke all on function public.push_user_state(jsonb, bigint, jsonb, bigint, bigint) from public, anon;
revoke all on function public.delete_progress_before(bigint)             from public, anon;

grant execute on function public.push_progress(jsonb)                       to authenticated;
grant execute on function public.push_user_state(jsonb, bigint, jsonb, bigint, bigint) to authenticated;
grant execute on function public.delete_progress_before(bigint)             to authenticated;


-- ============================================================================
-- 5. 完成
-- ============================================================================
-- 执行后可到 Table Editor 确认出现 word_progress / user_state 两张表，
-- 且 Authentication → Policies 中能看到 7 条策略。
--
-- 建议同时在控制台确认：
--   Authentication → Providers → Email 已开启（默认开启）
--   Authentication → URL Configuration → Site URL 填你的应用地址
--   （例如 http://localhost:8080，用于邮箱确认链接和找回密码跳转）
-- ============================================================================
