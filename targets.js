// Config compartida entre /palette y /pl. Un solo sitio donde tocar los targets.
// Se carga como script clásico antes del inline de cada página.
//
// Recalibrados 2026-08-13 contra el gasto real neto de feb-jul 2026.
// Suman 3.695 €/mes; con un ingreso medio de 4.892 € implican ahorrar ~1.197 €/mes.

window.CATEGORY_TARGETS = {
  Rent: -1800, Groceries: -360, Trip: -300, Food: -240,
  Transport: -125, Delivery: -100, Other: -100, Subscription: -100,
  Services: -100, Clothing: -90, Network: -90, Housing: -70,
  Entertainment: -70, 'Online Shopping': -50, Health: -50,
  'Non Food Groceries': -30, Tech: -20,
  Pet: 0, Hair: 0, Parking: 0,
};

window.INCOME_TARGET = 5136;
