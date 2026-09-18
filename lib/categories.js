// Mapa de categorías → finance_class / finance_category, compartido por
// api/classify.js (inserciones) y api/rows.js (ediciones).
//
// El README avisa que este mapa estaba duplicado en cuatro sitios. Acá queda la
// fuente de verdad del backend; las copias de las UI (clasificar.html, amex.html)
// siguen existiendo para poblar los <select> sin un fetch extra.

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
  'Entertainment':       { finance_category: '5. True Cash Flow',         finance_class: 'Extra & One-Offs'        },
  'Online Shopping':     { finance_category: '5. True Cash Flow',         finance_class: 'Extra & One-Offs'        },
  'Other':               { finance_category: '5. True Cash Flow',         finance_class: 'Extra & One-Offs'        },
  'Tech':                { finance_category: '5. True Cash Flow',         finance_class: 'Extra & One-Offs'        },
  'Trip':                { finance_category: '5. True Cash Flow',         finance_class: 'Extra & One-Offs'        },
  'Housing':             { finance_category: '3. Vital Surplus',          finance_class: 'Extra & One-Offs'        },
  'Income':              { finance_category: '1. Earnings Net',           finance_class: ''                        },
  'Finance':             { finance_category: 'Not Considered',            finance_class: 'Not Considered'          },
  'Not Considered':      { finance_category: 'Not Considered',            finance_class: 'Not Considered'          },
};

// Fallback para categorías que no estén en el mapa. Antes caía en 'Not Considered',
// lo que sacaba la fila del P&L sin avisar. Ahora cae en el bucket de 'Other'.
const FALLBACK_MAPPING = { finance_category: '5. True Cash Flow', finance_class: 'Extra & One-Offs' };

const ALL_CATEGORIES = Object.keys(CATEGORY_MAP);

function mappingFor(category) {
  return CATEGORY_MAP[category] || FALLBACK_MAPPING;
}

// El EUR es el que manda; PEN y USD se derivan con tipos de cambio aproximados.
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

module.exports = { CATEGORY_MAP, FALLBACK_MAPPING, ALL_CATEGORIES, mappingFor, computeAmounts };
