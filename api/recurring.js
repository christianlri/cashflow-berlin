const { BigQuery } = require('@google-cloud/bigquery');

const bigquery = new BigQuery({
  projectId: process.env.GCP_PROJECT_ID,
  credentials: JSON.parse(process.env.GCP_CREDENTIALS),
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const query = `
    SELECT
      FORMAT_DATE('%Y-%m', m.month) AS month,
      m.vendor_id, m.vendor, m.owner, m.kind, m.card, m.status,
      m.expected_day, m.expected_eur, m.n_charges, m.charged_eur, m.charge_days, m.alert,
      r.every_n_months, r.status_since, r.notes, r.bucket
    FROM \`spark-datahub.cashflow.v_recurring_monitor\` m
    JOIN \`spark-datahub.cashflow.recurring_vendors\` r USING (vendor_id)
    WHERE m.month >= DATE_SUB(DATE_TRUNC(CURRENT_DATE(), MONTH), INTERVAL 5 MONTH)
    ORDER BY m.month DESC, m.expected_day, m.vendor
  `;

  try {
    const [rows] = await bigquery.query(query);
    res.status(200).json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
