export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    month,           // e.g. "May 26"
    monthKey,        // e.g. "2026-05"
    today,           // e.g. "2026-05-07"
    lastTransactionDate, // last date with a transaction in this month
    categorySpend,
    targets,
    grandTotal,
    tcfTarget,
    salaryArrived,
  } = req.body;

  // ── TIME CONTEXT ──────────────────────────────────────────────────────────
  const todayDate     = new Date(today);
  const [y, m]        = monthKey.split('-').map(Number);
  const daysInMonth   = new Date(y, m, 0).getDate();
  const dayOfMonth    = todayDate.getDate();
  const isCurrentMonth = todayDate.getFullYear() === y && (todayDate.getMonth() + 1) === m;
  const monthProgress = isCurrentMonth
    ? Math.round((dayOfMonth / daysInMonth) * 100)
    : 100; // past month = 100% complete
  const daysLeft = isCurrentMonth ? daysInMonth - dayOfMonth : 0;

  // ── CATEGORY ANALYSIS ─────────────────────────────────────────────────────
  const focusCategories = ['Groceries', 'Delivery', 'Clothing', 'Health', 'Transport', 'Food', 'Subscription', 'Trip'];

  const catLines = focusCategories.map(cat => {
    const spent  = Math.round(categorySpend[cat] || 0);
    const target = Math.abs(targets[cat] || 0);
    if (spent === 0 && target === 0) return null;

    const pctOfTarget  = target > 0 ? Math.round((spent / target) * 100) : null;
    const pctOfMonth   = monthProgress;
    let pace = '';

    if (target > 0 && isCurrentMonth && monthProgress > 5) {
      const projectedSpend = Math.round((spent / monthProgress) * 100);
      const projectedPct   = Math.round((projectedSpend / target) * 100);
      pace = ` → proyección al cierre: €${projectedSpend} (${projectedPct}% del target)`;
    }

    return `- ${cat}: €${spent}${target > 0 ? ` de €${target} (${pctOfTarget}% del target)` : ''}${pace}`;
  }).filter(Boolean).join('\n');

  const totalSpent   = Object.values(categorySpend).reduce((s, v) => s + v, 0);
  const projectedTotal = isCurrentMonth && monthProgress > 5
    ? Math.round((totalSpent / monthProgress) * 100)
    : totalSpent;

  const prompt = `Eres el asistente financiero personal de Chris y Meli, una pareja peruana viviendo en Berlín.
Analiza su situación financiera de ${month} y genera un análisis breve, concreto y útil.

CONTEXTO TEMPORAL:
- Hoy es ${today}
- Mes: ${month} (${daysInMonth} días totales)
- Progreso del mes: ${monthProgress}% (día ${dayOfMonth} de ${daysInMonth}${daysLeft > 0 ? `, quedan ${daysLeft} días` : ' — mes cerrado'})
- Sueldo llegó: ${salaryArrived ? 'sí' : 'no todavía (usando estimado)'}

SITUACIÓN FINANCIERA:
- Neto acumulado: €${Math.round(grandTotal)} (target mensual: €${tcfTarget})
- Total gastado: €${Math.round(totalSpent)}${isCurrentMonth ? ` → proyección al cierre: €${projectedTotal}` : ''}

CATEGORÍAS (solo las relevantes):
${catLines}

INSTRUCCIONES:
- Escribe 3-4 oraciones en español, tono casual como un amigo que sabe de finanzas
- Razona sobre el RITMO: si van a terminar dentro o fuera del target a este paso
- Destaca 1-2 categorías concretas que merezcan atención (bien o mal)
- ${daysLeft > 0 ? `Con ${daysLeft} días restantes, da 1 recomendación específica y accionable` : 'El mes cerró — da 1 cosa concreta para mejorar el siguiente'}
- No uses bullet points, escribe en prosa fluida
- No empieces con saludos ni "Hola"
- Sé directo, no des vueltas`;

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
        max_tokens: 350,
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
