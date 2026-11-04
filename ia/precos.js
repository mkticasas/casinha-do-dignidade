// Tabela e cálculo de preço da Casinha do Dignidade.
// ESPELHO do orçamento do site (index.html). Se mudar preço lá, mude aqui também.

export const PRECOS = { semana: 450, sexdom: 650, sabado: 850 }; // diária por dia da semana
export const PACOTES = {
  casa:  { nome: "Casa",            add: 0,   desc: "casa inteira (10h às 22h), piscina, área gourmet e caixa de som; vocês tocam o churrasco" },
  brasa: { nome: "Brasa",           add: 250, desc: "tudo da Casa + churrasqueira acesa quando chegar, carvão, gelo e utensílios" },
  gold:  { nome: "Dignidade Gold",  add: 750, desc: "tudo do Brasa + churrasqueiro por até 6 horas, carne servida na mesa" },
};
export const LIMPEZA = 150;
export const JUROS = 0.0299;   // cartão, ao mês
export const PIX_DESC = 0.05;  // desconto no Pix
export const MAX_PESSOAS = 40;
export const MAX_DIARIAS = 7;

export const DIA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export const DIA_LONGO = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

const r2 = (v) => Math.round(v * 100) / 100;
export const brl = (v) => "R$ " + r2(v).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
export const brDate = (iso) => iso.split("-").reverse().slice(0, 2).join("/");
export function diaSemana(iso) { return new Date(iso + "T12:00:00Z").getUTCDay(); }
export function valorDia(dw) { return dw === 6 ? PRECOS.sabado : (dw === 5 || dw === 0) ? PRECOS.sexdom : PRECOS.semana; }
export function isoValida(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T12:00:00Z")); }

export function diasEntre(entrada, saida) {
  const out = [];
  const d = new Date(entrada + "T12:00:00Z"), fim = new Date((saida || entrada) + "T12:00:00Z");
  for (; d <= fim; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10), dw = d.getUTCDay();
    out.push({ iso, dw, valor: valorDia(dw) });
  }
  return out;
}

/**
 * Mesmo cálculo do site.
 * carnes: [{slug, qtd}] e tabelaCarnes: [{slug, nome, preco_venda, unidade}]
 * cupom: {codigo, tipo:'pct'|'reais', valor} já validado no banco (ou null)
 * pagamento: 'pix' | número de parcelas no cartão (1 a 18)
 */
export function calcular({ entrada, saida, pessoas, pacote, carnes = [], tabelaCarnes = [], cupom = null, pagamento = "pix", hoje }) {
  const erros = [];
  if (!isoValida(entrada)) erros.push("data de entrada inválida");
  saida = saida || entrada;
  if (!isoValida(saida)) erros.push("data de saída inválida");
  if (!erros.length && saida < entrada) erros.push("a saída não pode ser antes da entrada");
  if (!erros.length && hoje && entrada < hoje) erros.push("a data já passou");
  if (!PACOTES[pacote]) erros.push("pacote precisa ser casa, brasa ou gold");
  pessoas = +pessoas || 0;
  if (pessoas > MAX_PESSOAS) erros.push(`o máximo é ${MAX_PESSOAS} pessoas`);
  if (erros.length) return { ok: false, erros };

  const dias = diasEntre(entrada, saida);
  if (dias.length > MAX_DIARIAS) return { ok: false, erros: [`o máximo é ${MAX_DIARIAS} diárias seguidas`] };
  const nd = dias.length;
  const linhas = [];
  let sub = 0;
  const add = (rot, v) => { if (v > 0) { linhas.push([rot, r2(v)]); sub += v; } };

  const totalDiarias = dias.reduce((s, x) => s + x.valor, 0);
  add(nd === 1 ? `Diária (${DIA_LONGO[dias[0].dw]})` : `${nd} diárias (${DIA[dias[0].dw]} a ${DIA[dias[nd - 1].dw]})`, totalDiarias);
  add(nd > 1 ? `Pacote ${PACOTES[pacote].nome} × ${nd} dias` : `Pacote ${PACOTES[pacote].nome}`, PACOTES[pacote].add * nd);
  add("Taxa de limpeza", LIMPEZA);
  if (cupom && +cupom.valor > 0) {
    const base = totalDiarias + PACOTES[pacote].add * nd;
    const desc = r2(cupom.tipo === "pct" ? base * cupom.valor / 100 : Math.min(cupom.valor, base));
    if (desc > 0) { linhas.push([`Cupom ${cupom.codigo}`, -desc]); sub -= desc; }
  }
  const carnesOk = [], carnesNaoAchei = [];
  for (const c of carnes || []) {
    const t = tabelaCarnes.find((x) => x.slug === c.slug);
    const q = Math.max(0, Math.round(+c.qtd || 0));
    if (!t) { carnesNaoAchei.push(c.slug); continue; }
    if (q) { add(`${q}× ${t.nome}`, q * +t.preco_venda); carnesOk.push({ slug: t.slug, nome: t.nome, qtd: q }); }
  }

  let total = sub, pagamentoTxt, parcela = null;
  if (pagamento === "pix") {
    const d = sub * PIX_DESC; total = sub - d; linhas.push(["Desconto Pix 5%", -r2(d)]); pagamentoTxt = "Pix à vista";
  } else {
    const n = Math.min(18, Math.max(1, Math.round(+pagamento || 1)));
    if (n === 1) pagamentoTxt = `1x de ${brl(sub)} no cartão`;
    else { parcela = sub * JUROS / (1 - Math.pow(1 + JUROS, -n)); total = parcela * n; pagamentoTxt = `${n}x de ${brl(parcela)} no cartão`; }
  }
  return {
    ok: true, entrada, saida, diarias: nd, pessoas, pacote: PACOTES[pacote].nome,
    dias: dias.map((x) => `${DIA[x.dw]} ${brDate(x.iso)} ${brl(x.valor)}`),
    linhas: linhas.map(([r, v]) => `${r}: ${v < 0 ? "− " + brl(-v) : brl(v)}`),
    carnes: carnesOk, carnes_nao_encontradas: carnesNaoAchei,
    cupom: cupom ? cupom.codigo : null,
    pagamento: pagamentoTxt, total: r2(total), total_txt: brl(total),
    lembrete: "Bebida da geladeira da casa é paga no fim, pelo que consumir. Tem geladeira livre pra bebida do cliente.",
  };
}
