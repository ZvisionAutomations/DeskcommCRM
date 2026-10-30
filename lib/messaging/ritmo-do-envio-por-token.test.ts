import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { CHANNEL_CAPABILITIES } from "@/lib/channels/capabilities";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import {
  decidirEspacamento,
  type DecisaoDeEspacamento,
} from "@/lib/agent-engine/pacing/ledger-supabase";

import {
  ESPERA_MAXIMA_MS,
  registrarEnvioPorToken,
  segurarEnvioPorToken,
  type DepsDoRitmo,
  type HistoricoDoAlvo,
} from "./ritmo-do-envio-por-token";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const SESSAO = "33333333-3333-4333-8333-333333333333";
// Pergunta a CAPACIDADE, não o nome: um canal com e um sem risco de ban.
function providerCom(risco: boolean): string {
  return Object.entries(CHANNEL_CAPABILITIES).find(([, c]) => c.banRisk === risco)![0];
}
const COM_RISCO = providerCom(true);
const SEM_RISCO = providerCom(false);
const AGORA = new Date("2026-09-22T15:00:00.000Z");

function deps(
  canal: { channelSessionId: string; provider: string | null } | null,
  decisao: DecisaoDeEspacamento,
): DepsDoRitmo & { decide: ReturnType<typeof vi.fn>; sleep: ReturnType<typeof vi.fn> } {
  const decide = vi.fn(async () => decisao);
  const sleep = vi.fn(async () => {});
  return {
    lerCanalDaConversa: vi.fn(async () => canal),
    lerCanalDaSessao: vi.fn(async () => canal),
    pacing: { decide, registraEnvio: vi.fn(async () => {}) },
    sleep,
    agora: () => AGORA,
    decide,
  };
}

const entrada = { organizationId: ORG, conversationId: CONVERSA, requestId: "req-1" };

describe("segurarEnvioPorToken", () => {
  it("libera na hora quando o ledger do número está folgado", async () => {
    const d = deps({ channelSessionId: SESSAO, provider: COM_RISCO }, { liberado: true });
    await expect(segurarEnvioPorToken(d, entrada)).resolves.toEqual({ channelSessionId: SESSAO });
    expect(d.decide).toHaveBeenCalledWith(ORG, SESSAO, AGORA);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it("aceita channelSessionId direto antes de a conversa existir", async () => {
    const d = deps({ channelSessionId: SESSAO, provider: COM_RISCO }, { liberado: true });
    await expect(
      segurarEnvioPorToken(d, { organizationId: ORG, channelSessionId: SESSAO, requestId: "req-1" }),
    ).resolves.toEqual({ channelSessionId: SESSAO });
    expect(d.lerCanalDaSessao).toHaveBeenCalledWith(ORG, SESSAO);
    expect(d.lerCanalDaConversa).not.toHaveBeenCalled();
    expect(d.decide).toHaveBeenCalledWith(ORG, SESSAO, AGORA);
  });

  it("espera o espaçamento curto em vez de recusar", async () => {
    const liberaEm = new Date(AGORA.getTime() + 1_500);
    const d = deps(
      { channelSessionId: SESSAO, provider: COM_RISCO },
      { liberado: false, motivo: "espacamento", liberaEm },
    );
    await expect(segurarEnvioPorToken(d, entrada)).resolves.toEqual({ channelSessionId: SESSAO });
    expect(d.sleep).toHaveBeenCalledWith(1_500);
  });

  it("recusa com 429 quando o espaçamento passa da espera máxima", async () => {
    const liberaEm = new Date(AGORA.getTime() + ESPERA_MAXIMA_MS + 1);
    const d = deps(
      { channelSessionId: SESSAO, provider: COM_RISCO },
      { liberado: false, motivo: "espacamento", liberaEm },
    );
    const erro = await segurarEnvioPorToken(d, entrada).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(429);
    expect(d.sleep).not.toHaveBeenCalled();
    // O MCP só repassa a mensagem: os segundos têm de estar no texto.
    expect((erro as ApiError).message).toContain(`${Math.ceil((ESPERA_MAXIMA_MS + 1) / 1000)}s`);
  });

  it("recusa com 429 e diz quando volta quando o teto diário do número estourou", async () => {
    const liberaEm = new Date("2026-09-23T03:00:00.000Z");
    const d = deps(
      { channelSessionId: SESSAO, provider: COM_RISCO },
      { liberado: false, motivo: "teto_diario", liberaEm },
    );
    const erro = (await segurarEnvioPorToken(d, entrada).catch((e: unknown) => e)) as ApiError;
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro.status).toBe(429);
    expect(erro.code).toBe("rate_limited");
    expect(erro.details).toMatchObject({
      motivo: "teto_diario",
      libera_em: liberaEm.toISOString(),
      retry_after_seconds: 43_200,
    });
    // O MCP só repassa a mensagem: o horário e os segundos têm de estar no texto.
    expect(erro.message).toContain(liberaEm.toISOString());
    expect(erro.message).toContain("43200s");
  });

  it("não freia canal sem risco de banimento", async () => {
    const d = deps(
      { channelSessionId: SESSAO, provider: SEM_RISCO },
      { liberado: false, motivo: "teto_diario", liberaEm: AGORA },
    );
    await expect(segurarEnvioPorToken(d, entrada)).resolves.toBeNull();
    expect(d.decide).not.toHaveBeenCalled();
  });

  it("trata provider ausente ou desconhecido como canal com risco (falha fechada)", async () => {
    for (const provider of [null, "provider-que-nao-existe"]) {
      const d = deps(
        { channelSessionId: SESSAO, provider },
        { liberado: false, motivo: "teto_diario", liberaEm: AGORA },
      );
      const erro = await segurarEnvioPorToken(d, entrada).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ApiError);
    }
  });

  it("deixa o handler decidir quando a conversa não é desta organização", async () => {
    const d = deps(null, { liberado: true });
    await expect(segurarEnvioPorToken(d, entrada)).resolves.toBeNull();
    expect(d.decide).not.toHaveBeenCalled();
  });
});

describe("registrarEnvioPorToken", () => {
  it("conta no ledger o envio que não falhou", async () => {
    const d = deps(null, { liberado: true });
    await registrarEnvioPorToken(d, ORG, { channelSessionId: SESSAO }, "sent");
    expect(d.pacing.registraEnvio).toHaveBeenCalledWith(ORG, SESSAO, AGORA);
  });

  it("não conta envio que falhou nem envio que não passou pelo freio", async () => {
    const d = deps(null, { liberado: true });
    await registrarEnvioPorToken(d, ORG, { channelSessionId: SESSAO }, "failed");
    await registrarEnvioPorToken(d, ORG, null, "sent");
    expect(d.pacing.registraEnvio).not.toHaveBeenCalled();
  });
});

describe("só a 1ª mensagem a pessoa nova gasta o teto do dia (30/10)", () => {
  const CONTATO = "44444444-4444-4444-8444-444444444444";
  const alvoDoContato = {
    organizationId: ORG,
    channelSessionId: SESSAO,
    contactId: CONTATO,
    requestId: "r",
  };

  // Pacing REAL (a regra de verdade), com os dois saldos do dia já batidos.
  function comTetosBatidos(historico: HistoricoDoAlvo | "falha" | "ausente") {
    const registra = vi.fn(async () => {});
    const d: DepsDoRitmo = {
      lerCanalDaConversa: vi.fn(async () => ({ channelSessionId: SESSAO, provider: COM_RISCO })),
      lerCanalDaSessao: vi.fn(async () => ({ channelSessionId: SESSAO, provider: COM_RISCO })),
      pacing: {
        decide: async (_org, _sessao, agora, opcoes) =>
          decidirEspacamento({
            agora,
            estado: { lastSentAt: null, sentToday: 20, followupsToday: 60, numberActivatedAt: null },
            throttleMs: 1_200,
            jitterMaxMs: 0,
            timezone: "America/Sao_Paulo",
            warmupDailyCaps: PACING_DEFAULTS.warmupDailyCaps,
            crmDailyLimit: null,
            foraDoTeto: opcoes?.foraDoTeto === true,
            retomada: opcoes?.retomada === true,
          }),
        registraEnvio: registra,
      },
      ...(historico === "ausente"
        ? {}
        : {
            historicoDoAlvo: vi.fn(async () => {
              if (historico === "falha") throw new Error("banco fora");
              return historico;
            }),
          }),
      sleep: vi.fn(async () => {}),
      agora: () => AGORA,
    };
    return { d, registra };
  }

  it("contato que nunca falou com a empresa, com o teto batido: barrado (é 1ª mensagem)", async () => {
    const { d } = comTetosBatidos("nenhum");
    const erro = (await segurarEnvioPorToken(d, alvoDoContato).catch((e: unknown) => e)) as ApiError;
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro.details).toMatchObject({ motivo: "teto_diario" });
  });

  it("contato novo (sem contact_id), com o teto batido: barrado", async () => {
    const { d } = comTetosBatidos("conversou");
    const erro = await segurarEnvioPorToken(d, {
      organizationId: ORG,
      channelSessionId: SESSAO,
      requestId: "r",
    }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiError);
  });

  it("aviso ao Miguel / resposta (a pessoa já escreveu): sai fora de qualquer teto e não gasta saldo", async () => {
    const { d, registra } = comTetosBatidos("conversou");
    const segurado = await segurarEnvioPorToken(d, alvoDoContato);
    expect(segurado).toEqual({ channelSessionId: SESSAO, foraDoTeto: true });
    await registrarEnvioPorToken(d, ORG, segurado, "sent");
    expect(registra).toHaveBeenCalledWith(ORG, SESSAO, AGORA, { foraDoTeto: true });
  });

  it("conversa que já tem mensagem do cliente: resposta sai e não gasta saldo", async () => {
    const { d, registra } = comTetosBatidos("conversou");
    const segurado = await segurarEnvioPorToken(d, entrada);
    expect(segurado).toEqual({ channelSessionId: SESSAO, foraDoTeto: true });
    await registrarEnvioPorToken(d, ORG, segurado, "sent");
    expect(registra).toHaveBeenCalledWith(ORG, SESSAO, AGORA, { foraDoTeto: true });
  });

  it("só nós escrevemos (follow-up): conta no teto PRÓPRIO, não no da 1ª mensagem", async () => {
    const { d, registra } = comTetosBatidos("so_enviamos");
    // follow-ups do dia já em 60: barrado pelo teto próprio.
    const erro = await segurarEnvioPorToken(d, entrada).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiError);

    // com folga no teto do follow-up, sai mesmo com a 1ª mensagem em 20/20 e grava a marca certa.
    d.pacing.decide = async (_o, _s, agora, opcoes) =>
      decidirEspacamento({
        agora,
        estado: { lastSentAt: null, sentToday: 20, followupsToday: 5, numberActivatedAt: null },
        throttleMs: 1_200,
        jitterMaxMs: 0,
        timezone: "America/Sao_Paulo",
        warmupDailyCaps: PACING_DEFAULTS.warmupDailyCaps,
        crmDailyLimit: null,
        foraDoTeto: opcoes?.foraDoTeto === true,
        retomada: opcoes?.retomada === true,
      });
    const segurado = await segurarEnvioPorToken(d, entrada);
    expect(segurado).toEqual({ channelSessionId: SESSAO, retomada: true });
    await registrarEnvioPorToken(d, ORG, segurado, "sent");
    expect(registra).toHaveBeenCalledWith(ORG, SESSAO, AGORA, { retomada: true });
  });

  it("o espaçamento entre mensagens continua valendo para quem está fora do teto", async () => {
    const { d } = comTetosBatidos("conversou");
    d.pacing.decide = async (_o, _s, agora, opcoes) =>
      decidirEspacamento({
        agora,
        estado: {
          lastSentAt: new Date(AGORA.getTime() - 100),
          sentToday: 20,
          followupsToday: 60,
          numberActivatedAt: null,
        },
        throttleMs: 1_200,
        jitterMaxMs: 0,
        timezone: "America/Sao_Paulo",
        warmupDailyCaps: PACING_DEFAULTS.warmupDailyCaps,
        crmDailyLimit: null,
        foraDoTeto: opcoes?.foraDoTeto === true,
      });
    await segurarEnvioPorToken(d, entrada);
    expect(d.sleep).toHaveBeenCalledWith(1_100);
  });

  it("sem como classificar, ou se a leitura falha: conta no teto da 1ª mensagem (falha fechada)", async () => {
    for (const modo of ["ausente", "falha"] as const) {
      const { d } = comTetosBatidos(modo);
      const erro = await segurarEnvioPorToken(d, entrada).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ApiError);
    }
  });

  it("1ª mensagem que passou pelo freio é registrada SEM marca (gasta o saldo dela)", async () => {
    const { d, registra } = comTetosBatidos("nenhum");
    d.pacing.decide = async () => ({ liberado: true });
    const segurado = await segurarEnvioPorToken(d, entrada);
    await registrarEnvioPorToken(d, ORG, segurado, "sent");
    expect(registra).toHaveBeenCalledWith(ORG, SESSAO, AGORA);
  });
});
