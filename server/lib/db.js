import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'data', 'pedidos.json');

function ensureFile() {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ pedidos: [] }, null, 2), 'utf8');
  }
}

function load() {
  ensureFile();
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function save(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export async function insertPedido(row) {
  const data = load();
  data.pedidos.push({
    transaction_id: row.transaction_id,
    external_code: row.external_code,
    status: row.status,
    valor: row.valor,
    nome: row.nome,
    email: row.email,
    cpf: row.cpf,
    utm_params: row.utm_params,
    created_at: row.created_at,
    updated_at: row.updated_at || null
  });
  save(data);
}

export async function updatePedidoStatus(transactionId, status, updatedAt) {
  const data = load();
  const p = data.pedidos.find((x) => x.transaction_id === transactionId);
  if (p) {
    p.status = status;
    p.updated_at = updatedAt;
    save(data);
  }
}

export async function getPedidoByTransactionId(tid) {
  const data = load();
  return data.pedidos.find((x) => x.transaction_id === tid) || null;
}

export async function getPedidoByTransactionOrExternal(tid) {
  const data = load();
  return data.pedidos.find((x) => x.transaction_id === tid || x.external_code === tid) || null;
}
