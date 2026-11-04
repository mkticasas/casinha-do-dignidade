# Atendente de IA · Casinha do Dignidade

Conversa sozinha no WhatsApp, consulta a agenda, faz o orçamento (mesmo cálculo do site), cria a pré-reserva, manda o Pix e confirma a data quando o pagamento cai.

```
Cliente no WhatsApp ─► Meta (WhatsApp Cloud API) ─► Worker (Cloudflare) ─► Claude (IA)
                                                        │
                                Supabase (agenda, preços, cupons, conversas)
                                                        │
                                  Mercado Pago (Pix) ─► webhook ─► reserva confirmada
                                                        │
                                       Telegram: avisos pra equipe
```

## O que ela faz e o que não faz

| Faz sozinha | Passa pra equipe (chamar_humano) |
|---|---|
| Ver se a data está livre e sugerir outras | Pagamento no cartão (link manual) |
| Orçamento com pacote, carnes e cupom | Visita na casa |
| Pré-reserva por 24 h (bloqueia a data no site) | Mais de 40 pessoas ou 7 diárias |
| Gerar o Pix e confirmar quando pagar | Reclamação, pedido fora do padrão, dúvida |

- Nunca dá desconto fora de cupom, nunca diz "confirmada" antes do Pix e nunca pede CPF ou cartão.
- Quando a equipe responde pelo app do WhatsApp (modo coexistência) ou a IA chama alguém, ela fica **12 h calada** naquela conversa.
- Pré-reserva sem pagamento em 24 h é cancelada sozinha (cron a cada 10 min) e a data volta a ficar livre no site.

## Arquivos

| Arquivo | Pra quê |
|---|---|
| `worker.js` | Servidor: webhooks, ferramentas da IA, integrações |
| `prompt.js` | Jeito de falar e regras da atendente. **Ajuste o comportamento aqui.** |
| `precos.js` | Tabela e cálculo. **Espelho do site: mudou preço lá, muda aqui.** |
| `teste.mjs` | `node teste.mjs`: 10 testes sem gastar nada |
| `../supabase/casinha_ia.sql` | Tabelas de conversa e campos novos da reserva |

## Instalação (uns 40 min)

1. **Banco:** rode `supabase/casinha_ia.sql` no SQL Editor do Supabase (pode rodar de novo sem problema).
2. **Cloudflare:** crie uma conta grátis e, nesta pasta, rode:
   ```
   npx wrangler login
   npx wrangler deploy
   ```
   Anote a URL (`https://casinha-atendente.<usuario>.workers.dev`) e coloque em `PUBLIC_URL` no `wrangler.toml`.
3. **Segredos mínimos pra testar:**
   ```
   npx wrangler secret put SUPABASE_SERVICE_KEY
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put ADMIN_KEY
   ```
   Depois abra `<URL>/simular`, cole a ADMIN_KEY e converse como se fosse cliente. Atenção: pré-reservas criadas no simulador são reais e bloqueiam a data por 24 h. Cancele no painel se precisar.
4. **WhatsApp (Meta):** em developers.facebook.com, crie o app do tipo Empresa e adicione o produto WhatsApp com o número da Casinha.
   - Webhook: URL `<URL>/webhook`, token de verificação = o seu `WA_VERIFY_TOKEN`. Assine os campos `messages` e, se usar coexistência, `smb_message_echoes`.
   - Segredos: `WA_TOKEN` (token permanente de usuário do sistema), `WA_PHONE_ID`, `WA_VERIFY_TOKEN`, `WA_APP_SECRET`.
5. **Pix (Mercado Pago):** `npx wrangler secret put MP_ACCESS_TOKEN` com a credencial de produção. O webhook do Pix já vai junto em cada cobrança, então não precisa configurar nada no painel do MP.
   - Sem esse token a IA continua funcionando: ela avisa a equipe pra mandar o Pix na mão.
6. **Avisos (opcional):** crie um bot no @BotFather e cadastre `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`.
7. Confira `<URL>/saude`: tem que mostrar `whatsapp`, `pix` e `ia` como `true`.

## Primeiro mês (revisão)

- Toda conversa fica salva em `casinha_ia_conversas` e `casinha_ia_mensagens`.
- Revisão semanal sugerida: ler 10 conversas, anotar onde a IA errou ou travou e ajustar o `prompt.js`.
- Pra devolver uma conversa pra IA antes das 12 h:
  ```
  POST <URL>/humano/liberar
  header: x-admin-key
  body: {"wa_id":"5517..."}
  ```
- Métricas: conversas por semana, quantas viraram pré-reserva, quantas pagaram e quantas foram pra equipe.

## Custo estimado

| Item | Custo |
|---|---|
| Cloudflare Workers | grátis até 100 mil requisições/dia |
| Claude Haiku | centavos por conversa |
| WhatsApp | conversa iniciada pelo cliente é grátis na janela de 24 h |
| Mercado Pago Pix | taxa do MP (~0,99%) |
