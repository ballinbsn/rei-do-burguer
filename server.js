import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';

const app = express();
const PORT = process.env.PORT || 3000;

const PINPAY_BASE = 'https://api.usepinpay.com/functions/v1/api-v1';

/*
  "Banco de dados" em memória, só pra você ver o fluxo funcionando.
  Em produção de verdade, troque isso por um banco real (Postgres, SQLite, etc),
  porque esse Map zera toda vez que o servidor reinicia.
*/
const orders = new Map(); // orderId -> { status, pinpayId, amount, qrCode, qrCodeUrl, expiresAt, ... }

app.use(cors());

/* ------------------------------------------------------------------ */
/* IMPORTANTE: o webhook precisa do corpo "cru" (raw) pra validar o HMAC.
   Por isso ele usa express.raw() e vem ANTES do express.json() global. */
app.post('/api/webhooks/pinpay', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-webhook-signature'];
  if (!sig) return res.status(401).end();

  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.PINPAY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  if (!valid) {
    console.warn('[webhook] assinatura inválida, ignorando');
    return res.status(401).end();
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).end();
  }

  const { event, data } = payload;
  const order = findOrderByPinpayTx(data?.transaction_id);

  if (!order) {
    console.warn('[webhook] pedido não encontrado pra transaction_id', data?.transaction_id);
    return res.status(200).end(); // responde 200 mesmo assim pra não gerar retry infinito
  }

  // Idempotência simples: se já processamos esse evento pra esse pedido, ignora
  const dedupeKey = `${data.transaction_id}:${event}`;
  order.processedEvents = order.processedEvents || new Set();
  if (order.processedEvents.has(dedupeKey)) {
    return res.status(200).end();
  }
  order.processedEvents.add(dedupeKey);

  switch (event) {
    case 'payment_approved':
      order.status = 'paid';
      console.log(`[pedido ${order.orderId}] pago via ${data.payer_bank || 'Pix'}`);
      break;
    case 'payment_failed':
      order.status = data.status === 'expired' ? 'expired' : 'failed';
      break;
    case 'payment_refunded':
      order.status = 'refunded';
      break;
    default:
      break; // payment_pending, pix_received etc: não muda o status principal
  }

  res.status(200).end();
});
/* ------------------------------------------------------------------ */

app.use(express.json());

function findOrderByPinpayTx(transactionId) {
  for (const order of orders.values()) {
    if (order.pinpayId === transactionId) return order;
  }
  return null;
}

// Cria a cobrança Pix pro pedido
app.post('/api/pay', async (req, res) => {
  const { orderId, amountReais, customer } = req.body || {};

  if (!orderId || typeof orderId !== 'string') {
    return res.status(400).json({ error: 'orderId_invalid' });
  }
  const amount = Math.round(Number(amountReais) * 100); // reais -> centavos
  if (!Number.isInteger(amount) || amount < 100) {
    return res.status(400).json({ error: 'amount_invalid' });
  }
  if (!customer?.name || !customer?.phone) {
    return res.status(400).json({ error: 'customer_invalid' });
  }

  try {
    const r = await fetch(`${PINPAY_BASE}/pix`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.PINPAY_TOKEN,
        'Content-Type': 'application/json',
        'Idempotency-Key': orderId, // 1 pedido = 1 cobrança, mesmo se o cliente clicar 2x
      },
      body: JSON.stringify({
        amount,
        description: `Pedido Rei do Burguer #${orderId}`,
        customer: {
          name: customer.name,
          email: customer.email || `${orderId}@sem-email.local`,
          document: customer.cpf ? { type: 'CPF', number: customer.cpf.replace(/\D/g, '') } : undefined,
          phone: customer.phone.replace(/\D/g, ''),
        },
        expires_in: 600, // 10 minutos, igual ao site original
        webhook_url: process.env.PINPAY_WEBHOOK_URL,
        metadata: { external_reference: orderId },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.error('[pinpay] falha ao criar cobrança', r.status, err);
      return res.status(502).json({ error: 'gateway_error', detail: err.message });
    }

    const pix = await r.json();

    orders.set(orderId, {
      orderId,
      pinpayId: pix.id,
      status: 'pending',
      amount,
      qrCode: pix.qr_code,
      qrCodeUrl: pix.qr_code_url,
      expiresAt: pix.expires_at,
    });

    return res.json({
      qr_code: pix.qr_code,
      qr_code_url: pix.qr_code_url,
      expires_at: pix.expires_at,
      order_status: 'pending',
    });
  } catch (e) {
    console.error('[pinpay] exceção ao criar cobrança', e);
    return res.status(500).json({ error: 'internal' });
  }
});

// O frontend consulta esse endpoint a cada poucos segundos pra saber se já pagou
app.get('/api/orders/:orderId/status', (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'not_found' });
  res.json({ status: order.status, expires_at: order.expiresAt });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Servidor do Rei do Burguer rodando na porta ${PORT}`);
  if (!process.env.PINPAY_TOKEN) {
    console.warn('⚠️  PINPAY_TOKEN não configurado — copie .env.example para .env e preencha.');
  }
});
