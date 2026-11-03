-- Casinha do Dignidade: tabelas de preço das carnes e açougue parceiro (TESTE no projeto vitrine-icasas)
-- Leitura pública (o site lê os preços); escrita só para membros da iMarcas (login do painel).
create table if not exists public.casinha_carnes (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  nome text not null,
  unidade text not null check (unidade in ('kg','peca','pacote')),
  unidade_desc text,
  peso_kg numeric(6,2) not null default 0,
  preco_custo numeric(10,2) not null default 0,
  margem_pct numeric(5,2),
  preco_venda numeric(10,2) generated always as (round(preco_custo * (1 + coalesce(margem_pct,0)/100.0), 2)) stored,
  icone text,
  ativo boolean not null default true,
  ordem int not null default 0,
  atualizado_em timestamptz not null default now()
);
create table if not exists public.casinha_config (
  id int primary key default 1 check (id = 1),
  acougue_nome text,
  acougue_endereco text,
  acougue_whatsapp text,
  atualizado_em timestamptz not null default now()
);
create or replace function public.casinha_touch() returns trigger language plpgsql set search_path = '' as $$
begin new.atualizado_em := now(); return new; end $$;
drop trigger if exists casinha_carnes_touch on public.casinha_carnes;
create trigger casinha_carnes_touch before update on public.casinha_carnes for each row execute function public.casinha_touch();
drop trigger if exists casinha_config_touch on public.casinha_config;
create trigger casinha_config_touch before update on public.casinha_config for each row execute function public.casinha_touch();
alter table public.casinha_carnes enable row level security;
alter table public.casinha_config enable row level security;
drop policy if exists "casinha carnes leitura publica" on public.casinha_carnes;
drop policy if exists "casinha carnes admin imarcas" on public.casinha_carnes;
drop policy if exists "casinha config leitura publica" on public.casinha_config;
drop policy if exists "casinha config admin imarcas" on public.casinha_config;
create policy "casinha carnes leitura publica" on public.casinha_carnes for select to anon, authenticated using (true);
create policy "casinha carnes admin imarcas" on public.casinha_carnes for all to authenticated using (public.imarcas_eh_membro()) with check (public.imarcas_eh_membro());
create policy "casinha config leitura publica" on public.casinha_config for select to anon, authenticated using (true);
create policy "casinha config admin imarcas" on public.casinha_config for all to authenticated using (public.imarcas_eh_membro()) with check (public.imarcas_eh_membro());
insert into public.casinha_config (id) values (1) on conflict do nothing;
insert into public.casinha_carnes (slug,nome,unidade,unidade_desc,peso_kg,preco_custo,icone,ordem) values
 ('picanha','Picanha','peca','peça (~1,2 kg)',1.2,110,'i-picanha',1),
 ('contra','Contrafilé','kg','kg',1,55,'i-contra',2),
 ('fralda','Fraldinha','kg','kg',1,50,'i-fralda',3),
 ('lingui','Linguiça toscana','kg','kg',1,28,'i-linguica',4),
 ('frango','Coxinha da asa','kg','kg',1,25,'i-frango',5),
 ('paoalho','Pão de alho','pacote','pacote',0,18,'i-pao',6),
 ('coalho','Queijo coalho','pacote','pacote',0,22,'i-queijo',7)
on conflict (slug) do nothing;

-- =====================================================================
-- AGENDA DE RESERVAS: dias fechados ficam bloqueados no site
-- =====================================================================
create table if not exists public.casinha_reservas (
  id uuid primary key default gen_random_uuid(),
  entrada date not null,
  saida date not null,
  nome text,
  whatsapp text,
  pacote text,
  valor numeric(10,2),
  status text not null default 'confirmada' check (status in ('pre','confirmada','cancelada')),
  obs text,
  criado_em timestamptz not null default now(),
  check (saida >= entrada)
);
-- impede duas reservas ativas no mesmo dia
alter table public.casinha_reservas drop constraint if exists casinha_reservas_sem_sobreposicao;
alter table public.casinha_reservas add constraint casinha_reservas_sem_sobreposicao
  exclude using gist (daterange(entrada, saida, '[]') with &&) where (status <> 'cancelada');
alter table public.casinha_reservas enable row level security;
drop policy if exists "casinha reservas admin imarcas" on public.casinha_reservas;
create policy "casinha reservas admin imarcas" on public.casinha_reservas for all to authenticated
  using (public.imarcas_eh_membro()) with check (public.imarcas_eh_membro());
-- o site só enxerga as DATAS ocupadas (sem nome, telefone ou valor)
create or replace function public.casinha_datas_ocupadas()
returns table (entrada date, saida date)
language sql stable security definer set search_path = ''
as $$
  select r.entrada, r.saida from public.casinha_reservas r
  where r.status <> 'cancelada' and r.saida >= current_date
  order by r.entrada;
$$;
revoke all on function public.casinha_datas_ocupadas() from public;
grant execute on function public.casinha_datas_ocupadas() to anon, authenticated;
