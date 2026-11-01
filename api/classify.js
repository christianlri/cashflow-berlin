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

// ── PENDIENTE vs LIQUIDADO ───────────────────────────────────────────────────
// Interbank muestra un cargo primero "en proceso" en S/ (nombre recortado) y
// luego liquidado en US$ (nombre completo). Es la misma compra si coinciden
// tarjeta, fecha y primera palabra del comercio, cambia la moneda y los montos
// en EUR difieren menos de 15%.
function normCurrency(c) {
  const x = (c || 'eur').toLowerCase();
  return x === 'soles' ? 'pen' : x;
}

function isPendingPair(a, b) {
  const ca = normCurrency(a.currency), cb = normCurrency(b.currency);
  if (ca === cb || ![ca, cb].includes('usd') || ![ca, cb].includes('pen')) return false;
  if (a.date !== b.date || a.card !== b.card) return false;
  const w1 = s => (s || '').toLowerCase().trim().split(/\s+/)[0];
  if (!w1(a.commerce) || w1(a.commerce) !== w1(b.commerce)) return false;
  const ea = Math.abs(parseFloat(a.eur_amount)), eb = Math.abs(parseFloat(b.eur_amount));
  if (!ea || !eb) return false;
  return Math.min(ea, eb) / Math.max(ea, eb) >= 0.85;
}

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
        SELECT id, FORMAT_DATE('%Y-%m-%d', date) AS date_str, card, commerce, original_amount,
               currency_original_amount, eur_amount
        FROM \`spark-datahub.cashflow.data_bank_native\`
        WHERE date IN (${dateFilter})
          AND card IN (${cardFilter})
      `);

      const existingKeys = new Set(
        existingRows.map(r => `${r.date_str}|${r.card}|${r.commerce}|${r.original_amount}`)
      );
      const existing = existingRows.map(r => ({
        id: r.id, date: r.date_str, card: r.card, commerce: r.commerce,
        currency: r.currency_original_amount, eur_amount: r.eur_amount, used: false,
      }));

      const newRows     = [];
      const skippedRows = [];
      const toReplace   = []; // US$ liquidado que reemplaza un S/ pendiente ya cargado
      const skip = (r, reason) => skippedRows.push({ date: r.date, commerce: r.commerce, original_amount: r.original_amount, currency: r.currency, reason });

      // Primero los US$, para que un S/ pendiente del mismo batch encuentre su par
      const ordered = [...rows].sort((a, b) =>
        (normCurrency(a.currency) === 'usd' ? 0 : 1) - (normCurrency(b.currency) === 'usd' ? 0 : 1));

      for (const r of ordered) {
        if (r.category === 'Finance') { skip(r, 'finance'); continue; }
        const key = `${r.date}|${r.card}|${r.commerce}|${r.original_amount}`;
        if (existingKeys.has(key)) { skip(r, 'exists'); continue; }

        const ex = existing.find(e => !e.used && e.id && isPendingPair(r, e));
        if (ex) {
          ex.used = true;
          if (normCurrency(r.currency) === 'usd') toReplace.push({ row: r, id: ex.id, old: ex });
          else skip(r, 'pending_dup');
          continue;
        }
        const inBatch = newRows.find(n => !n._paired && isPendingPair(r, n));
        if (inBatch) { inBatch._paired = true; skip(r, 'pending_dup'); continue; }

        newRows.push(r);
      }

      // Borra los pendientes que se reemplazan. Las filas que siguen en el
      // streaming buffer de BigQuery (cargadas hace minutos) no se pueden borrar:
      // en ese caso se conserva el pendiente y se omite el liquidado.
      let replacedRows = [];
      if (toReplace.length) {
        try {
          const ids = toReplace.map(t => `'${String(t.id).replace(/'/g, "''")}'`).join(', ');
          await bigquery.query(`DELETE FROM \`spark-datahub.cashflow.data_bank_native\` WHERE id IN (${ids})`);
          replacedRows = toReplace.map(t => ({ date: t.row.date, commerce: t.row.commerce, replaced: t.old.commerce }));
          newRows.push(...toReplace.map(t => t.row));
        } catch (e) {
          toReplace.forEach(t => skip(t.row, 'pending_locked'));
        }
      }

      if (!newRows.length) {
        return res.status(200).json({ inserted: 0, skipped: skippedRows.length, skippedRows, replaced: replacedRows.length, replacedRows });
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
        replaced: replacedRows.length,
        replacedRows,
        ...(unmapped.length ? { warnings: [`Categorías sin mapeo, cargadas como Extra & One-Offs: ${unmapped.join(', ')}`] } : {}),
      });
    } catch (e) {
      return res.status(500).json({ error: e.message, details: e.errors });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
