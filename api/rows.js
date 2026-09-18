// /api/rows — explorar, editar y borrar filas de data_bank_native.
//
//   GET    ?from=&to=&card=&category=&q=&limit=   → lista filas
//   PATCH  { id, date, commerce, category, ... }  → edita una fila
//   DELETE { ids: [...] }                         → borra filas
//
// Requiere dos columnas que no estaban en el esquema original:
//
//   ALTER TABLE `spark-datahub.cashflow.data_bank_native` ADD COLUMN id STRING;
//   UPDATE `spark-datahub.cashflow.data_bank_native` SET id = GENERATE_UUID() WHERE id IS NULL;
//   ALTER TABLE `spark-datahub.cashflow.data_bank_native` ADD COLUMN loaded_at TIMESTAMP;
//
// Sin `id` no hay forma de apuntar a una fila concreta: dos gastos idénticos del
// mismo día son indistinguibles y un DELETE se llevaría los dos.
//
// OJO: este endpoint NO tiene autenticación, igual que el resto de /api. Cualquiera
// con la URL puede borrar filas. Decisión consciente por ahora; si el proyecto deja
// de ser personal, lo primero a agregar es un token.

const { BigQuery } = require('@google-cloud/bigquery');
const { mappingFor, computeAmounts, ALL_CATEGORIES } = require('../lib/categories');
const { getMonth, getWeek } = require('../lib/dates');

const bigquery = new BigQuery({
  projectId: process.env.GCP_PROJECT_ID,
  credentials: JSON.parse(process.env.GCP_CREDENTIALS),
});

const TABLE = '`spark-datahub.cashflow.data_bank_native`';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMIT = 2000;

// Columnas que la UI puede tocar. El resto (month, week, pen/usd, finance_*) se
// recalcula en el servidor para que no se pueda dejar la fila inconsistente.
const EDITABLE = ['date', 'card', 'category', 'subcategory', 'city', 'commerce', 'original_amount', 'currency_original_amount', 'eur_amount'];

const SELECT_COLS = `
  id,
  FORMAT_DATE('%Y-%m-%d', date) AS date,
  card, category, subcategory, city, commerce,
  original_amount, currency_original_amount,
  pen_amount, usd_amount, eur_amount,
  FORMAT_DATE('%Y-%m-%d', month) AS month,
  week, finance_class, finance_category,
  loaded_at`;

// BigQuery devuelve "Unrecognized name: id" si falta el ALTER. Sin esto el error
// llega como un 500 opaco y no se entiende qué falta.
function friendlyError(e) {
  const msg = e?.message || String(e);
  for (const col of ['id', 'loaded_at']) {
    if (new RegExp(`Unrecognized name: ${col}\\b`).test(msg)) {
      return `Falta la columna \`${col}\` en BigQuery. Corré:\n\nALTER TABLE ${TABLE} ADD COLUMN ${col} ${col === 'id' ? 'STRING' : 'TIMESTAMP'};` +
             (col === 'id' ? `\nUPDATE ${TABLE} SET id = GENERATE_UUID() WHERE id IS NULL;` : '');
    }
  }
  if (/streaming buffer/i.test(msg)) {
    return 'Esas filas todavía están en el streaming buffer de BigQuery y no se pueden editar ni borrar hasta ~30-90 min después de cargarlas. Esperá y reintentá.';
  }
  return msg;
}

async function listRows(req, res) {
  const { from, to, card, category, q } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, MAX_LIMIT);

  const where  = [];
  const params = { limit };
  const types  = { limit: 'INT64' };

  for (const [key, value] of [['from', from], ['to', to]]) {
    if (!value) continue;
    if (!DATE_RE.test(value)) return res.status(400).json({ error: `Fecha inválida en "${key}": ${value} (se espera YYYY-MM-DD)` });
    where.push(`date ${key === 'from' ? '>=' : '<='} PARSE_DATE('%Y-%m-%d', @${key})`);
    params[key] = value;
    types[key]  = 'STRING';
  }
  if (card)     { where.push('card = @card');         params.card = card;         types.card = 'STRING'; }
  if (category) { where.push('category = @category'); params.category = category; types.category = 'STRING'; }
  if (q) {
    where.push('LOWER(commerce) LIKE CONCAT("%", LOWER(@q), "%")');
    params.q = q;
    types.q  = 'STRING';
  }

  const query = `
    SELECT ${SELECT_COLS}
    FROM ${TABLE}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY date DESC, commerce
    LIMIT @limit`;

  const [rows] = await bigquery.query({ query, params, types });
  return res.status(200).json({
    rows: rows.map(r => ({ ...r, loaded_at: r.loaded_at?.value ?? r.loaded_at ?? null })),
    truncated: rows.length === limit,
    categories: ALL_CATEGORIES,
  });
}

async function updateRow(req, res) {
  const body = req.body || {};
  const id   = body.id;
  if (!id) return res.status(400).json({ error: 'Falta el id de la fila' });

  const changes = {};
  for (const col of EDITABLE) {
    if (body[col] !== undefined) changes[col] = body[col];
  }
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'No hay campos para actualizar' });

  // La fila actual es la base: si solo se edita el comercio, los montos y la fecha
  // que se reescriben tienen que ser los que ya estaban.
  const [current] = await bigquery.query({
    query: `SELECT ${SELECT_COLS} FROM ${TABLE} WHERE id = @id LIMIT 1`,
    params: { id }, types: { id: 'STRING' },
  });
  if (!current.length) return res.status(404).json({ error: `No existe una fila con id ${id}` });

  const merged = { ...current[0], ...changes };

  if (!DATE_RE.test(String(merged.date))) {
    return res.status(400).json({ error: `Fecha inválida: ${merged.date} (se espera YYYY-MM-DD)` });
  }
  if (!String(merged.commerce || '').trim()) {
    return res.status(400).json({ error: 'El comercio no puede quedar vacío' });
  }

  const mapping = mappingFor(merged.category);
  const amounts = computeAmounts(merged.eur_amount, merged.currency_original_amount, merged.original_amount);

  const params = {
    id,
    date:             merged.date,
    card:             merged.card,
    category:         merged.category,
    subcategory:      merged.subcategory ?? null,
    city:             merged.city ?? null,
    commerce:         merged.commerce,
    original_amount:  amounts.original_amount,
    currency:         amounts.currency_original_amount,
    pen_amount:       amounts.pen_amount,
    usd_amount:       amounts.usd_amount,
    eur_amount:       amounts.eur_amount,
    month:            getMonth(merged.date),
    week:             getWeek(merged.date),
    finance_class:    mapping.finance_class,
    finance_category: mapping.finance_category,
  };
  const types = {
    id: 'STRING', date: 'STRING', card: 'STRING', category: 'STRING',
    subcategory: 'STRING', city: 'STRING', commerce: 'STRING',
    original_amount: 'FLOAT64', currency: 'STRING',
    pen_amount: 'FLOAT64', usd_amount: 'FLOAT64', eur_amount: 'FLOAT64',
    month: 'STRING', week: 'STRING', finance_class: 'STRING', finance_category: 'STRING',
  };

  await bigquery.query({
    query: `
      UPDATE ${TABLE} SET
        date = PARSE_DATE('%Y-%m-%d', @date),
        card = @card,
        category = @category,
        subcategory = @subcategory,
        city = @city,
        commerce = @commerce,
        original_amount = @original_amount,
        currency_original_amount = @currency,
        pen_amount = @pen_amount,
        usd_amount = @usd_amount,
        eur_amount = @eur_amount,
        month = PARSE_DATE('%Y-%m-%d', @month),
        week = @week,
        finance_class = @finance_class,
        finance_category = @finance_category
      WHERE id = @id`,
    params, types,
  });

  const [updated] = await bigquery.query({
    query: `SELECT ${SELECT_COLS} FROM ${TABLE} WHERE id = @id LIMIT 1`,
    params: { id }, types: { id: 'STRING' },
  });
  return res.status(200).json({ row: updated[0] || null });
}

async function deleteRows(req, res) {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Falta la lista de ids' });
  if (ids.some(id => typeof id !== 'string' || !id)) return res.status(400).json({ error: 'Hay ids inválidos en la lista' });

  const [[before]] = await bigquery.query({
    query: `SELECT COUNT(*) AS n FROM ${TABLE} WHERE id IN UNNEST(@ids)`,
    params: { ids }, types: { ids: ['STRING'] },
  });

  await bigquery.query({
    query: `DELETE FROM ${TABLE} WHERE id IN UNNEST(@ids)`,
    params: { ids }, types: { ids: ['STRING'] },
  });

  return res.status(200).json({ deleted: Number(before?.n || 0), requested: ids.length });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET')    return await listRows(req, res);
    if (req.method === 'PATCH')  return await updateRow(req, res);
    if (req.method === 'DELETE') return await deleteRows(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('/api/rows', e);
    return res.status(500).json({ error: friendlyError(e) });
  }
}
