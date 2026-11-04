// Teste local da atendente, sem WhatsApp, sem IA de verdade e sem banco:
//   node ia/teste.mjs
// Simula o banco em memória e uma IA "roteirizada" que chama as ferramentas
// na mesma ordem que a atendente real chamaria.
import assert from "node:assert/strict";
import { responder, executarFerramenta, montarMensagens } from "./worker.js";
import { calcular } from "./precos.js";

const AGORA = new Date("2026-11-04T15:00:00Z");
function bancoFake() {
  const s = { conversas: {}, msgs: [], reservas: [{ id: "00000000-0000-0000-0000-000000000001", entrada: "2026-11-07", saida: "2026-11-08", status: "pre", wa_id: "outro" }], seq: 1 };
  const carnes = [
    { slug: "picanha", nome: "Picanha", unidade: "peca", unidade_desc: "peça (~1,2 kg)", peso_kg: 1.2, preco_venda: 110 },
    { slug: "lingui", nome: "Linguiça toscana", unidade: "kg", unidade_desc: "kg", peso_kg: 1, preco_venda: 28 },
  ];
  const ativa = (r) => r.status !== "cancelada";
  return {
    s,
    async conversa(w, nome) { s.conversas[w] = { ...(s.conversas[w] || { wa_id: w }), ...(nome ? { nome } : {}) }; },
    async getConversa(w) { return s.conversas[w] || null; },
    async salvarMsg(w, papel, conteudo, id) { if (id && s.msgs.some((m) => m.id === id)) return false; s.msgs.push({ w, papel, conteudo: JSON.parse(JSON.stringify(conteudo)), id }); return true; },
    async historico(w, n) { return s.msgs.filter((m) => m.w === w).slice(-n).map((m) => ({ papel: m.papel, conteudo: m.conteudo })); },
    async setHumano(w, ate) { s.conversas[w].humano_ate = ate; },
    async ocupadas() { return s.reservas.filter(ativa).map((r) => ({ entrada: r.entrada, saida: r.saida })); },
    async expirar() { return 0; },
    async carnes() { return carnes; },
    async cupom(c) { return String(c).toUpperCase() === "CRISDOICASAS" ? { codigo: "CRISDOICASAS", tipo: "pct", valor: 5 } : null; },
    async reservasPreDe(w) { return s.reservas.filter((r) => r.wa_id === w && r.status === "pre"); },
    async reserva(id) { return s.reservas.find((r) => r.id === id) || null; },
    async criarReserva(o) {
      if (s.reservas.some((r) => ativa(r) && !(o.saida < r.entrada || o.entrada > r.saida))) { const e = new Error("conflito"); e.conflito = true; throw e; }
      const r = { ...o, id: `00000000-0000-0000-0000-${String(++s.seq).padStart(12, "0")}` }; s.reservas.push(r); return r;
    },
    async atualizarReserva(id, p) { Object.assign(s.reservas.find((r) => r.id === id), p); },
  };
}

// IA roteirizada: em cada volta devolve o próximo passo do roteiro
function iaRoteiro(passos) {
  let i = 0; const vistos = [];
  const fn = async ({ messages, tools, system }) => {
    vistos.push({ messages: JSON.parse(JSON.stringify(messages)), system });
    assert.ok(tools.length === 6, "6 ferramentas");
    const p = passos[i++]; if (!p) throw new Error("roteiro acabou");
    if (p.texto) return { stop_reason: "end_turn", content: [{ type: "text", text: p.texto }] };
    return { stop_reason: "tool_use", content: [{ type: "text", text: "" }, { type: "tool_use", id: "tu" + i, name: p.tool, input: p.input }] };
  };
  fn.vistos = vistos; return fn;
}

let ok = 0; const t = async (nome, f) => { await f(); ok++; console.log("✓", nome); };

await t("cálculo igual ao site (sábado + Brasa, Pix)", async () => {
  const r = calcular({ entrada: "2026-11-14", pessoas: 20, pacote: "brasa", pagamento: "pix" });
  assert.equal(r.total, 1187.5); // (850+250+150) * 0,95
});
await t("cupom 5% só na diária+pacote e 3 diárias", async () => {
  const r = calcular({ entrada: "2026-11-13", saida: "2026-11-15", pessoas: 30, pacote: "brasa", cupom: { codigo: "CRISDOICASAS", tipo: "pct", valor: 5 }, pagamento: "pix" });
  // diárias 650+850+650=2150, pacote 250*3=750, limpeza 150, cupom 5% de 2900 = 145 -> 2905 * 0,95
  assert.equal(r.total, 2759.75);
});
await t("cartão 12x com juros", async () => {
  const r = calcular({ entrada: "2026-11-14", pessoas: 20, pacote: "casa", pagamento: 12 });
  const sub = 850 + 150, pmt = sub * 0.0299 / (1 - Math.pow(1.0299, -12));
  assert.equal(r.total, Math.round(pmt * 12 * 100) / 100);
});
await t("data ocupada devolve sugestões", async () => {
  const db = bancoFake();
  const r = await executarFerramenta("ver_disponibilidade", { entrada: "2026-11-07" }, { db, waId: "x", now: () => AGORA });
  assert.equal(r.livre, false); assert.ok(r.sugestoes_livres.length > 0); assert.match(r.dias[0], /sábado 07\/11/);
});
await t("data no passado é recusada", async () => {
  const r = await executarFerramenta("ver_disponibilidade", { entrada: "2026-10-01" }, { db: bancoFake(), waId: "x", now: () => AGORA });
  assert.match(r.erro, /passou/);
});

await t("conversa completa: orçamento -> pré-reserva -> Pix enviado", async () => {
  const db = bancoFake(), enviados = [], alertas = [];
  const llm = iaRoteiro([
    { tool: "ver_disponibilidade", input: { entrada: "2026-11-14" } },
    { texto: "Sábado, 14/11 tá livre! Quantas pessoas e qual pacote?" },
    { tool: "calcular_orcamento", input: { entrada: "2026-11-14", pessoas: 20, pacote: "brasa", cupom: "crisdoicasas", carnes: [{ slug: "picanha", qtd: 2 }] } },
    { texto: "Ficou R$ ... no Pix. Fecha?" },
    { tool: "criar_pre_reserva", input: { entrada: "2026-11-14", pessoas: 20, pacote: "brasa", nome: "Ana Souza", cupom: "crisdoicasas", carnes: [{ slug: "picanha", qtd: 2 }] } },
    { tool: "gerar_pix", input: { reserva_id: "__ID__" } },
    { texto: "Mandei o Pix! A data fica segura por 24 h." },
  ]);
  const pix = { async criar({ valor, referencia }) { return { id: 999, status: "pending", copia_e_cola: `PIX-${referencia}-${valor}` }; } };
  const deps = { db, llm, pix, now: () => AGORA, enviar: async (to, t) => enviados.push(t), alertar: async (a) => alertas.push(a) };
  const w = "5517999990000";
  assert.match(await responder({ waId: w, texto: "Salve, tem dia 14?", nome: "Ana", msgId: "m1" }, deps), /14\/11/);
  // a mesma mensagem chegando de novo (retry do WhatsApp) não gera resposta
  assert.equal(await responder({ waId: w, texto: "Salve, tem dia 14?", nome: "Ana", msgId: "m1" }, deps), null);
  await responder({ waId: w, texto: "20 pessoas, brasa, 2 picanhas, cupom crisdoicasas", msgId: "m2" }, deps);
  // a IA recebeu o resultado do orçamento com o desconto do cupom
  const res = JSON.parse(llm.vistos[3].messages.at(-1).content[0].content);
  assert.equal(res.total, 1344.25); // (850+250+150-55+220)*0,95
  // pré-reserva + Pix: o roteiro usa o id real
  const passo = llm; const orig = passo; // troca o __ID__ pelo id criado
  const idx = 5; // gerar_pix
  db.s._patch = true;
  const fake = async (args) => { const r = await orig(args); if (r.content?.[1]?.name === "gerar_pix") r.content[1].input.reserva_id = db.s.reservas.at(-1).id; return r; };
  fake.vistos = orig.vistos;
  const final = await responder({ waId: w, texto: "Fecha! Meu nome é Ana Souza", msgId: "m3" }, { ...deps, llm: fake });
  assert.match(final, /24 h/);
  const r = db.s.reservas.at(-1);
  assert.equal(r.status, "pre"); assert.equal(r.origem, "ia"); assert.equal(r.valor, 1344.25); assert.match(r.obs, /2× Picanha/); assert.match(r.obs, /CRISDOICASAS/);
  assert.ok(new Date(r.expira_em) - AGORA === 24 * 3600e3);
  assert.equal(enviados.length, 1); assert.match(enviados[0], /^PIX-/);
  assert.equal(r.pix_copia_cola, enviados[0]);
});

await t("data reservada por outra pessoa no meio do caminho", async () => {
  const db = bancoFake();
  const r = await executarFerramenta("criar_pre_reserva", { entrada: "2026-11-08", pessoas: 10, pacote: "casa", nome: "Beto" }, { db, waId: "y", now: () => AGORA });
  assert.equal(r.ok, false); assert.match(r.erro, /reservada/);
});

await t("chamar humano pausa a IA e avisa a equipe", async () => {
  const db = bancoFake(), alertas = [];
  const llm = iaRoteiro([{ tool: "chamar_humano", input: { motivo: "quer pagar no cartão" } }, { texto: "Já chamei a equipe!" }]);
  const deps = { db, llm, now: () => AGORA, enviar: async () => {}, alertar: async (a) => alertas.push(a) };
  await responder({ waId: "z", texto: "quero pagar no cartão", msgId: "c1" }, deps);
  assert.match(alertas[0], /cartão/);
  // próxima mensagem: IA não responde (equipe cuidando)
  assert.equal(await responder({ waId: "z", texto: "oi?", msgId: "c2" }, deps), null);
});

await t("sem Pix automático configurado: avisa equipe e não trava", async () => {
  const db = bancoFake(), alertas = [];
  const c = await executarFerramenta("criar_pre_reserva", { entrada: "2026-11-21", pessoas: 10, pacote: "casa", nome: "Caio" }, { db, waId: "p", now: () => AGORA });
  const r = await executarFerramenta("gerar_pix", { reserva_id: c.reserva_id }, { db, waId: "p", now: () => AGORA, pix: null, enviar: async () => {}, alertar: async (a) => alertas.push(a) });
  assert.equal(r.manual, true); assert.match(alertas[0], /Pix manual/);
});

await t("histórico nunca começa no meio de uma ferramenta", async () => {
  const m = montarMensagens([
    { papel: "user", conteudo: [{ type: "tool_result", tool_use_id: "a", content: "{}" }] },
    { papel: "assistant", conteudo: [{ type: "text", text: "ok" }] },
    { papel: "user", conteudo: "oi" }, { papel: "humano", conteudo: "aqui é o Lucas" }, { papel: "assistant", conteudo: "e aí" },
  ]);
  assert.equal(m[0].role, "user"); assert.equal(m[0].content[0].text, "oi"); assert.equal(m.length, 2); assert.equal(m[1].content.length, 2);
});

console.log(`\n${ok} testes passaram`);
