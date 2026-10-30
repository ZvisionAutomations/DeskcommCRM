-- manifest: **O follow-up ganha conta própria no `pacing_ledger`.** Decisão do dono (30/10): o teto diário do número (warm-up e `daily_message_limit`) passa a contar só a 1ª mensagem a pessoa nova; resposta e aviso à equipe ficam fora de qualquer teto (coluna `resposta`, da 9050), e o follow-up tem teto PRÓPRIO — 3x o warm-up do dia nos 15 primeiros dias do número, livre depois — contado à parte para não gastar o da 1ª mensagem. `retomada boolean not null default false` marca a linha do follow-up; `loadPacingState` e `lerEstadoDoPacing` contam a 1ª mensagem com `not resposta and not retomada` e o follow-up com `retomada`. Default `false`: toda linha antiga e todo escritor que não declara segue contando como 1ª mensagem. Idempotente; espelho no apêndice do `supabase/baseline.sql`. Reversão: `alter table public.pacing_ledger drop column retomada` (só perde a marca; as linhas voltam a contar como 1ª mensagem).
-- 9051 — follow-up tem conta própria no ledger.
--
-- Não cria função: nenhum grant a revogar.
alter table public.pacing_ledger
  add column if not exists retomada boolean not null default false;
comment on column public.pacing_ledger.retomada is
  'true = follow-up (retomada de conversa): conta no teto PROPRIO do follow-up, nao no da 1a mensagem (9051).';
