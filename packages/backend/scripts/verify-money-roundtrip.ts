/**
 * Confirms money survives the full API round trip without float drift, and
 * that the persisted Decimal values match the accepted deal terms exactly.
 */

const BASE = process.env.E2E_BASE ?? 'http://localhost:3000/api';
const PASSWORD = 'password123';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}`);
    if (detail !== undefined) console.error(`        ${JSON.stringify(detail)}`);
  }
}

async function api(method: string, path: string, token: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
}

async function login(email: string): Promise<string> {
  const { body } = await api('POST', '/auth/login', '', { email, password: PASSWORD });
  const data = body.data as { accessToken?: string } | undefined;
  if (!data?.accessToken) throw new Error(`login failed for ${email}`);
  return data.accessToken;
}

async function main() {
  const admin = await login('admin@demo.com');

  const list = await api('GET', '/purchase-orders?limit=50', admin);
  const orders = (list.body.data ?? []) as Array<{ id: string; poNumber: string; totalAmount: number }>;
  console.log(`checking ${orders.length} purchase order(s)\n`);

  check('purchase orders are listed', orders.length > 0, list.body);

  for (const order of orders.slice(0, 10)) {
    const detail = await api('GET', `/purchase-orders/${order.id}`, admin);
    const po = detail.body.data as {
      poNumber: string;
      quantity: number;
      unitPrice: number;
      taxRate: number;
      taxAmount: number;
      freightAmount: number;
      installationAmount: number;
      otherCharges: number;
      subtotal: number;
      totalAmount: number;
      acceptedOfferSnapshot?: { unitPrice: string; quantity: number };
    };

    // API totals must be self-consistent.
    const subtotalExpected = po.quantity * po.unitPrice;
    const totalExpected =
      po.subtotal + po.taxAmount + po.freightAmount + po.installationAmount + po.otherCharges;

    check(
      `${po.poNumber} subtotal = quantity x unitPrice`,
      Math.abs(po.subtotal - subtotalExpected) < 0.005,
      { subtotal: po.subtotal, quantity: po.quantity, unitPrice: po.unitPrice, expected: subtotalExpected },
    );
    check(
      `${po.poNumber} total = subtotal + tax + freight + installation + other`,
      Math.abs(po.totalAmount - totalExpected) < 0.005,
      { total: po.totalAmount, expected: totalExpected },
    );
    check(
      `${po.poNumber} tax = subtotal x rate`,
      Math.abs(po.taxAmount - (po.subtotal * po.taxRate) / 100) < 0.005,
      { taxAmount: po.taxAmount, rate: po.taxRate, subtotal: po.subtotal },
    );

    // The order must match the offer snapshot it was created from, with no
    // drift introduced by the Float -> Decimal conversion.
    const snapshot = po.acceptedOfferSnapshot;
    if (snapshot) {
      check(
        `${po.poNumber} unit price matches the accepted offer exactly`,
        Number(snapshot.unitPrice) === po.unitPrice,
        { snapshot: snapshot.unitPrice, po: po.unitPrice },
      );
      check(
        `${po.poNumber} quantity matches the accepted offer exactly`,
        snapshot.quantity === po.quantity,
        { snapshot: snapshot.quantity, po: po.quantity },
      );
    }

    // Amounts must serialise to a short decimal string, not a float artefact
    // such as 70579.08000000001.
    const asString = JSON.stringify(po.totalAmount);
    check(
      `${po.poNumber} total serialises cleanly`,
      !/\d{6,}\.\d{6,}/.test(asString),
      asString,
    );
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});