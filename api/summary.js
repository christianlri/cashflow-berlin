export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { month, categorySpend, targets, grandTotal, tcfTarget, salaryArrived } = req.body;

  // Build a compact summary for Claude
  const lines = Object.entries(categorySpend)
    .filter(([, spent]) => spent > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, spent]) => {
      const target = Math.abs(targets[cat] || 0);
      const pct    = target > 0 ? Math.round((spent / target) * 100) : null;
      const status = pct === null ? '' : pct > 100 ? ` ⚠️ ${pct}% del target` : ` (${pct}% del target)`;
      return `- ${cat}: €${Math.round(spent)}${target > 0 ? ` / €${target}${status}` : ''}`;
    }).join('\n');

  const prompt = `Eres el asistente financiero personal de Chris y Meli, una pareja peruana viviendo en Berlín. 
Analiza el mes ${month} y genera un resumen breve, directo y útil en español.

Datos del mes:
- Sueldo llegó: ${salaryArrived ? 'sí' : 'no (estimado)'}
- Neto del mes: €${Math.round(grandTotal)} (target: €${tcfTarget})
- Gastos por categoría:
${lines}

Instrucciones:
- Máximo 4-5 oraciones cortas
- Tono casual y directo, como un amigo que sabe de finanzas
- Destaca 2-3 cosas concretas: qué va bien, qué se pasó del target, qué vigilar
- Si el mes ya cerró, sugiere 1 cosa específica para mejorar el siguiente
- No uses bullet points, escribe en prosa
- Menciona específicamente groceries, delivery, clothing, health y transport si tienen datos relevantes
- No empieces con "Hola" ni saludos`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Claude API error');

    const text = data.content?.[0]?.text || '';
    return res.status(200).json({ summary: text });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
