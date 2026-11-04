-- Casinha do Dignidade: atendente de IA no WhatsApp
-- Rodar DEPOIS do casinha_precos.sql. Pode rodar mais de uma vez.
-- A IA (Cloudflare Worker) acessa com a chave service_role, que fica só no servidor.

-- reserva: de onde veio, prazo da pré-reserva e pagamento
alter table public.casinha_reservas add column if not exists origem text not null default 'painel';
alter table public.casinha_reservas add column if not exists wa_id text;
alter table public.casinha_reservas add column if not exists pessoas int;
alter table public.casinha_reservas add column if not exists expira_em timestamptz;
alter table public.casinha_reservas add column if not exists pagamento_id text;
alter table public.casinha_reservas add column if not exists pagamento_status text;
alter table public.casinha_reservas add column if not exists pix_copia_cola text;

-- conversas do WhatsApp
create table if not exists public.casinha_ia_conversas (
  wa_id text primary key,
  nome text,
  humano_ate timestamptz,            -- enquanto estiver no futuro, a IA não responde (alguém do time assumiu)
  ultima_msg timestamptz not null default now(),
  criado_em timestamptz not null default now()
);
create table if not exists public.casinha_ia_mensagens (
  id bigserial primary key,
  wa_id text not null references public.casinha_ia_conversas(wa_id) on delete cascade,
  papel text not null check (papel in ('user','assistant','humano')),
  conteudo jsonb not null,           -- texto ou blocos da conversa com a IA
  wa_msg_id text unique,             -- evita responder duas vezes a mesma mensagem
  criado_em timestamptz not null default now()
);
create index if not exists casinha_ia_mensagens_wa on public.casinha_ia_mensagens (wa_id, id);

alter table public.casinha_ia_conversas enable row level security;
alter table public.casinha_ia_mensagens enable row level security;
drop policy if exists "casinha ia conversas admin" on public.casinha_ia_conversas;
drop policy if exists "casinha ia mensagens admin" on public.casinha_ia_mensagens;
create policy "casinha ia conversas admin" on public.casinha_ia_conversas for all to authenticated
  using (public.imarcas_eh_membro()) with check (public.imarcas_eh_membro());
create policy "casinha ia mensagens admin" on public.casinha_ia_mensagens for all to authenticated
  using (public.imarcas_eh_membro()) with check (public.imarcas_eh_membro());

-- pré-reserva vencida (sem pagamento no prazo) é cancelada e libera a data
create or replace function public.casinha_expirar_pre()
returns integer
language sql volatile security definer set search_path = ''
as $$
  with x as (
    update public.casinha_reservas
       set status = 'cancelada',
           obs = trim(coalesce(obs,'') || ' [expirou sem pagamento]')
     where status = 'pre' and expira_em is not null and expira_em < now()
     returning 1)
  select count(*)::int from x;
$$;
revoke all on function public.casinha_expirar_pre() from public;
grant execute on function public.casinha_expirar_pre() to service_role;

-- o site não mostra como ocupada uma pré-reserva que já venceu
create or replace function public.casinha_datas_ocupadas()
returns table (entrada date, saida date)
language sql stable security definer set search_path = ''
as $$
  select r.entrada, r.saida from public.casinha_reservas r
  where r.status <> 'cancelada'
    and not (r.status = 'pre' and r.expira_em is not null and r.expira_em < now())
    and r.saida >= current_date
  order by r.entrada;
$$;
revoke all on function public.casinha_datas_ocupadas() from public;
grant execute on function public.casinha_datas_ocupadas() to anon, authenticated;
