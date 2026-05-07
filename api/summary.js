export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    month,
    monthKey,
    today,
    daysInMonth,
    dayOfMonth,
    daysLeft,
    monthProgress,
    isCurrentMonth,
    salaryArrived,
    grandTotal,
    tcfTarget,
    categoryLines, // pre-calculated by frontend: [{ cat, spent, target, projection, projectionType, status }]
  } = req.body;

  // Build the category analysis block
  const catBlock = categoryLines
    .filter(c => c.spent > 0 || c.target > 0)
    .map(c => {
      const typeLabel = c.projectionType === 'FIXED'     ? '(fijo — ya cobró)'
                      : c.projectionType === 'ONEOFF'    ? '(one-off — sin extrapolación)'
                      : c.projectionType === 'HISTORICAL'? '(basado en historial)'
                      :                                    '(proyección lineal)';
      const projLine = isCurrentMonth && c.projection !== null
        ? ` → proyección cierre: €${c.projection} ${typeLabel}`
        : '';
      const statusNote = c.status === 'OVER'    ? ' ⚠️ PASADO'
                       : c.status === 'AT_RISK'  ? ' ⚡ EN RIESGO'
                       : c.status === 'ON_TRACK' ? ' ✓'
                       : '';
      return `- ${c.cat}: €${c.spent} de €${c.target}${projLine}${statusNote}`;
    }).join('\n');

  const prompt = `Eres el asistente financiero de Chris y Meli, pareja peruana en Berlín.
Analiza su mes ${month} con los datos reales y proyecciones inteligentes.

CONTEXTO TEMPORAL:
- Hoy: ${today} — día ${dayOfMonth} de ${daysInMonth}
- ${isCurrentMonth ? `Quedan ${daysLeft} días (${100 - monthProgress}% del mes)` : 'Mes cerrado (100% completado)'}
- Sueldo DH: ${salaryArrived ? 'ya llegó' : 'aún no llega (usando estimado €5,136)'}

NETO DEL MES:
- Actual: €${Math.round(grandTotal)} vs target €${tcfTarget}

CATEGORÍAS CON PROYECCIONES:
${catBlock}

NOTA SOBRE PROYECCIONES:
- FIXED = gasto único ya cobrado (BVG, renta, seguros) — no va a crecer
- HISTORICAL = proyectado con promedio de meses anteriores — más confiable
- ONE-OFF = gasto puntual (viaje, ropa) × 1.2 buffer — no se repite
- Lineal = proyección simple por días restantes

INSTRUCCIONES:
- 3-4 oraciones en español, tono casual y directo
- Razona sobre el ritmo REAL considerando los tipos de proyección
- No alarmes por gastos FIXED que ya se pagaron y no van a crecer
- Si una categoria esta en cero aun no es posible razonar sobre esa categoria aun, por lo tanto podrias remarcarlo o dejarlo sin comentar.
- Destaca 1-2 categorías que genuinamente merezcan atención
- ${isCurrentMonth ? `Con ${daysLeft} días restantes, da 1 recomendación específica y accionable` : 'Mes cerrado — 1 cosa concreta para el próximo mes'}
- Prosa fluida, sin bullet points, sin saludos`;

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
    return res.status(200).json({ summary: data.content?.[0]?.text || '' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
