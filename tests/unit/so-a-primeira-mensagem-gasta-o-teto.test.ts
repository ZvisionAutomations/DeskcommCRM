/**
 * Decisão de 30/10: o teto do dia (warm-up e `daily_message_limit`) conta SÓ a
 * 1ª mensagem a uma pessoa nova.
 *  - resposta e aviso à equipe: fora de qualquer teto, não gastam saldo;
 *  - follow-up: teto PRÓPRIO — 3x o warm-up do dia nos 15 primeiros dias do
 *    número, livre depois —, contado à parte da 1ª mensagem;
 *  - espaçamento e janela de horário valem para todos.
 */
import { describe, expect, it, vi } from "vitest";
import { decidePacing, tetoDoFollowup } from "@/lib/agent-engine/pacing/engine";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { recordSend } from "@/lib/agent-engine/pacing/store";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { pacingGate } from "@/lib/agent-engine/guardrails/before-send";
import {
  decidirEspacamento,
  registrarEnvioNoLedger,
} from "@/lib/agent-engine/pacing/ledger-supabase";

const COMERCIAL = new Date("2026-07-28T13:00:00Z"); // 10h BRT, terça
const MADRUGADA = new Date("2026-07-28T06:00:00Z"); // 03h BRT
const DIA = 86_400_000;
const comIdade = (dias: number) => new Date(COMERCIAL.getTime() - dias * DIA - 1000);

function input(over: {
  now?: Date;
  resposta?: boolean;
  retomada?: boolean;
  prospeccao?: boolean;
  sentToday?: number;
  followupsToday?: number;
  lastSentAt?: Date | null;
  idadeDias?: number;
}) {
  return {
    now: over.now ?? COMERCIAL,
    knobs: PACING_DEFAULTS,
    ...(over.resposta !== undefined ? { resposta: over.resposta } : {}),
    ...(over.retomada !== undefined ? { retomada: over.retomada } : {}),
    ...(over.prospeccao !== undefined ? { prospeccao: over.prospeccao } : {}),
    state: {
      lastSentAt: over.lastSentAt ?? null,
      sentToday: over.sentToday ?? 0,
      followupsToday: over.followupsToday ?? 0,
      // idade 0 (sem data): cap de warm-up 20
      numberActivatedAt: over.idadeDias === undefined ? null : comIdade(over.idadeDias),
    },
    crmDailyLimit: null,
    rng: () => 0,
  };
}

describe("tetoDoFollowup — 3x o warm-up do dia nos 15 primeiros dias, livre depois", () => {
  const passos = PACING_DEFAULTS.warmupDailyCaps;
  it.each([
    [0, 60],
    [3, 60],
    [4, 150],
    [7, 150],
    [8, 300],
    [14, 300],
    [15, null],
    [40, null],
  ])("número com %i dia(s): %s", (dias, esperado) => {
    expect(tetoDoFollowup(dias, passos)).toBe(esperado);
  });
});

describe("decidePacing — 1ª mensagem × follow-up × resposta", () => {
  it("1ª mensagem com o teto batido é barrada", () => {
    const d = decidePacing(input({ sentToday: 20 }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("warmup_cap");
  });

  it("follow-up NÃO é barrado pelo teto da 1ª mensagem (20/20), e a 1ª não é barrada pelo do follow-up", () => {
    expect(decidePacing(input({ sentToday: 20, retomada: true })).allow).toBe(true);
    expect(decidePacing(input({ followupsToday: 60 })).allow).toBe(true);
  });

  it("follow-up tem teto próprio: 60 no dia 0 a 3, 150 no 4 a 7, 300 no 8 a 14", () => {
    for (const [idade, teto] of [[0, 60], [4, 150], [8, 300]] as const) {
      expect(decidePacing(input({ retomada: true, idadeDias: idade, followupsToday: teto - 1 })).allow).toBe(true);
      const d = decidePacing(input({ retomada: true, idadeDias: idade, followupsToday: teto }));
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toContain(`${teto}/dia`);
    }
  });

  it("do 15º dia em diante o follow-up é livre", () => {
    expect(decidePacing(input({ retomada: true, idadeDias: 15, followupsToday: 99_999 })).allow).toBe(true);
  });

  it("número sem data de ativação cai no degrau mais conservador (60)", () => {
    expect(decidePacing(input({ retomada: true, followupsToday: 60 })).allow).toBe(false);
  });

  it("follow-up continua respeitando o espaçamento entre mensagens", () => {
    const d = decidePacing(
      input({ retomada: true, idadeDias: 20, lastSentAt: new Date(COMERCIAL.getTime() - 200) }),
    );
    expect(d).toEqual({ allow: true, waitMs: PACING_DEFAULTS.throttleMs - 200 });
  });

  it("follow-up continua preso à janela de DISPARO (retomar não é responder)", () => {
    const d = decidePacing(input({ now: MADRUGADA, retomada: true, idadeDias: 20 }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("outside_window");
  });

  it("resposta é livre mesmo com os dois tetos batidos", () => {
    expect(decidePacing(input({ resposta: true, sentToday: 999, followupsToday: 999 })).allow).toBe(true);
  });

  it("prospecção prevalece: abordagem fria nunca abre o teto, nem declarando resposta ou retomada", () => {
    for (const extra of [{ resposta: true }, { retomada: true }]) {
      const d = decidePacing(input({ sentToday: 20, prospeccao: true, ...extra }));
      expect(d.allow).toBe(false);
    }
  });

  it("o gate de envio repassa a marca de follow-up ao motor", () => {
    const base = {
      now: COMERCIAL,
      body: "oi",
      provider: "waha",
      pacing: {
        knobs: PACING_DEFAULTS,
        state: { lastSentAt: null, sentToday: 20, followupsToday: 0, numberActivatedAt: null },
        crmDailyLimit: null,
        rng: () => 0,
      },
    };
    const sem = pacingGate.evaluate(base as never) as { pass: boolean };
    const com = pacingGate.evaluate({ ...base, pacing: { ...base.pacing, retomada: true } } as never) as {
      pass: boolean;
    };
    expect(sem.pass).toBe(false);
    expect(com.pass).toBe(true);
  });
});

describe("o ledger separa 1ª mensagem, follow-up e resposta", () => {
  function banco() {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    return { db: { query } as unknown as Queryable, query };
  }

  it("grava resposta e retomada em colunas distintas", async () => {
    const casos: Array<[Parameters<typeof recordSend>[4], boolean, boolean]> = [
      [undefined, false, false],
      [{}, false, false],
      [{ resposta: true }, true, false],
      [{ retomada: true }, false, true],
    ];
    for (const [opts, resposta, retomada] of casos) {
      const { db, query } = banco();
      await recordSend(db, "org", "sessao", COMERCIAL, opts);
      expect(query.mock.calls[0]![1]!.slice(3)).toEqual([resposta, retomada]);
    }
  });

  it("o PostgREST (lado do CRM) grava só a marca que foi pedida", async () => {
    const inserts: unknown[] = [];
    const admin = {
      from: () => ({
        insert: async (linha: unknown) => {
          inserts.push(linha);
          return { error: null };
        },
      }),
    } as never;
    await registrarEnvioNoLedger(admin, "org", "sessao", COMERCIAL);
    await registrarEnvioNoLedger(admin, "org", "sessao", COMERCIAL, { foraDoTeto: true });
    await registrarEnvioNoLedger(admin, "org", "sessao", COMERCIAL, { retomada: true });
    expect(inserts[0]).not.toHaveProperty("resposta");
    expect(inserts[0]).not.toHaveProperty("retomada");
    expect(inserts[1]).toMatchObject({ resposta: true });
    expect(inserts[1]).not.toHaveProperty("retomada");
    expect(inserts[2]).toMatchObject({ retomada: true });
    expect(inserts[2]).not.toHaveProperty("resposta");
  });
});

describe("decidirEspacamento (lado do CRM)", () => {
  const base = {
    agora: COMERCIAL,
    estado: { lastSentAt: null, sentToday: 20, followupsToday: 0, numberActivatedAt: null },
    throttleMs: 1_200,
    jitterMaxMs: 0,
    timezone: "America/Sao_Paulo",
    warmupDailyCaps: PACING_DEFAULTS.warmupDailyCaps,
    crmDailyLimit: null,
  };

  it("1ª mensagem com o teto batido é barrada; resposta/aviso e follow-up saem", () => {
    expect(decidirEspacamento(base)).toMatchObject({ liberado: false, motivo: "teto_diario" });
    expect(decidirEspacamento({ ...base, foraDoTeto: true })).toEqual({ liberado: true });
    expect(decidirEspacamento({ ...base, retomada: true })).toEqual({ liberado: true });
  });

  it("follow-up bate no teto próprio e a 1ª mensagem não é afetada por ele", () => {
    const estado = { ...base.estado, sentToday: 0, followupsToday: 60 };
    expect(decidirEspacamento({ ...base, estado, retomada: true })).toMatchObject({
      liberado: false,
      motivo: "teto_diario",
    });
    expect(decidirEspacamento({ ...base, estado })).toEqual({ liberado: true });
  });

  it("do 15º dia em diante o follow-up é livre", () => {
    const estado = {
      ...base.estado,
      followupsToday: 99_999,
      numberActivatedAt: new Date(COMERCIAL.getTime() - 16 * DIA),
    };
    expect(decidirEspacamento({ ...base, estado, retomada: true })).toEqual({ liberado: true });
  });

  it("foraDoTeto e retomada não dispensam o espaçamento", () => {
    const estado = { ...base.estado, lastSentAt: new Date(COMERCIAL.getTime() - 100) };
    for (const extra of [{ foraDoTeto: true }, { retomada: true }]) {
      expect(decidirEspacamento({ ...base, estado, ...extra })).toMatchObject({
        liberado: false,
        motivo: "espacamento",
      });
    }
  });
});
