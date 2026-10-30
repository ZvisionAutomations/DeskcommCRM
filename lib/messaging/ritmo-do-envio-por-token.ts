/**
 * O freio anti-ban de quem envia pela API com TOKEN — REST (`Bearer dsk_...`) e MCP.
 *
 * ## Por que existe
 *
 * `POST /api/v1/messages` e as ferramentas MCP de envio chamam
 * `sendMessageHandler` direto, sem a cadeia `before_send` (`runBeforeSend`). Pela
 * tela isso é certo: um atendente não digita rápido o bastante para queimar o
 * número. Por token não é: um script ou um agente externo em laço mandava
 * centenas de mensagens seguidas pelo mesmo número, sem espaçamento, sem teto de
 * warm-up — e sem contar no `pacing_ledger`, então o agente do próprio CRM seguia
 * achando que o número estava folgado.
 *
 * ## O que NÃO é
 *
 * Não é uma segunda REGRA. A decisão é `criarPacingDoCanal` (`ledger-supabase.ts`),
 * a mesma que o aviso ao suporte usa: espaçamento + teto diário (warm-up e
 * `daily_message_limit`). Os vetos de CONTEÚDO (promessa, vocabulário interno,
 * disclosure) ficam de fora de propósito — são para texto escrito pela IA do
 * CRM, e quem chama por token responde pelo que escreve.
 *
 * A janela de horário (7h-22h) também fica de fora: integração legítima manda
 * confirmação de pedido às 23h, e represá-la até as 7h quebraria o caso de uso.
 *
 * ## Limite conhecido
 *
 * Não há lock por número (o agente usa `pg_advisory_xact_lock`, que o PostgREST
 * não oferece). Duas chamadas CONCORRENTES leem o mesmo ledger e passam juntas.
 * O que segura a rajada paralela é o teto de chamadas por token (REST: nesta
 * rota; MCP: `lib/mcp/rate-limit.ts`), não este freio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  criarPacingDoCanal,
  type DecisaoDeEspacamento,
  type OpcoesDoPacing,
} from "@/lib/agent-engine/pacing/ledger-supabase";
import { ApiError } from "@/lib/api/types";
import { capabilitiesOf, DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";

/**
 * Espaçamento curto é ESPERADO dentro da requisição (o throttle é ~1,2s + jitter);
 * acima disto a requisição devolve 429 em vez de segurar a conexão aberta.
 */
export const ESPERA_MAXIMA_MS = 5_000;

export interface CanalDaConversa {
  channelSessionId: string;
  provider: string | null;
}

export interface DepsDoRitmo {
  lerCanalDaConversa(organizationId: string, conversationId: string): Promise<CanalDaConversa | null>;
  lerCanalDaSessao?(organizationId: string, channelSessionId: string): Promise<CanalDaConversa | null>;
  pacing: {
    decide(
      organizationId: string,
      channelSessionId: string,
      agora: Date,
      opcoes?: OpcoesDoPacing,
    ): Promise<DecisaoDeEspacamento>;
    registraEnvio(
      organizationId: string,
      channelSessionId: string,
      quando: Date,
      opcoes?: OpcoesDoPacing,
    ): Promise<void>;
  };
  /**
   * O que já houve entre a empresa e o destino (conversa ou contato), fora as
   * mensagens de sistema. É o que separa a 1ª mensagem a pessoa nova — a ÚNICA que
   * conta no teto do dia (decisão de 30/10) — do resto:
   * - `nenhum`: nunca trocaram mensagem → 1ª mensagem, conta no teto;
   * - `conversou`: a pessoa já escreveu (ou é a equipe) → resposta/aviso, fora de teto;
   * - `so_enviamos`: só nós escrevemos, ela nunca respondeu → follow-up, teto próprio.
   * Ausente = `nenhum`: o envio conta no teto, o comportamento de antes e a direção
   * segura. Se a leitura FALHAR, também conta.
   */
  historicoDoAlvo?(
    organizationId: string,
    alvo: { conversationId?: string | null; contactId?: string | null },
  ): Promise<HistoricoDoAlvo>;
  sleep(ms: number): Promise<void>;
  agora(): Date;
}

export type HistoricoDoAlvo = "nenhum" | "conversou" | "so_enviamos";

/** Entrada aceita por `segurarEnvioPorToken`: por conversa existente ou direto pela sessão do canal. */
export type EntradaDoFreio =
  | { organizationId: string; conversationId: string; requestId: string }
  | {
      organizationId: string;
      channelSessionId: string;
      requestId: string;
      /** Contato de destino, quando já se sabe (abrir conversa): permite separar 1ª mensagem de quem já está na base. */
      contactId?: string | null;
    };

/** O que `segurarEnvioPorToken` devolve e `registrarEnvioPorToken` consome. */
export type EnvioSegurado =
  | ({ channelSessionId: string } & OpcoesDoPacing)
  | null;

/** Como este envio entra na conta do teto. Sem classificar (ou falha) = 1ª mensagem: conta. */
async function opcoesDoEnvio(deps: DepsDoRitmo, entrada: EntradaDoFreio): Promise<OpcoesDoPacing> {
  if (!deps.historicoDoAlvo) return {};
  const alvo =
    "conversationId" in entrada
      ? { conversationId: entrada.conversationId }
      : { contactId: entrada.contactId ?? null };
  if (!("conversationId" in alvo ? alvo.conversationId : alvo.contactId)) return {};
  try {
    const historico = await deps.historicoDoAlvo(entrada.organizationId, alvo);
    if (historico === "conversou") return { foraDoTeto: true };
    if (historico === "so_enviamos") return { retomada: true };
    return {};
  } catch {
    return {};
  }
}

function temRiscoDeBan(provider: string | null): boolean {
  try {
    return capabilitiesOf((provider ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider).banRisk;
  } catch {
    // Provider fora da matriz: falha FECHADA. Errar para "sem risco" desarmaria
    // o freio num número que pode ser banido.
    return true;
  }
}

/**
 * Segura o envio até o número poder mandar, ou recusa com 429.
 *
 * Devolve `null` quando não há o que frear (canal sem risco de ban, ou conversa
 * que não é desta organização — aí quem responde é o handler, com o 404 dele).
 */
export async function segurarEnvioPorToken(
  deps: DepsDoRitmo,
  entrada: EntradaDoFreio,
): Promise<EnvioSegurado> {
  const canal =
    "channelSessionId" in entrada
      ? await (deps.lerCanalDaSessao
          ? deps.lerCanalDaSessao(entrada.organizationId, entrada.channelSessionId)
          : null)
      : await deps.lerCanalDaConversa(entrada.organizationId, entrada.conversationId);
  if (!canal || !temRiscoDeBan(canal.provider)) return null;

  const agora = deps.agora();
  const opcoes = await opcoesDoEnvio(deps, entrada);
  const classificado = opcoes.foraDoTeto === true || opcoes.retomada === true;
  // Só carrega a marca quando há uma: quem não tem como classificar (ou
  // classificou "1ª mensagem") segue exatamente como antes, sem opção nenhuma.
  const segurado: EnvioSegurado = { channelSessionId: canal.channelSessionId, ...opcoes };
  const decisao = classificado
    ? await deps.pacing.decide(entrada.organizationId, canal.channelSessionId, agora, opcoes)
    : await deps.pacing.decide(entrada.organizationId, canal.channelSessionId, agora);
  if (decisao.liberado) return segurado;

  const esperaMs = Math.max(0, decisao.liberaEm.getTime() - agora.getTime());
  if (decisao.motivo === "espacamento" && esperaMs <= ESPERA_MAXIMA_MS) {
    await deps.sleep(esperaMs);
    return segurado;
  }

  const retryAfterSeconds = Math.max(1, Math.ceil(esperaMs / 1000));
  const liberaEm = decisao.liberaEm.toISOString();
  // O valor vai no texto, não só em `details`: o servidor MCP devolve ao cliente apenas a
  // mensagem do erro (lib/mcp/server.ts), e um modelo sem o horário não sabe quando voltar.
  throw new ApiError(
    429,
    "rate_limited",
    { motivo: decisao.motivo, libera_em: liberaEm, retry_after_seconds: retryAfterSeconds },
    entrada.requestId,
    decisao.motivo === "teto_diario"
      ? `Este número atingiu o limite de envios de hoje. Tente de novo depois de ${liberaEm} (em ${retryAfterSeconds}s).`
      : `Envios rápidos demais para este número. Tente de novo em ${retryAfterSeconds}s.`,
  );
}

/** Conta no `pacing_ledger` o envio que passou pelo freio e não falhou. Nunca lança. */
export async function registrarEnvioPorToken(
  deps: Pick<DepsDoRitmo, "pacing" | "agora">,
  organizationId: string,
  segurado: EnvioSegurado,
  status: string,
): Promise<void> {
  if (!segurado || status === "failed") return;
  if (segurado.foraDoTeto === true || segurado.retomada === true) {
    await deps.pacing.registraEnvio(organizationId, segurado.channelSessionId, deps.agora(), {
      ...(segurado.foraDoTeto === true ? { foraDoTeto: true } : {}),
      ...(segurado.retomada === true ? { retomada: true } : {}),
    });
    return;
  }
  await deps.pacing.registraEnvio(organizationId, segurado.channelSessionId, deps.agora());
}

/** As dependências reais. `admin` é service role: toda leitura filtra `organization_id`. */
export async function depsDoRitmo(admin: SupabaseClient): Promise<DepsDoRitmo> {
  return {
    async lerCanalDaConversa(organizationId, conversationId) {
      const { data } = await admin
        .from("conversations")
        .select("channel_session_id, channel_sessions:channel_session_id(provider)")
        .eq("organization_id", organizationId)
        .eq("id", conversationId)
        .maybeSingle();
      const linha = data as {
        channel_session_id: string | null;
        channel_sessions: { provider: string | null } | null;
      } | null;
      if (!linha?.channel_session_id) return null;
      return {
        channelSessionId: linha.channel_session_id,
        provider: linha.channel_sessions?.provider ?? null,
      };
    },
    async lerCanalDaSessao(organizationId, channelSessionId) {
      const { data } = await admin
        .from("channel_sessions")
        .select("id, provider")
        .eq("organization_id", organizationId)
        .eq("id", channelSessionId)
        .maybeSingle();
      const linha = data as { id: string; provider: string | null } | null;
      if (!linha?.id) return null;
      return {
        channelSessionId: linha.id,
        provider: linha.provider ?? null,
      };
    },
    pacing: await criarPacingDoCanal(admin),
    async historicoDoAlvo(organizationId, alvo) {
      // Um `exists` por direção, do mais forte para o mais fraco: quem já escreveu
      // uma vez é "conversou" para sempre; só se não houver inbound é que se
      // pergunta pelo que NÓS mandamos.
      const existe = async (direcao: "inbound" | "outbound"): Promise<boolean> => {
        let consulta = admin
          .from("messages")
          .select("id")
          .eq("organization_id", organizationId)
          .eq("direction", direcao)
          .neq("type", "system")
          .limit(1);
        if (alvo.conversationId) consulta = consulta.eq("conversation_id", alvo.conversationId);
        else if (alvo.contactId) consulta = consulta.eq("contact_id", alvo.contactId);
        else return false;
        const { data, error } = await consulta.maybeSingle();
        if (error) throw new Error(error.message);
        return data !== null;
      };
      if (await existe("inbound")) return "conversou";
      if (await existe("outbound")) return "so_enviamos";
      return "nenhum";
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    agora: () => new Date(),
  };
}
