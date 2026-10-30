import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decidePacing } from "@/lib/agent-engine/pacing/engine";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { loadPacingState, recordSend } from "@/lib/agent-engine/pacing/store";

/**
 * O TETO DO DIA CONTA SÓ A 1ª MENSAGEM A PESSOA NOVA (decisão de 30/10).
 *
 * Resposta (`pacing_ledger.resposta`, 9050) e follow-up (`retomada`, 9051) não
 * entram em `sentToday`; o follow-up é contado à parte em `followupsToday`. O que
 * este arquivo prova é a CONTAGEM CONTRA O SCHEMA REAL — o SQL de
 * `loadPacingState` e o INSERT de `recordSend` rodando no baseline —, que os
 * testes de unidade (banco falso) não alcançam. Sem ele, um `not resposta`
 * esquecido na query deixaria o motor verde e o número sem proteção.
 */

if (!process.env.TEST_DB_CONTAINER) throw new Error("rode via pnpm test:db");
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: "postgres",
  password: "postgres",
  database: "postgres",
  max: 2,
});

const org = randomUUID();
const sessao = randomUUID();
// Terça 10h em São Paulo: janela comercial aberta, dia local de 28/07.
const AGORA = new Date("2026-07-28T13:00:00Z");
const TZ = "America/Sao_Paulo";
const ATIVADO_HA_2_DIAS = new Date(AGORA.getTime() - 2 * 86_400_000);

beforeAll(async () => {
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name,timezone)
     values($1::uuid,$1::text,'Teste Ledger','Teste Ledger',$2)`,
    [org, TZ],
  );
  await pool.query(
    `insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted)
     values($1,$2,'waha','ledger-test','WORKING','\\x00'::bytea)`,
    [sessao, org],
  );
});
afterAll(() => pool.end());

async function estado() {
  return loadPacingState(pool, org, sessao, {
    now: AGORA,
    timezone: TZ,
    numberActivatedAt: ATIVADO_HA_2_DIAS,
  });
}

describe("a contagem do dia no schema real", () => {
  it("a coluna `resposta` e a coluna `retomada` existem, booleanas, com default false", async () => {
    const { rows } = await pool.query(
      `select column_name, data_type, column_default, is_nullable
         from information_schema.columns
        where table_name = 'pacing_ledger' and column_name in ('resposta','retomada')
        order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: "resposta", data_type: "boolean", column_default: "false", is_nullable: "NO" },
      { column_name: "retomada", data_type: "boolean", column_default: "false", is_nullable: "NO" },
    ]);
  });

  it("só a 1ª mensagem sobe `sentToday`; resposta e follow-up não sobem, e o follow-up sobe a conta dele", async () => {
    const hora = (min: number) => new Date(AGORA.getTime() - min * 60_000);
    await recordSend(pool, org, sessao, hora(50)); // 1ª mensagem
    await recordSend(pool, org, sessao, hora(40), {}); // 1ª mensagem
    await recordSend(pool, org, sessao, hora(30), { resposta: true }); // resposta
    await recordSend(pool, org, sessao, hora(20), { retomada: true }); // follow-up
    await recordSend(pool, org, sessao, hora(10), { retomada: true }); // follow-up
    // ontem: não conta em nada de hoje, mas vale para o espaçamento
    await recordSend(pool, org, sessao, new Date(AGORA.getTime() - 26 * 3_600_000), { retomada: true });

    const e = await estado();
    expect(e.sentToday).toBe(2);
    expect(e.followupsToday).toBe(2);
    // o espaçamento enxerga TODAS as linhas (a mais recente é o follow-up de 10 min atrás)
    expect(e.lastSentAt && new Date(e.lastSentAt).getTime()).toBe(AGORA.getTime() - 10 * 60_000);
  });

  it("o motor, alimentado pelo estado real, separa os três tetos", async () => {
    // Encha o saldo da 1ª mensagem até o degrau de warm-up do dia 2 (20).
    for (let i = 0; i < 18; i += 1) {
      await recordSend(pool, org, sessao, new Date(AGORA.getTime() - (200 + i) * 1000));
    }
    const e = await estado();
    expect(e.sentToday).toBe(20);
    const base = {
      now: AGORA,
      knobs: PACING_DEFAULTS,
      state: e,
      crmDailyLimit: null,
      rng: () => 0,
    };
    // 1ª mensagem: barrada (20/20).
    expect(decidePacing(base).allow).toBe(false);
    // resposta e follow-up: saem (follow-up está em 2 de 60).
    expect(decidePacing({ ...base, resposta: true }).allow).toBe(true);
    expect(decidePacing({ ...base, retomada: true }).allow).toBe(true);
    // Encha o teto PRÓPRIO do follow-up (60): ele barra, e a 1ª mensagem continua só no teto dela.
    for (let i = 0; i < 58; i += 1) {
      await recordSend(pool, org, sessao, new Date(AGORA.getTime() - (400 + i) * 1000), {
        retomada: true,
      });
    }
    const cheio = await estado();
    expect(cheio.followupsToday).toBe(60);
    expect(cheio.sentToday).toBe(20);
    expect(decidePacing({ ...base, state: cheio, retomada: true }).allow).toBe(false);
    expect(decidePacing({ ...base, state: cheio, resposta: true }).allow).toBe(true);
  });
});
