const { BigQuery } = require('@google-cloud/bigquery');

const bigquery = new BigQuery({
  projectId: process.env.GCP_PROJECT_ID,
  credentials: JSON.parse(process.env.GCP_CREDENTIALS),
});

// ── CATEGORY MAPPING (source of truth) ──────────────────────────────────────
const CATEGORY_MAP = {
  'Delivery':            { finance_category: '5. True Cash Flow',         finance_class: 'Expected Cost of Living' },
  'Pet':                 { finance_category: '5. True Cash Flow',         finance_class: 'Expected Cost of Living' },
  'Food':                { finance_category: '4. Quality of Life Margin', finance_class: 'Expected Cost of Living' },
  'Service':             { finance_category: '4. Quality of Life Margin', finance_class: 'Expected Cost of Living' },
  'Services':            { finance_category: '4. Quality of Life Margin', finance_class: 'Expected Cost of Living' },
  'Subscription':        { finance_category: '4. Quality of Life Margin', finance_class: 'Expected Cost of Living' },
  'Groceries':           { finance_category: '3. Vital Surplus',          finance_class: 'Expected Cost of Living' },
  'Health':              { finance_category: '3. Vital Surplus',          finance_class: 'Expected Cost of Living' },
  'Non Food Groceries':  { finance_category: '3. Vital Surplus',          finance_class: 'Expected Cost of Living' },
  'Hair':                { finance_category: '3. Vital Surplus',          finance_class: 'Expected Cost of Living' },
  'Parking':             { finance_category: '3. Vital Surplus',          finance_class: 'Expected Cost of Living' },
  'Transport':           { finance_category: '3. Vital Surplus',          finance_class: 'Expected Cost of Living' },
  'Network':             { finance_category: '2. Foundational Margin',    finance_class: 'Expected Cost of Living' },
  'Rent':                { finance_category: '2. Foundational Margin',    finance_class: 'Expected Rent'           },
  'Clothing':            { finance_category: '5. True Cash Flow',         finance_class: 'Extra & One-Offs'        },
  'Christmas Deco':      { finance_category: '5. True Cash Flow',         finance_class: 'Extra & One-Offs'        },
  'Other':               { finance_category: '5. True Cash Flow',         finance_class: 'Extra & One-Offs'        },
  'Tech':                { finance_category: '5. True Cash Flow',         finance_class: 'Extra & One-Offs'        },
  'Trip':                { finance_category: '5. True Cash Flow',         finance_class: 'Extra & One-Offs'        },
  'Housing':             { finance_category: '3. Vital Surplus',          finance_class: 'Extra & One-Offs'        },
  'Income':              { finance_category: '1. Earnings Net',           finance_class: ''                        },
};

const ALL_CATEGORIES = Object.keys(CATEGORY_MAP);

// ── EUR/USD/PEN CONVERSION (approximate) ────────────────────────────────────
function computeAmounts(eurAmount, currency, originalAmount) {
  const eur = parseFloat(eurAmount) || 0;
  return {
    pen_amount: parseFloat((eur * 4).toFixed(2)),
    usd_amount: parseFloat((eur * 1.08).toFixed(2)),
    eur_amount: eur,
    currency_original_amount: currency || 'eur',
    original_amount: parseFloat(originalAmount) || eur,
  };
}

// ── WEEK LOOKUP ──────────────────────────────────────────────────────────────
function getWeek(dateStr) {
  const d = new Date(dateStr);
  const start = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - start) / 86400000 + start.getDay() + 1) / 7);
  return `Week ${week}`;
}

function getMonth(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
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

      const newRows = rows.filter(r => {
        const key = `${r.date}|${r.card}|${r.commerce}|${r.original_amount}`;
        return !existingKeys.has(key);
      });

      const skipped = rows.length - newRows.length;
      if (!newRows.length) {
        return res.status(200).json({ inserted: 0, skipped });
      }

      const toInsert = newRows.map(r => {
        const mapping = CATEGORY_MAP[r.category] || { finance_category: 'Not Considered', finance_class: 'Not Considered' };
        const amounts = computeAmounts(r.eur_amount, r.currency, r.original_amount);
        return {
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
        };
      });

      await table.insert(toInsert);
      return res.status(200).json({ inserted: toInsert.length, skipped });
    } catch (e) {
      return res.status(500).json({ error: e.message, details: e.errors });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
