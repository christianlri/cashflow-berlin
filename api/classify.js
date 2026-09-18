const { BigQuery } = require('@google-cloud/bigquery');
const { randomUUID } = require('crypto');

const bigquery = new BigQuery({
  projectId: process.env.GCP_PROJECT_ID,
  credentials: JSON.parse(process.env.GCP_CREDENTIALS),
});

// ── CATEGORÍAS Y MONTOS ──────────────────────────────────────────────────────
// Fuente de verdad compartida con /api/rows, para no tener dos mapas que se
// desincronicen cuando se agrega una categoría.
const { CATEGORY_MAP, ALL_CATEGORIES, mappingFor, computeAmounts } = require('../lib/categories');

// ── MONTH / WEEK ─────────────────────────────────────────────────────────────
// Antes se calculaban acá con `new Date(dateStr)` (medianoche UTC) leído con
// getters locales: en una TZ con offset negativo el día 1 caía al mes anterior
// (un gasto del 1-Set entraba como agosto). Ahora salen de lib/dates.js, que
// trabaja con strings/UTC y da lo mismo en cualquier zona horaria.
const { getMonth, getWeek } = require('../lib/dates');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET HISTORICAL VENDOR MAP + LAST DATES ──────────────────────────────
  if (req.method === 'GET') {
    try {
      const [[vendorRows], [dateRows]] = await Promise.all([
        bigquery.query(`
          SELECT commerce, category, COUNT(*) as cnt
          FROM \`spark-datahub.cashflow.data_bank_native\`
          WHERE commerce IS NOT NULL AND category IS NOT NULL
          GROUP BY commerce, category
          ORDER BY cnt DESC
        `),
        bigquery.query(`
          SELECT card, MAX(date) as last_date
          FROM \`spark-datahub.cashflow.data_bank_native\`
          WHERE card IN ('N26', 'N26 Family')
          GROUP BY card
        `),
      ]);

      const vendorMap = {};
      vendorRows.forEach(r => {
        if (!vendorMap[r.commerce]) vendorMap[r.commerce] = r.category;
      });

      const lastDates = {};
      dateRows.forEach(r => {
        lastDates[r.card] = r.last_date?.value || r.last_date;
      });

      return res.status(200).json({ vendorMap, lastDates, categories: ALL_CATEGORIES });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: INSERT APPROVED ROWS ───────────────────────────────────────────
  if (req.method === 'POST') {
    const { rows } = req.body;
    if (!rows || !rows.length) return res.status(400).json({ error: 'No rows' });

    // Una fecha inválida se convertía en month/week basura y la fila terminaba en
    // el mes equivocado (y encima se interpola cruda en el SQL del dedup).
    const badDates = rows.filter(r => !getMonth(r.date));
    if (badDates.length) {
      return res.status(400).json({
        error: `Fechas inválidas (formato esperado YYYY-MM-DD): ${badDates.map(r => `${r.commerce} → ${r.date}`).join(', ')}`,
      });
    }

    try {
      const dataset = bigquery.dataset('cashflow');
      const table = dataset.table('data_bank_native');

      // Dedup against existing BQ rows (same date + card + commerce + amount)
      const dates = [...new Set(rows.map(r => r.date))];
      const cards = [...new Set(rows.map(r => r.card))];
      const dateFilter = dates.map(d => `DATE '${d}'`).join(', ');
      const cardFilter = cards.map(c => `'${c.replace(/'/g, "''")}'`).join(', ');

      const [existingRows] = await bigquery.query(`
        SELECT FORMAT_DATE('%Y-%m-%d', date) AS date_str, card, commerce, original_amount
        FROM \`spark-datahub.cashflow.data_bank_native\`
        WHERE date IN (${dateFilter})
          AND card IN (${cardFilter})
      `);

      const existingKeys = new Set(
        existingRows.map(r => `${r.date_str}|${r.card}|${r.commerce}|${r.original_amount}`)
      );

      const newRows     = [];
      const skippedRows = [];
      for (const r of rows) {
        if (r.category === 'Finance') {
          skippedRows.push({ date: r.date, commerce: r.commerce, original_amount: r.original_amount, currency: r.currency, reason: 'finance' });
          continue;
        }
        const key = `${r.date}|${r.card}|${r.commerce}|${r.original_amount}`;
        if (existingKeys.has(key)) skippedRows.push({ date: r.date, commerce: r.commerce, original_amount: r.original_amount, currency: r.currency });
        else newRows.push(r);
      }

      if (!newRows.length) {
        return res.status(200).json({ inserted: 0, skipped: skippedRows.length, skippedRows });
      }

      const unmapped = [...new Set(newRows.map(r => r.category).filter(c => !CATEGORY_MAP[c]))];

      const loadedAt = new Date().toISOString();

      const toInsert = newRows.map(r => {
        const mapping = mappingFor(r.category);
        const amounts = computeAmounts(r.eur_amount, r.currency, r.original_amount);
        return {
          // Clave primaria propia: BigQuery no tiene uno, y sin esto /api/rows no
          // puede apuntar a una fila concreta para editarla o borrarla.
          id: randomUUID(),
          date: r.date,
          card: r.card,
          category: r.category,
          subcategory: null,
          city: null,
          commerce: r.commerce,
          original_amount: amounts.original_amount,
          currency_original_amount: amounts.currency_original_amount,
          pen_amount: amounts.pen_amount,
          usd_amount: amounts.usd_amount,
          eur_amount: amounts.eur_amount,
          month: getMonth(r.date),
          week: getWeek(r.date),
          finance_class: mapping.finance_class,
          finance_category: mapping.finance_category,
          // Momento de la carga, para poder auditar o revertir un batch entero.
          // NULL = fila cargada antes de que existiera esta columna.
          loaded_at: loadedAt,
        };
      });

      await table.insert(toInsert);
      return res.status(200).json({
        inserted: toInsert.length,
        skipped: skippedRows.length,
        skippedRows,
        ...(unmapped.length ? { warnings: [`Categorías sin mapeo, cargadas como Extra & One-Offs: ${unmapped.join(', ')}`] } : {}),
      });
    } catch (e) {
      return res.status(500).json({ error: e.message, details: e.errors });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
