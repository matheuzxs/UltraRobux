/**
 * Utmify S2S — port lógico de api/utmify-helper.php
 */
export async function sendUtmifyEvent(orderData, status, env) {
  const utmifyApiUrl = env.UTMIFY_API_URL || 'https://api.utmify.com.br/api-credentials/orders';
  const utmifyToken = env.UTMIFY_API_TOKEN || '';
  if (!utmifyToken) {
    console.warn('[Utmify] UTMIFY_API_TOKEN ausente');
    return { success: false, error: 'Missing API Token' };
  }

  let normalizedStatus = status;
  let approvedDate = null;
  let refundedAt = null;
  const createdAt = orderData.created_at || new Date().toISOString().replace('T', ' ').substring(0, 19);

  if (status === 'paid' || status === 'approved') {
    normalizedStatus = 'paid';
    approvedDate = new Date().toISOString().replace('T', ' ').substring(0, 19);
  } else if (status === 'refunded') {
    refundedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
  } else if (status === 'pending') {
    normalizedStatus = 'waiting_payment';
  }

  const allowedParams = ['src', 'sck', 'utm_source', 'utm_campaign', 'utm_medium', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ttclid'];
  let utms = orderData.utm_params;
  if (typeof utms === 'string') {
    try {
      utms = JSON.parse(utms);
    } catch {
      utms = {};
    }
  }
  utms = utms || {};

  const trackingParams = {};
  for (const key of allowedParams) {
    const val = utms[key];
    trackingParams[key] = val !== undefined && val !== '' ? val : null;
  }

  const amount = Number(orderData.amount || 0);
  const gatewayFee = Number(orderData.gateway_fee || 0);
  let commissionVal = amount - gatewayFee;
  if (commissionVal <= 0) commissionVal = amount;

  const cust = orderData.customer || {};
  const custName = cust.name || 'Cliente';
  const custEmail = cust.email || 'email@test.com';
  const custDoc = cust.document ? String(cust.document).replace(/\D/g, '') : null;
  const custPhone = cust.phone ? String(cust.phone).replace(/\D/g, '') : null;

  const payload = {
    orderId: String(orderData.order_id),
    platform: 'OwnPlatform',
    paymentMethod: orderData.payment_method || 'pix',
    status: normalizedStatus,
    createdAt,
    approvedDate,
    refundedAt,
    customer: {
      name: custName,
      email: custEmail,
      phone: custPhone,
      document: custDoc,
      country: 'BR',
      ip: cust.ip || null
    },
    products: [
      {
        id: String((orderData.product && orderData.product.id) || '1'),
        name: (orderData.product && orderData.product.name) || 'Produto',
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: amount
      }
    ],
    trackingParameters: trackingParams,
    commission: {
      totalPriceInCents: amount,
      gatewayFeeInCents: gatewayFee,
      userCommissionInCents: commissionVal,
      currency: 'BRL'
    },
    isTest: false
  };

  const res = await fetch(utmifyApiUrl, {
    method: 'POST',
    headers: {
      'x-api-token': utmifyToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch {
    decoded = text;
  }

  if (res.ok) {
    return { success: true, http_code: res.status, response: decoded };
  }
  console.error('[Utmify] Erro', res.status, text);
  return { success: false, http_code: res.status, error: text };
}

/** Payload já no formato da API (ex.: recarga no index.html) */
export async function sendUtmifyRawPayload(payload, env) {
  const utmifyApiUrl = env.UTMIFY_API_URL || 'https://api.utmify.com.br/api-credentials/orders';
  const utmifyToken = env.UTMIFY_API_TOKEN || '';
  if (!utmifyToken) {
    return { success: false, error: 'Missing API Token' };
  }
  const res = await fetch(utmifyApiUrl, {
    method: 'POST',
    headers: {
      'x-api-token': utmifyToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch {
    decoded = text;
  }
  if (res.ok) return { success: true, response: decoded };
  return { success: false, http_code: res.status, error: text };
}
