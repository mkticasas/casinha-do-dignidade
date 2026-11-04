// Atendente de IA da Casinha do Dignidade (Cloudflare Worker)
// Rotas:
//   GET  /webhook         verificação da Meta (WhatsApp Cloud API)
//   POST /webhook         mensagens do WhatsApp
//   POST /pix/webhook     aviso de pagamento do Mercado Pago
//   GET  /simular         chat de teste no navegador (pede a ADMIN_KEY)
//   POST /simular         { wa_id, texto, nome } -> resposta da IA, sem WhatsApp
//   POST /humano/liberar  { wa_id } -> a IA volta a responder essa conversa
//   GET  /saude           status
// Cron (wrangler.toml): cancela pré-reserva vencida a cada 10 min.

import { calcular, diasEntre, isoValida, brl, brDate, DIA, DIA_LONGO, MAX_PESSOAS } from "./precos.js";
import { systemPrompt } from "./prompt.js";

const HORAS_PRE_RESERVA = 24;
const HORAS_HUMANO = 12;
const MAX_VOLTAS = 6;
const HIST = 40;

// ---------------------------------------------------------------- ferramentas
export const TOOLS = [
  {
    name: "ver_disponibilidade",
    description: "Confere se uma data (ou período) está livre na agenda e devolve o dia da semana de cada data. Sempre use antes de dizer que uma data está livre. Se estiver ocupada, devolve sugestões de datas livres.",
    input_schema: { type: "object", properties: {
      entrada: { type: "string", description: "Data de entrada AAAA-MM-DD" },
      saida: { type: "string", description: "Data de saída AAAA-MM-DD (igual à entrada se for um dia só)" },
    }, required: ["entrada"] },
  },
  {
    name: "listar_carnes",
    description: "Lista as carnes disponíveis pra encomenda, com unidade e preço atual.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "calcular_orcamento",
    description: "Calcula o orçamento exato (mesmo cálculo do site). Use sempre que for falar de valor.",
    input_schema: { type: "object", properties: {
      entrada: { type: "string" }, saida: { type: "string" },
      pessoas: { type: "integer" },
      pacote: { type: "string", enum: ["casa", "brasa", "gold"] },
      carnes: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, qtd: { type: "integer" } }, required: ["slug", "qtd"] } },
      cupom: { type: "string", description: "Código do cupom, se a pessoa tiver" },
      pagamento: { type: "string", description: "'pix' ou o número de parcelas no cartão (ex.: '12')" },
    }, required: ["entrada", "pessoas", "pacote"] },
  },
  {
    name: "criar_pre_reserva",
    description: "Cria a pré-reserva e bloqueia a data por 24 horas. Só use depois que a pessoa confirmou que quer fechar e passou o nome.",
    input_schema: { type: "object", properties: {
      entrada: { type: "string" }, saida: { type: "string" },
      pessoas: { type: "integer" },
      pacote: { type: "string", enum: ["casa", "brasa", "gold"] },
      nome: { type: "string" },
      carnes: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, qtd: { type: "integer" } }, required: ["slug", "qtd"] } },
      cupom: { type: "string" },
    }, required: ["entrada", "pessoas", "pacote", "nome"] },
  },
  {
    name: "gerar_pix",
    description: "Gera o Pix da pré-reserva e envia o código copia-e-cola numa mensagem separada.",
    input_schema: { type: "object", properties: { reserva_id: { type: "string" } }, required: ["reserva_id"] },
  },
  {
    name: "chamar_humano",
    description: "Passa a conversa pra alguém da equipe e pausa a IA nessa conversa.",
    input_schema: { type: "object", properties: { motivo: { type: "string" } }, required: ["motivo"] },
  },
];

function hojeISO(deps) { return deps.now().toISOString().slice(0, 10); }
function addDias(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function sobrepoe(a, b, o) { return !(b < o.entrada || a > o.saida); }

async function proximasLivres(deps, ocupadas, aPartirDe) {
  const out = [];
  for (let i = 0; i < 70 && out.length < 6; i++) {
    const iso = addDias(aPartirDe, i), dw = new Date(iso + "T12:00:00Z").getUTCDay();
    if ((dw === 5 || dw === 6 || dw === 0) && !ocupadas.some((o) => sobrepoe(iso, iso, o))) out.push(`${DIA_LONGO[dw]} ${brDate(iso)} (${iso})`);
  }
  return out;
}

export async function executarFerramenta(nome, inp, ctx) {
  const { db, waId } = ctx, hoje = hojeISO(ctx);
  switch (nome) {
    case "ver_disponibilidade": {
      const entrada = inp.entrada, saida = inp.saida || inp.entrada;
      if (!isoValida(entrada) || !isoValida(saida)) return { erro: "data inválida, use AAAA-MM-DD" };
      if (entrada < hoje) return { erro: "essa data já passou", hoje };
      if (saida < entrada) return { erro: "a saída não pode ser antes da entrada" };
      await db.expirar();
      const ocupadas = await db.ocupadas();
      const dias = diasEntre(entrada, saida);
      const conflitos = dias.filter((d) => ocupadas.some((o) => sobrepoe(d.iso, d.iso, o))).map((d) => `${DIA_LONGO[d.dw]} ${brDate(d.iso)}`);
      return {
        livre: conflitos.length === 0,
        dias: dias.map((d) => `${DIA_LONGO[d.dw]} ${brDate(d.iso)}`),
        ocupados: conflitos,
        sugestoes_livres: conflitos.length ? await proximasLivres(ctx, ocupadas, entrada) : undefined,
      };
    }
    case "listar_carnes": {
      const t = await db.carnes();
      return { carnes: t.map((c) => ({ slug: c.slug, nome: c.nome, vende_por: c.unidade_desc || c.unidade, preco: brl(c.preco_venda) })), referencia: "400 g por pessoa" };
    }
    case "calcular_orcamento": {
      const cupom = inp.cupom ? await db.cupom(inp.cupom) : null;
      const pag = !inp.pagamento || /pix/i.test(inp.pagamento) ? "pix" : parseInt(inp.pagamento, 10) || 1;
      const r = calcular({ ...inp, cupom, pagamento: pag, tabelaCarnes: await db.carnes(), hoje });
      if (inp.cupom && !cupom) r.aviso_cupom = `o cupom ${String(inp.cupom).toUpperCase()} não é válido (ou venceu); calculei sem desconto`;
      return r;
    }
    case "criar_pre_reserva": {
      if (!inp.nome || inp.nome.trim().length < 2) return { ok: false, erro: "falta o nome da pessoa" };
      if ((+inp.pessoas || 0) > MAX_PESSOAS) return { ok: false, erro: `acima de ${MAX_PESSOAS} pessoas: chame a equipe` };
      await db.expirar();
      const saida = inp.saida || inp.entrada;
      // já existe pré-reserva dessa pessoa pras mesmas datas? devolve a mesma
      const minhas = await db.reservasPreDe(waId);
      const igual = minhas.find((r) => r.entrada === inp.entrada && r.saida === saida);
      if (igual) return { ok: true, reserva_id: igual.id, total: brl(igual.valor), ja_existia: true, validade: "24 horas a partir da criação" };
      const cupom = inp.cupom ? await db.cupom(inp.cupom) : null;
      const tabela = await db.carnes();
      const r = calcular({ ...inp, saida, cupom, pagamento: "pix", tabelaCarnes: tabela, hoje });
      if (!r.ok) return { ok: false, erro: r.erros.join("; ") };
      const expira = new Date(ctx.now().getTime() + HORAS_PRE_RESERVA * 3600e3);
      const obs = [
        r.carnes.length ? "Carnes: " + r.carnes.map((c) => `${c.qtd}× ${c.nome}`).join(", ") : null,
        cupom ? "Cupom: " + cupom.codigo : null,
        "Criada pela IA no WhatsApp",
      ].filter(Boolean).join(" · ");
      try {
        const res = await db.criarReserva({
          entrada: inp.entrada, saida, nome: inp.nome.trim(), whatsapp: waId, wa_id: waId, pessoas: +inp.pessoas || null,
          pacote: r.pacote, valor: r.total, status: "pre", origem: "ia", expira_em: expira.toISOString(), obs,
        });
        return { ok: true, reserva_id: res.id, total: r.total_txt, resumo: r.linhas, validade: "24 horas" };
      } catch (e) {
        if (e.conflito) return { ok: false, erro: "essa data acabou de ser reservada por outra pessoa", sugestoes_livres: await proximasLivres(ctx, await db.ocupadas(), inp.entrada) };
        throw e;
      }
    }
    case "gerar_pix": {
      const r = await db.reserva(inp.reserva_id);
      if (!r || r.wa_id !== waId) return { ok: false, erro: "reserva não encontrada pra esse WhatsApp" };
      if (r.status === "confirmada") return { ok: true, ja_pago: true };
      if (r.status !== "pre") return { ok: false, erro: "essa pré-reserva expirou ou foi cancelada; faça outra" };
      if (r.pix_copia_cola) { await ctx.enviar(waId, r.pix_copia_cola); return { ok: true, enviado: true, valor: brl(r.valor), reenviado: true }; }
      if (!ctx.pix) {
        await ctx.alertar(`Pix manual: ${r.nome} · ${brDate(r.entrada)}${r.saida !== r.entrada ? " a " + brDate(r.saida) : ""} · ${brl(r.valor)} · wa ${waId}`);
        return { ok: false, manual: true, instrucao: "o Pix automático ainda não está ligado: diga que a equipe manda a chave Pix por aqui em instantes e que a data está segura por 24 h" };
      }
      const p = await ctx.pix.criar({ valor: +r.valor, descricao: `Casinha do Dignidade ${brDate(r.entrada)}`, referencia: r.id, expira_em: r.expira_em });
      await db.atualizarReserva(r.id, { pagamento_id: String(p.id), pagamento_status: p.status, pix_copia_cola: p.copia_e_cola });
      await ctx.enviar(waId, p.copia_e_cola);
      return { ok: true, enviado: true, valor: brl(r.valor), validade: "24 horas" };
    }
    case "chamar_humano": {
      await db.setHumano(waId, new Date(ctx.now().getTime() + HORAS_HUMANO * 3600e3).toISOString());
      await ctx.alertar(`Atendimento humano: ${inp.motivo} · wa ${waId}`);
      return { ok: true, instrucao: "avise que alguém da equipe já vai responder por aqui" };
    }
  }
  return { erro: "ferramenta desconhecida" };
}

// ---------------------------------------------------------------- conversa
function blocos(c) { return typeof c === "string" ? [{ type: "text", text: c }] : c; }
export function montarMensagens(hist) {
  // começa sempre numa mensagem de texto do cliente (não corta par de ferramenta no meio)
  let i = hist.findIndex((m) => m.papel === "user" && typeof m.conteudo === "string");
  if (i < 0) return [];
  const msgs = [];
  for (const m of hist.slice(i)) {
    const role = m.papel === "user" ? "user" : "assistant";
    const content = m.papel === "humano" ? [{ type: "text", text: "[mensagem enviada pela equipe] " + m.conteudo }] : blocos(m.conteudo);
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content = [...blocos(last.content), ...content];
    else msgs.push({ role, content });
  }
  return msgs;
}
const textoDe = (content) => blocos(content).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

// ------------------------------------------------- mensagem pronta que vem do site
// O site manda: "Salve! Quero fechar a *Casinha do Dignidade*." + *Data:*/*Entrada:*, *Pessoas:*, *Pacote:*...
// Aqui viram dados prontos (datas em ISO com o ano certo, pacote e carnes no código interno)
// pra IA não perguntar de novo o que o cliente já escolheu.
const PACOTE_NOME = { "casa": "casa", "brasa": "brasa", "dignidade gold": "gold", "gold": "gold" };
export function lerMensagemSite(texto, hoje, tabelaCarnes = []) {
  if (!/Quero fechar a \*?Casinha do Dignidade/i.test(texto || "")) return null;
  const campo = (rot) => { const m = texto.match(new RegExp(`\\*${rot}:\\*\\s*([^\\n]+)`, "i")); return m ? m[1].trim() : null; };
  const iso = (ddmm) => {
    const m = /(\d{1,2})\/(\d{1,2})/.exec(ddmm || ""); if (!m) return null;
    let y = +hoje.slice(0, 4); const mmdd = `${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    if (`${y}-${mmdd}` < hoje) y++;            // 05/01 em novembro = ano que vem
    return `${y}-${mmdd}`;
  };
  const entrada = iso(campo("Data") || campo("Entrada"));
  const saida = iso(campo("Saída")) || entrada;
  const pac = (campo("Pacote") || "").toLowerCase();
  const cupom = campo("Cupom");
  const carnesTxt = campo("Carnes") || "";
  const carnes = [], carnesNaoAchei = [];
  if (!/sem encomenda/i.test(carnesTxt)) {
    for (const parte of carnesTxt.split(",")) {
      const m = /^\s*(\d+)\s+\S+\s+de\s+(.+?)\s*$/.exec(parte); if (!m) continue;
      const nome = m[2].toLowerCase();
      const t = tabelaCarnes.find((c) => String(c.nome).toLowerCase() === nome);
      if (t) carnes.push({ slug: t.slug, qtd: +m[1] }); else carnesNaoAchei.push(m[2]);
    }
  }
  const pagTxt = campo("Pagamento") || "";
  const parc = /(\d+)x/.exec(pagTxt);
  return {
    nome: campo("Nome"), entrada, saida, pessoas: +(campo("Pessoas") || 0) || null,
    pacote: PACOTE_NOME[pac] || null, cupom: cupom || null, carnes, carnes_nao_encontradas: carnesNaoAchei,
    pagamento: /pix/i.test(pagTxt) ? "pix" : parc ? (+parc[1] === 1 ? "cartão 1x" : `cartão ${parc[1]}x`) : null,
    total_no_site: campo("Total"),
  };
}
function anotarSite(texto, d) {
  const linhas = Object.entries(d).filter(([, v]) => v !== null && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  return `${texto}\n\n[DADOS DO ORÇAMENTO DO SITE, já escolhidos pelo cliente, não pergunte de novo]\n${linhas.join("\n")}`;
}

export async function responder({ waId, texto, nome, msgId }, deps) {
  const { db } = deps;
  await db.conversa(waId, nome);
  const hojeISO = deps.now().toISOString().slice(0, 10);
  if (/Quero fechar a \*?Casinha do Dignidade/i.test(texto || "")) {
    const d = lerMensagemSite(texto, hojeISO, await db.carnes().catch(() => []));
    if (d) texto = anotarSite(texto, d);
  }
  const nova = await db.salvarMsg(waId, "user", texto, msgId);
  if (!nova) return null;                                   // mensagem repetida do WhatsApp
  const conv = await db.getConversa(waId);
  if (conv && conv.humano_ate && new Date(conv.humano_ate) > deps.now()) return null; // equipe cuidando
  const messages = montarMensagens(await db.historico(waId, HIST));
  for (let volta = 0; volta < MAX_VOLTAS; volta++) {
    const resp = await deps.llm({ system: systemPrompt(deps.now()), messages, tools: TOOLS });
    messages.push({ role: "assistant", content: resp.content });
    await db.salvarMsg(waId, "assistant", resp.content);
    if (resp.stop_reason !== "tool_use") return textoDe(resp.content) || null;
    const resultados = [];
    for (const b of resp.content.filter((x) => x.type === "tool_use")) {
      let out;
      try { out = await executarFerramenta(b.name, b.input || {}, { ...deps, waId }); }
      catch (e) { out = { erro: "falha interna: " + String(e && e.message || e).slice(0, 200) }; }
      resultados.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: resultados });
    await db.salvarMsg(waId, "user", resultados);
  }
  await deps.alertar(`IA travou em loop · wa ${waId}`);
  return "Vou chamar alguém da equipe pra te ajudar, só um instante.";
}

// ---------------------------------------------------------------- integrações reais
function supa(env) {
  const base = env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/";
  const h = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" };
  const req = async (path, opt = {}) => {
    const r = await fetch(base + path, { ...opt, headers: { ...h, ...(opt.headers || {}) } });
    const t = await r.text();
    if (!r.ok) { const e = new Error(`supabase ${r.status}: ${t.slice(0, 300)}`); e.status = r.status; e.body = t; throw e; }
    return t ? JSON.parse(t) : null;
  };
  const rpc = (fn, args = {}) => req("rpc/" + fn, { method: "POST", body: JSON.stringify(args) });
  return {
    async conversa(waId, nome) {
      const body = { wa_id: waId, ultima_msg: new Date().toISOString() }; if (nome) body.nome = nome;
      await req("casinha_ia_conversas?on_conflict=wa_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(body) });
    },
    async getConversa(waId) { return (await req(`casinha_ia_conversas?wa_id=eq.${encodeURIComponent(waId)}&select=*`))[0] || null; },
    async salvarMsg(waId, papel, conteudo, msgId) {
      try { await req("casinha_ia_mensagens", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ wa_id: waId, papel, conteudo, wa_msg_id: msgId || null }) }); return true; }
      catch (e) { if (e.status === 409 || /23505/.test(e.body || "")) return false; throw e; }
    },
    async historico(waId, n) { return (await req(`casinha_ia_mensagens?wa_id=eq.${encodeURIComponent(waId)}&select=papel,conteudo&order=id.desc&limit=${n}`)).reverse(); },
    async setHumano(waId, ate) { await req(`casinha_ia_conversas?wa_id=eq.${encodeURIComponent(waId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ humano_ate: ate }) }); },
    ocupadas: () => rpc("casinha_datas_ocupadas"),
    expirar: () => rpc("casinha_expirar_pre"),
    carnes: () => req("casinha_carnes?ativo=eq.true&select=slug,nome,unidade,unidade_desc,peso_kg,preco_venda&order=ordem"),
    async cupom(cod) { const r = await rpc("casinha_validar_cupom", { p_codigo: String(cod) }); return r && r[0] ? { codigo: r[0].codigo, tipo: r[0].tipo, valor: +r[0].valor } : null; },
    reservasPreDe: (waId) => req(`casinha_reservas?wa_id=eq.${encodeURIComponent(waId)}&status=eq.pre&select=*`),
    async reserva(id) { if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null; return (await req(`casinha_reservas?id=eq.${id}&select=*`))[0] || null; },
    async reservaPorPagamento(pid) { return (await req(`casinha_reservas?pagamento_id=eq.${encodeURIComponent(pid)}&select=*`))[0] || null; },
    async criarReserva(obj) {
      try { return (await req("casinha_reservas", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(obj) }))[0]; }
      catch (e) { if (/23P01|sobreposicao/.test(e.body || "")) { const c = new Error("conflito"); c.conflito = true; throw c; } throw e; }
    },
    async atualizarReserva(id, patch) { await req(`casinha_reservas?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) }); },
  };
}

async function claude(env, body) {
  for (let t = 0; t < 3; t++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: env.MODEL || "claude-haiku-5-5", max_tokens: 1024, ...body }),
    });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && t < 2) { await new Promise((s) => setTimeout(s, 1500 * (t + 1))); continue; }
    throw new Error(`claude ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
}

async function waEnviar(env, to, texto) {
  if (!env.WA_TOKEN || !env.WA_PHONE_ID) return;
  const r = await fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: "Bearer " + env.WA_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: texto.slice(0, 4000), preview_url: false } }),
  });
  if (!r.ok) console.log("whatsapp erro", r.status, await r.text());
}

async function telegram(env, texto) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) { console.log("ALERTA:", texto); return; }
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: "🏠 Casinha · " + texto }),
  }).catch(() => {});
}

function mercadoPago(env) {
  if (!env.MP_ACCESS_TOKEN) return null;
  return {
    async criar({ valor, descricao, referencia, expira_em }) {
      const r = await fetch("https://api.mercadopago.com/v1/payments", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.MP_ACCESS_TOKEN, "Content-Type": "application/json", "X-Idempotency-Key": "casinha-" + referencia },
        body: JSON.stringify({
          transaction_amount: Math.round(valor * 100) / 100, description: descricao, payment_method_id: "pix",
          external_reference: referencia, notification_url: env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/$/, "") + "/pix/webhook" : undefined,
          date_of_expiration: expira_em ? new Date(expira_em).toISOString().replace("Z", "-00:00") : undefined,
          payer: { email: env.PIX_PAYER_EMAIL || "pagamentos@imarcas.com.br" },
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error("mercado pago " + r.status + ": " + JSON.stringify(j).slice(0, 300));
      return { id: j.id, status: j.status, copia_e_cola: j.point_of_interaction?.transaction_data?.qr_code };
    },
    async status(id) {
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`, { headers: { Authorization: "Bearer " + env.MP_ACCESS_TOKEN } });
      if (!r.ok) return null; return r.json();
    },
  };
}

function depsReais(env, extras = {}) {
  const db = supa(env);
  return {
    db, now: () => new Date(),
    llm: (body) => claude(env, body),
    pix: mercadoPago(env),
    enviar: extras.enviar || ((to, txt) => waEnviar(env, to, txt)),
    alertar: (txt) => telegram(env, txt),
  };
}

async function assinaturaOk(env, req, raw) {
  if (!env.WA_APP_SECRET) return true;
  const sig = req.headers.get("x-hub-signature-256") || "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WA_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sig === "sha256=" + hex;
}

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
const adminOk = (env, req) => env.ADMIN_KEY && req.headers.get("x-admin-key") === env.ADMIN_KEY;

async function processarWhatsApp(env, payload) {
  const deps = depsReais(env);
  for (const entry of payload.entry || []) for (const ch of entry.changes || []) {
    const v = ch.value || {};
    // modo coexistência: alguém do time respondeu pelo app -> IA pausa nessa conversa
    if (ch.field === "smb_message_echoes") {
      for (const m of v.message_echoes || []) {
        if (!m.to) continue;
        await deps.db.conversa(m.to);
        await deps.db.salvarMsg(m.to, "humano", m.text?.body || "[mídia]", m.id);
        await deps.db.setHumano(m.to, new Date(Date.now() + HORAS_HUMANO * 3600e3).toISOString());
      }
      continue;
    }
    const nome = v.contacts?.[0]?.profile?.name;
    for (const m of v.messages || []) {
      const waId = m.from;
      let texto = m.type === "text" ? m.text?.body
        : m.type === "button" ? m.button?.text
        : m.type === "interactive" ? (m.interactive?.button_reply?.title || m.interactive?.list_reply?.title) : null;
      if (!texto) {
        await deps.db.conversa(waId, nome).catch(() => {});
        const ok = await deps.db.salvarMsg(waId, "user", `[${m.type}]`, m.id).catch(() => false);
        if (ok) await deps.enviar(waId, "Por aqui eu consigo ler só mensagem escrita 🙏 Me manda em texto que eu te ajudo.");
        continue;
      }
      try {
        const resp = await responder({ waId, texto, nome, msgId: m.id }, deps);
        if (resp) await deps.enviar(waId, resp);
      } catch (e) {
        console.log("erro", e);
        await deps.alertar(`Erro na IA: ${String(e.message || e).slice(0, 200)} · wa ${waId}`);
        await deps.enviar(waId, "Deu um probleminha aqui. Já chamei alguém da equipe pra te responder.");
      }
    }
  }
}

async function processarPix(env, url, body) {
  const mp = mercadoPago(env); if (!mp) return;
  const id = body?.data?.id || url.searchParams.get("data.id") || url.searchParams.get("id");
  if (!id) return;
  const p = await mp.status(id); if (!p) return;
  const db = supa(env);
  const r = (p.external_reference && await db.reserva(p.external_reference)) || await db.reservaPorPagamento(String(id));
  if (!r) return;
  if (p.status === "approved" && r.status !== "confirmada") {
    await db.atualizarReserva(r.id, { status: "confirmada", expira_em: null, pagamento_status: "approved", pagamento_id: String(id) });
    const txt = `Pix confirmado! ✅ Sua reserva na Casinha do Dignidade está garantida: ${brDate(r.entrada)}${r.saida !== r.entrada ? " a " + brDate(r.saida) : ""}. Em seguida a equipe te manda o termo pra assinar pelo celular.`;
    if (r.wa_id) { await waEnviar(env, r.wa_id, txt); await db.salvarMsg(r.wa_id, "assistant", txt).catch(() => {}); }
    await telegram(env, `PAGO ✅ ${r.nome} · ${brDate(r.entrada)}${r.saida !== r.entrada ? " a " + brDate(r.saida) : ""} · ${brl(r.valor)} · mandar o termo`);
  } else if (p.status !== r.pagamento_status) {
    await db.atualizarReserva(r.id, { pagamento_status: p.status });
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/saude") return json({ ok: true, whatsapp: !!env.WA_TOKEN, pix: !!env.MP_ACCESS_TOKEN, ia: !!env.ANTHROPIC_API_KEY });

    if (url.pathname === "/webhook" && req.method === "GET") {
      if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === env.WA_VERIFY_TOKEN)
        return new Response(url.searchParams.get("hub.challenge") || "");
      return new Response("forbidden", { status: 403 });
    }
    if (url.pathname === "/webhook" && req.method === "POST") {
      const raw = await req.text();
      if (!(await assinaturaOk(env, req, raw))) return new Response("assinatura inválida", { status: 401 });
      ctx.waitUntil(processarWhatsApp(env, JSON.parse(raw)).catch((e) => console.log("webhook", e)));
      return new Response("ok");
    }
    if (url.pathname === "/pix/webhook" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      ctx.waitUntil(processarPix(env, url, body).catch((e) => console.log("pix", e)));
      return new Response("ok");
    }
    if (url.pathname === "/simular" && req.method === "GET") return new Response(SIMULADOR_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/simular" && req.method === "POST") {
      if (!adminOk(env, req)) return json({ erro: "chave de admin inválida" }, 401);
      const { wa_id = "teste-" + Date.now(), texto = "", nome = "Teste" } = await req.json().catch(() => ({}));
      const extras = [];
      const deps = depsReais(env, { enviar: async (_to, t) => { extras.push(t); } });
      try {
        const resposta = await responder({ waId: String(wa_id), texto: String(texto), nome, msgId: null }, deps);
        return json({ resposta, extras });
      } catch (e) { return json({ erro: String(e.message || e) }, 500); }
    }
    if (url.pathname === "/humano/liberar" && req.method === "POST") {
      if (!adminOk(env, req)) return json({ erro: "chave de admin inválida" }, 401);
      const { wa_id } = await req.json().catch(() => ({}));
      await supa(env).setHumano(String(wa_id), null);
      return json({ ok: true });
    }
    return new Response("Casinha do Dignidade · atendente", { status: 404 });
  },
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(supa(env).expirar().then((n) => { if (n) console.log("pré-reservas expiradas:", n); }));
  },
};

const SIMULADOR_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulador · Casinha do Dignidade</title><style>
*{box-sizing:border-box}body{margin:0;background:#1A1A19;color:#F2EEE6;font:16px system-ui,sans-serif;display:flex;flex-direction:column;height:100dvh}
header{padding:12px 16px;background:#24231F;display:flex;gap:8px;align-items:center;flex-wrap:wrap}header b{flex:1}
input,button{font:inherit;font-size:16px;border-radius:0;border:2px solid #4A4740;background:#1A1A19;color:#F2EEE6;padding:10px}
button{background:#FFD23F;color:#1A1712;border-color:#FFD23F;font-weight:800;cursor:pointer}
#log{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
.m{max-width:85%;padding:10px 12px;white-space:pre-wrap;line-height:1.4}.c{align-self:flex-end;background:#1FAE5B;color:#fff}.i{align-self:flex-start;background:#2E2B22}.x{align-self:flex-start;background:#3A3832;font-family:monospace;font-size:13px;word-break:break-all}
form{display:flex;gap:8px;padding:12px 16px;background:#24231F}form input{flex:1}
</style></head><body>
<header><b>Simulador da atendente</b><input id="k" type="password" placeholder="ADMIN_KEY" style="width:150px"><button type="button" id="novo">Nova conversa</button></header>
<div id="log"></div>
<form id="f"><input id="t" autocomplete="off" placeholder="Escreva como se fosse o cliente…"><button>Enviar</button></form>
<script>
let wa="teste-"+Date.now();const log=document.getElementById("log");
try{document.getElementById("k").value=localStorage.getItem("ak")||""}catch(e){}
function add(t,c){const d=document.createElement("div");d.className="m "+c;d.textContent=t;log.appendChild(d);log.scrollTop=1e9}
document.getElementById("novo").onclick=()=>{wa="teste-"+Date.now();log.innerHTML=""};
document.getElementById("f").onsubmit=async e=>{e.preventDefault();const t=document.getElementById("t").value.trim();if(!t)return;
  const k=document.getElementById("k").value;try{localStorage.setItem("ak",k)}catch(e){}
  add(t,"c");document.getElementById("t").value="";add("digitando…","i");
  const r=await fetch(location.pathname,{method:"POST",headers:{"content-type":"application/json","x-admin-key":k},body:JSON.stringify({wa_id:wa,texto:t})}).then(r=>r.json()).catch(e=>({erro:String(e)}));
  log.lastChild.remove();
  if(r.erro)add("Erro: "+r.erro,"x");else{if(r.resposta)add(r.resposta,"i");else add("(IA pausada: a equipe assumiu essa conversa)","x");(r.extras||[]).forEach(x=>add(x,"x"));}
};
</script></body></html>`;
