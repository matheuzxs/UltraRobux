/**
 * API Promisse — https://api.promisse.com.br
 * POST /transactions { amount } · GET /transactions/:id
 */

function authHeader(env) {
  const secret = env.PROMISSE_SECRET_KEY || '';
  const prefix = env.PROMISSE_AUTH_PREFIX;
  return prefix ? `${prefix} ${secret}`.trim() : secret;
}

function apiBase(env) {
  const raw = (env.PROMISSE_API_URL || 'https://api.promisse.com.br').trim();
  return raw.replace(/\/$/, '');
}

function transactionsPath(env) {
  const p = env.PROMISSE_TRANSACTIONS_PATH || '/transactions';
  return p.startsWith('/') ? p : `/${p}`;
}

/** Extrai ID, QR e copia-e-cola de vários formatos possíveis de resposta */
function normalizeCreateResponse(result) {
  const root = result?.data && typeof result.data === 'object' ? { ...result, ...result.data } : result || {};

  const paymentCode =
    root.id ??
    root._id ??
    root.transaction_id ??
    root.transactionId ??
    root.payment_code ??
    root.uuid;

  const pix = root.pix && typeof root.pix === 'object' ? root.pix : {};
  const pixQrText =
    pix.copyPaste ??
    pix.copy_paste ??
    pix.qrcode_text ??
    pix.qrcodeText ??
    pix.payload ??
    pix.brCode ??
    pix.emv ??
    root.copyPaste ??
    root.copy_paste ??
    root.brcode ??
    root.brCode ??
    root.emv ??
    root.pixCode ??
    root.qrcode_text ??
    root.pix_qrcode_text;

  const pixQrCode =
    pix.qrcode ??
    pix.qr_code ??
    pix.encodedImage ??
    pix.qrCodeBase64 ??
    root.qrcode ??
    root.qr_code ??
    root.qrCode;

  return { paymentCode: paymentCode != null ? String(paymentCode) : null, pixQrCode, pixQrText, raw: result };
}

/** Normaliza status da Promisse para o que o front / DB esperam */
export function mapPromisseStatusToInternal(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim();
  const paid = ['paid', 'approved', 'completed', 'success', 'confirmed', 'pago', 'aprovado'];
  const pending = ['waiting_payment', 'pending', 'waiting', 'processing', 'pendente', 'aguardando'];
  if (paid.some((x) => s.includes(x))) return 'paid';
  if (pending.some((x) => s.includes(x))) return 'waiting_payment';
  if (s.includes('refund')) return 'refunded';
  if (s.includes('fail') || s.includes('cancel')) return 'error';
  return s;
}

export async function createPixCharge({ req: _req, input, publicBaseUrl: _publicBaseUrl, env }) {
  const base = apiBase(env);
  const secret = env.PROMISSE_SECRET_KEY || '';
  const path = transactionsPath(env);

  if (!secret) {
    throw new Error('Configure PROMISSE_SECRET_KEY no .env (sua sk_live_...)');
  }

  const amount = input.amount != null ? Number(input.amount) : 2790;
  const utms = input.utms && typeof input.utms === 'object' ? input.utms : {};
  const iCust = input.customer || {};

  const customerName = (iCust.name || input.name || 'Cliente Privacy').toUpperCase();
  let customerCpf = iCust.cpf || iCust.document || input.cpf || '';
  customerCpf = String(customerCpf).replace(/\D/g, '') || '00000000000';
  const customerEmail =
    iCust.email ||
    input.email ||
    `${String(customerName).toLowerCase().replace(/\s+/g, '.')}@email.com`;

  const url = `${base}${path}`;
  const body = { amount };

  const extra = env.PROMISSE_TRANSACTION_BODY_JSON;
  if (extra) {
    try {
      const parsed = JSON.parse(extra);
      Object.assign(body, parsed);
    } catch {
      console.warn('[Promisse] PROMISSE_TRANSACTION_BODY_JSON inválido, ignorando');
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(env),
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`Resposta inválida da Promisse (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const msg = result.message || result.error || result.errors || text;
    throw new Error(`Promisse ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }

  const { paymentCode, pixQrCode, pixQrText, raw } = normalizeCreateResponse(result);
  if (!paymentCode) {
    throw new Error(`Promisse não retornou id da transação: ${text.slice(0, 400)}`);
  }

  const externalCode = paymentCode;

  return {
    paymentCode,
    pixQrCode,
    pixQrText,
    externalCode,
    amount,
    customerName,
    customerEmail,
    customerCpf,
    utms,
    raw
  };
}

/** GET /transactions/:id — para polling de status no servidor */
export async function fetchPromisseTransaction(transactionId, env) {
  const base = apiBase(env);
  const secret = env.PROMISSE_SECRET_KEY || '';
  const path = transactionsPath(env);
  const url = `${base}${path}/${encodeURIComponent(transactionId)}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: authHeader(env),
      Accept: 'application/json'
    }
  });

  const text = await res.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    return null;
  }

  if (!res.ok) return null;
  const root = result?.data && typeof result.data === 'object' ? { ...result, ...result.data } : result;
  return root;
}
