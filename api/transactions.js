const { BigQuery } = require('@google-cloud/bigquery');

const bigquery = new BigQuery({
  projectId: process.env.GCP_PROJECT_ID,
  credentials: JSON.parse(process.env.GCP_CREDENTIALS),
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const query = `
    SELECT 
      Fecha,
      CARD,
      Categoría,
      Comercio,
      eur_amount,
      month
    FROM \`${process.env.BQ_DATASET}.transactions\`
    WHERE month = FORMAT_DATE('%m/%Y', DATE_SUB(CURRENT_DATE(), INTERVAL 0 MONTH))
    ORDER BY Fecha DESC
  `;

  try {
    const [rows] = await bigquery.query(query);
    res.status(200).json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
