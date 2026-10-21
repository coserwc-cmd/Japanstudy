-- Only study progress is stored here. Login credentials stay in Supabase Auth.
create table if not exists public.hiyori_study_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  document jsonb not null default '{"version":1,"attempts":[],"mistakes":{},"history":[]}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint hiyori_document_shape check (coalesce((
    document->>'version' = '1'
    and jsonb_typeof(document->'attempts') = 'array'
    and jsonb_typeof(document->'mistakes') = 'object'
    and jsonb_typeof(document->'history') = 'array'
    and jsonb_array_length(document->'attempts') <= 50000
    and jsonb_array_length(document->'history') <= 100
    and octet_length(document::text) <= 20971520
  ), false))
);

alter table public.hiyori_study_progress enable row level security;
revoke all on public.hiyori_study_progress from anon, authenticated;
grant select, insert, update on public.hiyori_study_progress to authenticated;

drop policy if exists hiyori_own_progress on public.hiyori_study_progress;
create policy hiyori_own_progress on public.hiyori_study_progress
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Compare-and-swap: concurrent devices must merge the returned latest version,
-- then retry. A stale upload can never overwrite another device's progress.
create or replace function public.hiyori_sync(expected_revision bigint, document jsonb default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  current_row public.hiyori_study_progress%rowtype;
begin
  if owner_id is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if expected_revision is null then
    raise exception 'A revision is required' using errcode = '22023';
  end if;

  if expected_revision < 0 then
    select * into current_row from public.hiyori_study_progress where user_id = owner_id;
    return jsonb_build_object('ok', true, 'revision', coalesce(current_row.revision, 0), 'document', current_row.document);
  end if;
  if document is null then
    raise exception 'A document is required' using errcode = '22023';
  end if;

  insert into public.hiyori_study_progress(user_id) values (owner_id)
    on conflict (user_id) do nothing;
  select * into current_row from public.hiyori_study_progress where user_id = owner_id for update;
  if current_row.revision <> expected_revision then
    return jsonb_build_object('ok', false, 'revision', current_row.revision, 'document', current_row.document);
  end if;

  update public.hiyori_study_progress as progress
    set document = hiyori_sync.document,
        revision = progress.revision + 1,
        updated_at = now()
    where user_id = owner_id
    returning * into current_row;
  return jsonb_build_object('ok', true, 'revision', current_row.revision, 'document', current_row.document);
end;
$$;

revoke all on function public.hiyori_sync(bigint, jsonb) from public, anon;
grant execute on function public.hiyori_sync(bigint, jsonb) to authenticated;
