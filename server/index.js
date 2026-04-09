import "dotenv/config";
import express from "express";
import cors from "cors";
import pathMod from "path";
import { fileURLToPath } from "url";
import {
  insertPedido,
  updatePedidoStatus,
  getPedidoByTransactionId,
  getPedidoByTransactionOrExternal
} from "./lib/db.js";
import {
  createPixCharge,
  fetchPromisseTransaction,
  mapPromisseStatusToInternal
} from "./lib/promissePayment.js";
import { sendUtmifyEvent, sendUtmifyRawPayload } from "./lib/utmify.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathMod.dirname(__filename);

const env = process.env;
const PORT = Number(env.PORT || 3000);
const PUBLIC_BASE_URL = (env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SERVE_STATIC = env.SERVE_STATIC === "1" || env.SERVE_STATIC === "true";

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

function rowToOrderData(row) {
  let utm = row.utm_params;
  if (typeof utm === 'string') {
    try {
      utm = JSON.parse(utm);
    } catch {
      utm = {};
    }
  }
  return {
    order_id: row.transaction_id,
    amount: row.valor,
    gateway_fee: 0,
    created_at: row.created_at,
    customer: {
      name: row.nome,
      email: row.email,
      document: row.cpf,
      ip: null
    },
    product: { name: "Gift Card Roblox", id: "ultrarobux" },
    utm_params: utm
  };
}

async function handleCreatePix(req, res) {
  let body = req.body;
  if (!body || typeof body !== "object") body = {};

  try {
    const created = await createPixCharge({
      req,
      input: body,
      publicBaseUrl: PUBLIC_BASE_URL,
      env
    });

    const createdAt = new Date().toISOString().replace("T", " ").substring(0, 19);
    await insertPedido({
      transaction_id: created.paymentCode,
      external_code: created.externalCode,
      status: "waiting_payment",
      valor: created.amount,
      nome: created.customerName,
      email: created.customerEmail,
      cpf: created.customerCpf,
      utm_params: JSON.stringify(created.utms),
      created_at: createdAt
    });

    const orderData = {
      order_id: created.paymentCode,
      amount: created.amount,
      gateway_fee: 0,
      customer: {
        name: created.customerName,
        email: created.customerEmail,
        document: created.customerCpf,
        phone: "11999999999",
        ip: req.headers["x-forwarded-for"]?.split?.(",")[0] || req.socket?.remoteAddress
      },
      product: { name: "Gift Card Roblox", id: "ultrarobux" },
      utm_params: created.utms
    };

    try {
      await sendUtmifyEvent(orderData, "initiate_checkout", env);
      await sendUtmifyEvent(orderData, "waiting_payment", env);
    } catch (e) {
      console.error("[Utmify] create flow:", e);
    }

    const raw = created.raw;
    res.json({
      status: 200,
      body: {
        payment_code: created.paymentCode,
        pix_qrcode: created.pixQrCode,
        pix_qrcode_text: created.pixQrText,
        external_code: created.externalCode,
        generated_customer: {
          name: created.customerName,
          email: created.customerEmail,
          document: created.customerCpf,
          phone: "11999999999"
        },
        utms: created.utms,
        raw_mangofy: raw
      }
    });
  } catch (e) {
    console.error("[create_pix]", e);
    res.status(500).json({ status: 500, error: e.message || String(e) });
  }
}

async function handleCheckStatus(req, res) {
  const tid = req.query.id;
  if (!tid) {
    return res.json({ status: "error", message: "Missing ID" });
  }
  try {
    let row = await getPedidoByTransactionId(tid);
    if (env.PROMISSE_SECRET_KEY) {
      try {
        const live = await fetchPromisseTransaction(tid, env);
        if (live) {
          const raw =
            live.status ??
            live.payment_status ??
            live.state ??
            live.paymentStatus;
          const internal = mapPromisseStatusToInternal(raw);
          if (internal && row) {
            await updatePedidoStatus(
              tid,
              internal,
              new Date().toISOString().replace("T", " ").substring(0, 19)
            );
            row = await getPedidoByTransactionId(tid);
          } else if (internal && !row) {
            row = {
              transaction_id: tid,
              status: internal,
              valor: Number(live.amount || 0)
            };
          }
        }
      } catch (e) {
        console.warn("[check_status] consulta Promisse:", e.message);
      }
    }

    if (!row) {
      return res.json({ status: "error", message: "Not Found" });
    }
    const statusMap = {
      waiting_payment: "pending",
      pending: "pending",
      approved: "paid",
      paid: "paid",
      refunded: "refunded",
      error: "refused"
    };
    const mapped = statusMap[row.status] ?? row.status;
    return res.json({
      status: "success",
      payment_status: mapped,
      raw_status: row.status,
      body: {
        data: {
          payment_status: mapped,
          status: row.status
        }
      }
    });
  } catch (e) {
    return res.json({ status: "error", message: e.message });
  }
}

async function handleSendUtmifyPurchase(req, res) {
  const input = req.body || {};
  try {
    const id = input.order_id || input.orderId;
    const row = id ? await getPedidoByTransactionOrExternal(id) : null;

    let orderData;
    if (row) {
      orderData = rowToOrderData(row);
    } else {
      orderData = {
        order_id: id,
        amount: Number(input.amount || 0),
        gateway_fee: 0,
        created_at: new Date().toISOString().replace("T", " ").substring(0, 19),
        customer: input.customer || {},
        product: { name: "Gift Card Roblox", id: "ultrarobux" },
        utm_params: input.utms || input.trackingParameters || {}
      };
    }

    const result = await sendUtmifyEvent(orderData, "paid", env);
    if (result.success) {
      res.json({ success: true, utmify_status: result.http_code });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (e) {
    console.error("[send_utmify_purchase]", e);
    res.status(500).json({ success: false, error: e.message });
  }
}

async function handleTrackUtmify(req, res) {
  const payload = req.body?.payload;
  if (!payload) {
    return res.status(400).json({ success: false, error: "Missing payload" });
  }
  const result = await sendUtmifyRawPayload(payload, env);
  if (result.success) res.json(result);
  else res.status(500).json(result);
}

async function handleWebhook(req, res) {
  const event = req.body;
  if (!event || typeof event !== 'object') {
    return res.status(400).send("invalid");
  }

  const paymentId =
    event.payment_code || event.data?.payment_code || event.data?.id || event.transaction_id || event.id;
  const status =
    event.payment_status || event.status || event.data?.status || event.data?.payment_status;

  if (!paymentId || !status) {
    console.warn("[Webhook] payload incompleto", JSON.stringify(event).slice(0, 500));
    return res.status(400).json({ ok: false });
  }

  console.log("[Webhook]", paymentId, status);

  try {
    const updatedAt = new Date().toISOString().replace("T", " ").substring(0, 19);
    await updatePedidoStatus(paymentId, status, updatedAt);

    const paid = status === "paid" || status === "approved" || status === "authorized";
    if (paid) {
      const row = await getPedidoByTransactionId(paymentId);
      if (row) {
        const orderData = rowToOrderData(row);
        const r = await sendUtmifyEvent(orderData, "paid", env);
        if (!r.success) console.error("[Webhook] Utmify falhou", r);
      }
    }

    res.json({ success: true });
  } catch (e) {
    console.error("[Webhook]", e);
    res.status(500).json({ error: e.message });
  }
}

function apiPhpRouter(req, res) {
  const action = req.query.action || '';
  if (req.method === 'GET' && action === 'check_status') {
    return handleCheckStatus(req, res);
  }
  if (req.method === 'POST') {
    if (action === 'create_pix') return handleCreatePix(req, res);
    if (action === 'send_utmify_purchase') return handleSendUtmifyPurchase(req, res);
    if (action === 'track_utmify') return handleTrackUtmify(req, res);
  }
  return res.status(400).json({ error: "Invalid Action", action });
}

app.get("/api.php", apiPhpRouter);
app.post("/api.php", apiPhpRouter);

// Rotas Node-first (sem PHP de verdade)
app.post("/api/pix/create", handleCreatePix);
app.get("/api/pix/status", handleCheckStatus);
app.post("/api/utmify/purchase", handleSendUtmifyPurchase);
app.post("/api/utmify/track", handleTrackUtmify);

app.post("/api/webhook", handleWebhook);
app.post("/api/webhook.php", handleWebhook);

app.get("/health", (_req, res) => res.json({ ok: true }));

if (SERVE_STATIC) {
  const root = pathMod.join(__dirname, "..");
  app.use(express.static(root));
  app.get("/", (_req, res) => {
    res.sendFile(pathMod.join(root, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Payment API em http://localhost:${PORT} (PUBLIC_BASE_URL=${PUBLIC_BASE_URL})`);
  if (SERVE_STATIC) console.log("Servindo arquivos estáticos da pasta pai.");
});