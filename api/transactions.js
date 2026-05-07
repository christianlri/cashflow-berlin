const { BigQuery } = require('@google-cloud/bigquery');

const bigquery = new BigQuery({
  projectId: process.env.GCP_PROJECT_ID,
  credentials: JSON.parse(process.env.GCP_CREDENTIALS),
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const query = `
    SELECT 
      date,
      card,
      category,
      subcategory,
      city,
      commerce,
      original_amount,
      currency_original_amount,
      pen_amount,
      usd_amount,
      eur_amount,
      month,
      week,
      finance_class,
      finance_category
    FROM \`spark-datahub.cashflow.data_bank_native\`
    WHERE DATE_TRUNC(date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH)
    ORDER BY date DESC
  `;

  try {
    const [rows] = await bigquery.query(query);
    res.status(200).json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
