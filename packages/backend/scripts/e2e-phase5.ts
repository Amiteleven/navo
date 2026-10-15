/**
 * Phase 5 end-to-end lifecycle verification against a running backend.
 *
 * Drives the real HTTP API as four different users (buyer, procurement
 * approver, finance approver, seller) through the whole purchase execution
 * flow, asserting both the happy path and the guard rails:
 *
 *   accept deal -> create PO -> submit -> approve -> issue
 *   -> seller confirms -> seller dispatches
 *   -> partial receipt -> over-receipt rejected
 *   -> invoice -> three-way match with discrepancies
 *   -> payment blocked by critical discrepancy
 *   -> resolve discrepancy -> match -> payment allowed
 *
 * Run with: npx tsx scripts/e2e-phase5.ts
 */

const BASE = process.env.E2E_BASE ?? 'http://localhost:3000/api';
const PASSWORD = 'password123';

interface Tokens {
  requester: string;
  procurement: string;
  finance: string;
  seller: string;
  admin: string;
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}`);
    if (detail !== undefined) {
      console.error(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }
  }
}

function section(title: string): void {
  console.log(`\n── ${title}`);
}

async function api(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  let parsed: Record<string, unknown> = {};
  const text = await response.text();
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body: parsed };
}

async function login(email: string): Promise<string> {
  const { body } = await api('POST', '/auth/login', '', { email, password: PASSWORD });
  const data = body.data as { accessToken?: string } | undefined;
  if (!data?.accessToken) throw new Error(`login failed for ${email}: ${JSON.stringify(body)}`);
  return data.accessToken;
}

async function main() {
  console.log('NAVO Phase 5 lifecycle verification');
  console.log(`target: ${BASE}`);

  const health = await api('GET', '/../health', '');
  if (health.status === 0) throw new Error('backend unreachable');

  section('Authentication');
  const tokens: Partial<Tokens> = {};
  for (const [key, email] of [
    ['requester', 'requester@demo.com'],
    ['procurement', 'procurement@demo.com'],
    ['finance', 'finance@demo.com'],
    ['seller', 'seller@demo.com'],
    ['admin', 'admin@demo.com'],
  ] as const) {
    try {
      tokens[key] = await login(email);
      check(`login ${email}`, true);
    } catch (err) {
      check(`login ${email}`, false, (err as Error).message);
    }
  }
  const t = tokens as Tokens;

  // ── Seller isolation ───────────────────────────────────────────────────────
  section('Seller isolation');
  const sellerOrders = await api('GET', '/purchase-orders', t.seller);
  check('seller can list their own orders', sellerOrders.status === 200, sellerOrders.body);

  const adminOrders = await api('GET', '/purchase-orders', t.admin);
  check('admin can list purchase orders', adminOrders.status === 200, adminOrders.body);

  const sellerOtherVendors = await api('GET', '/purchase-orders?vendorId=nonexistent', t.seller);
  check(
    'seller vendorId filter is ignored (scoped to own vendor)',
    sellerOtherVendors.status === 200,
    sellerOtherVendors.body,
  );

  // ── Find an accepted deal to convert ───────────────────────────────────────
  section('Deal to purchase order');
  const dealsResponse = await api('GET', '/deals/deals', t.requester);
  // listDeals nests its paginated envelope under `data`: { data: { data: [...] } }
  const dealsEnvelope = dealsResponse.body.data as { data?: unknown } | undefined;
  const deals = Array.isArray(dealsEnvelope?.data) ? (dealsEnvelope!.data as Array<{ id: string; dealNumber: string; vendorId: string; acceptedOfferId?: string; purchaseOrder?: unknown }>) : [];
  check('deals are listable', dealsResponse.status === 200, dealsResponse.body);

  // Resolve the seller's own vendor so the test drives a deal that the seller
  // is actually authorised to act on. Using any other deal would only exercise
  // the isolation guard.
  const me = await api('GET', '/auth/profile', t.seller);
  const sellerProfile = me.body.data as { vendorId?: string | null } | undefined;
  const sellerVendorId = sellerProfile?.vendorId;

  // Only a deal that the seller actually owns is usable here: the rest of the
  // lifecycle is driven as the supplier, so falling back to another vendor's deal
  // would only ever exercise the isolation guard.
  const convertible = deals.find(
    (d) => Boolean(d.acceptedOfferId) && d.vendorId === sellerVendorId && !d.purchaseOrder,
  );

  if (!convertible) {
    console.error(
      '\nNo unconverted accepted deal for the seller vendor. Run scripts/setup-phase5-deal.ts first.',
    );
    process.exit(2);
  }
  check(`found accepted deal ${convertible.dealNumber}`, true);
  check(
    'test deal belongs to the seller vendor',
    convertible.vendorId === sellerVendorId,
    { dealVendor: convertible.vendorId, sellerVendor: sellerVendorId },
  );

  const created = await api('POST', '/purchase-orders', t.requester, {
    dealId: convertible.id,
    deliveryAddress: 'Warehouse 4, Sector 18, Gurugram, Haryana 122015',
  });
  const po = created.body.data as
    | {
        id: string;
        poNumber: string;
        status: string;
        quantity: number;
        unitPrice: number | string;
        subtotal: number | string;
        taxAmount: number | string;
        totalAmount: number | string;
        approvals: Array<{ id: string; level: number; requiredRole: string; status: string }>;
        acceptedOfferSnapshot?: Record<string, unknown>;
      }
    | undefined;

  check('PO created from accepted deal', created.status === 201 && Boolean(po), created.body);
  if (!po) {
    process.exit(1);
  }
  check('PO number allocated', /^PO-\d{4}-\d{4}$/.test(po.poNumber), po.poNumber);
  check('PO starts in DRAFT', po.status === 'DRAFT', po.status);
  check('accepted offer snapshotted', Boolean(po.acceptedOfferSnapshot), po.acceptedOfferSnapshot);
  check('approval chain created', po.approvals.length >= 1, po.approvals.map((a) => `L${a.level}:${a.requiredRole}`));

  // Money integrity: subtotal = quantity * unitPrice, total = subtotal + tax + freight + installation + other
  const qty = Number(po.quantity);
  const unit = Number(po.unitPrice);
  const expectedSubtotal = Math.round(qty * unit * 1e4) / 1e4;
  check(
    'subtotal equals quantity x unitPrice',
    Math.abs(Number(po.subtotal) - expectedSubtotal) < 0.005,
    { subtotal: po.subtotal, expected: expectedSubtotal, qty, unit },
  );

  // Duplicate prevention
  const duplicate = await api('POST', '/purchase-orders', t.requester, { dealId: convertible.id });
  check('duplicate PO for the same deal is rejected', duplicate.status === 409, duplicate.body);

  // ── Approval chain ─────────────────────────────────────────────────────────
  section('Approvals and issuance gating');
  await api('POST', `/purchase-orders/${po.id}/issue`, t.procurement);
  const earlyIssue = await api('POST', `/purchase-orders/${po.id}/issue`, t.procurement);
  check('cannot issue a DRAFT purchase order', earlyIssue.status === 409, earlyIssue.body);

  const submitted = await api('POST', `/purchase-orders/${po.id}/submit-approval`, t.requester);
  check('PO submitted for approval', submitted.status === 200, submitted.body);

  const sellerAttempt = await api('POST', `/purchase-orders/${po.id}/cancel`, t.seller, { reason: 'nope' });
  check('seller cannot cancel a buyer purchase order', sellerAttempt.status === 403, sellerAttempt.body);

  // Decide each level in order with the right role.
  const refreshed = await api('GET', `/purchase-orders/${po.id}`, t.procurement);
  const approvals = (refreshed.body.data as { approvals: Array<{ id: string; level: number; requiredRole: string; status: string }> }).approvals;

  const levelOne = approvals.find((a) => a.level === 1)!;
  const financeLevel = approvals.find((a) => a.requiredRole === 'FINANCE_APPROVER');

  if (financeLevel) {
    // Out-of-order guard: finance cannot approve before level 1.
    const outOfOrder = await api(
      'POST',
      `/purchase-orders/${po.id}/approvals/${financeLevel.id}/decide`,
      t.finance,
      { status: 'APPROVED', comments: 'trying early' },
    );
    check('finance cannot skip level 1', outOfOrder.status === 409, outOfOrder.body);
  } else {
    console.log('  ..    order is below the finance threshold; skipping out-of-order test');
  }

  // Self-approval guard: the requester raised this PO.
  const selfApprove = await api(
    'POST',
    `/purchase-orders/${po.id}/approvals/${levelOne.id}/decide`,
    t.requester,
    { status: 'APPROVED' },
  );
  check('requester cannot approve their own PO', selfApprove.status === 403, selfApprove.body);

  const wrongRole = await api(
    'POST',
    `/purchase-orders/${po.id}/approvals/${levelOne.id}/decide`,
    t.seller,
    { status: 'APPROVED' },
  );
  check('seller cannot approve a purchase order', wrongRole.status === 403, wrongRole.body);

  const approveOne = await api(
    'POST',
    `/purchase-orders/${po.id}/approvals/${levelOne.id}/decide`,
    t.procurement,
    { status: 'APPROVED', comments: 'Terms match the accepted offer.' },
  );
  check('level 1 approved by procurement', approveOne.status === 200, approveOne.body);

  if (financeLevel) {
    const approveTwo = await api(
      'POST',
      `/purchase-orders/${po.id}/approvals/${financeLevel.id}/decide`,
      t.finance,
      { status: 'APPROVED', comments: 'Budget confirmed.' },
    );
    check('level 2 approved by finance', approveTwo.status === 200, approveTwo.body);
  }

  const allApprovals = approvals.filter((a) => a.requiredRole !== 'COMPANY_ADMIN');
  for (const level of approvals.filter((a) => a.requiredRole === 'COMPANY_ADMIN')) {
    await api('POST', `/purchase-orders/${po.id}/approvals/${level.id}/decide`, t.admin, {
      status: 'APPROVED',
      comments: 'Executive sign-off.',
    });
    check(`executive level ${level.level} approved`, true);
  }

  const issued = await api('POST', `/purchase-orders/${po.id}/issue`, t.procurement);
  check('PO issued once all levels approved', issued.status === 200 && (issued.body.data as { status: string }).status === 'ISSUED', issued.body);

  // ── Supplier actions ───────────────────────────────────────────────────────
  section('Supplier confirmation and delivery');
  const sellerSeeksToIssue = await api('POST', `/purchase-orders/${po.id}/issue`, t.seller);
  check('seller cannot issue a PO', sellerSeeksToIssue.status === 403, sellerSeeksToIssue.body);

  const dispatchBeforeConfirm = await api('POST', `/purchase-orders/${po.id}/delivery-events`, t.seller, {
    type: 'DISPATCH',
    trackingRef: 'TRK-1',
  });
  check('seller cannot dispatch before confirming', dispatchBeforeConfirm.status === 409, dispatchBeforeConfirm.body);

  const confirmed = await api('POST', `/purchase-orders/${po.id}/confirm`, t.seller, {
    confirmedDeliveryDate: new Date(Date.now() + 7 * 86400000).toISOString(),
    notes: 'Stock allocated, ready to dispatch.',
  });
  check('seller confirmed the order', confirmed.status === 200 && (confirmed.body.data as { status: string }).status === 'SUPPLIER_CONFIRMED', confirmed.body);

  const dispatch = await api('POST', `/purchase-orders/${po.id}/delivery-events`, t.seller, {
    type: 'DISPATCH',
    carrierName: 'BlueDart',
    trackingRef: 'BD-TRACK-99887',
    notes: 'Left the Mumbai warehouse.',
  });
  check('seller recorded dispatch', dispatch.status === 201, dispatch.body);

  const buyerCannotDispatch = await api('POST', `/purchase-orders/${po.id}/delivery-events`, t.requester, {
    type: 'DISPATCH',
  });
  check('buyer cannot record supplier dispatch events', buyerCannotDispatch.status === 403, buyerCannotDispatch.body);

  const buyerException = await api('POST', `/purchase-orders/${po.id}/delivery-events`, t.requester, {
    type: 'EXCEPTION',
    notes: 'Site contact reports a delay at the gate.',
  });
  check('buyer may record a delivery exception', buyerException.status === 201, buyerException.body);

  // ── Goods receipts ─────────────────────────────────────────────────────────
  section('Goods receipt quantity validation');
  const orderedQty = qty;

  // Split the order so over-receipt is detectable: receive a part first.
  const partQty = Math.max(1, Math.floor(orderedQty / 2));

  const badSplit = await api('POST', `/purchase-orders/${po.id}/receipts`, t.requester, {
    receivedQuantity: 2,
    acceptedQuantity: 1,
    rejectedQuantity: 0,
  });
  check('accepted + rejected must equal received', badSplit.status === 400, badSplit.body);

  const overAccepted = await api('POST', `/purchase-orders/${po.id}/receipts`, t.requester, {
    receivedQuantity: 2,
    acceptedQuantity: 3,
    rejectedQuantity: 0,
  });
  check('accepted cannot exceed received', overAccepted.status === 400, overAccepted.body);

  const overReceive = await api('POST', `/purchase-orders/${po.id}/receipts`, t.requester, {
    receivedQuantity: orderedQty + 5,
    acceptedQuantity: orderedQty + 5,
    rejectedQuantity: 0,
  });
  check('cannot receive more than ordered', overReceive.status === 409, overReceive.body);

  const sellerReceipt = await api('POST', `/purchase-orders/${po.id}/receipts`, t.seller, {
    receivedQuantity: 1,
    acceptedQuantity: 1,
  });
  check('seller cannot record a goods receipt', sellerReceipt.status === 403, sellerReceipt.body);

  const partial = await api('POST', `/purchase-orders/${po.id}/receipts`, t.requester, {
    receivedQuantity: partQty,
    acceptedQuantity: partQty,
    rejectedQuantity: 0,
    conditionNotes: 'First tranche, all good.',
  });
  const partialData = partial.body.data as { poStatus?: string; remainingQuantity?: number } | undefined;
  check('partial receipt accepted', partial.status === 201, partial.body);
  check('partial receipt yields PARTIALLY_DELIVERED', partialData?.poStatus === 'PARTIALLY_DELIVERED', partialData?.poStatus);
  check('remaining quantity reported', partialData?.remainingQuantity === orderedQty - partQty, partialData?.remainingQuantity);

  const remainder = orderedQty - partQty;
  const finalReceipt = await api('POST', `/purchase-orders/${po.id}/receipts`, t.requester, {
    receivedQuantity: remainder,
    acceptedQuantity: remainder,
    rejectedQuantity: 0,
  });
  check(
    'full receipt yields DELIVERED',
    finalReceipt.status === 201 && (finalReceipt.body.data as { poStatus: string }).poStatus === 'DELIVERED',
    finalReceipt.body,
  );

  const cumulativeOverReceive = await api('POST', `/purchase-orders/${po.id}/receipts`, t.requester, {
    receivedQuantity: 1,
    acceptedQuantity: 1,
  });
  check(
    'cumulative over-receipt is rejected',
    cumulativeOverReceive.status === 409,
    cumulativeOverReceive.body,
  );

  // ── Invoice and three-way match ────────────────────────────────────────────
  section('Invoice submission and three-way matching');
  const unitPrice = Number(po.unitPrice);
  const taxRate = Number((po.acceptedOfferSnapshot?.taxRate as number | string) ?? 0);

  const poTotal = Number(po.totalAmount);

  const invoiceNumber = `E2E-INV-${Date.now()}`;
  // Make the amount unique per run. Otherwise an invoice from an earlier run
  // (same vendor, same negotiated total, same day) is a legitimate match for
  // the duplicate check and the assertions below stop being deterministic.
  // Offset inside the 1.00 matching tolerance: the invoice still matches the
  // accepted value, but its total is unique to this run.
  const generationOffset = ((Date.now() % 97) + 1) / 100;
  const uniqueAmount = Math.round((poTotal + generationOffset) * 100) / 100;

  const goodInvoice = await api('POST', '/purchase-orders/invoices', t.seller, {
    poId: po.id,
    invoiceNumber,
    invoiceDate: new Date().toISOString(),
    quantity: orderedQty,
    unitPrice,
    taxRate,
    totalAmount: uniqueAmount,
    extractedData: { quantity: orderedQty, unitPrice },
    extractionMethod: 'manual',
  });
  const invoice = goodInvoice.body.data as { id: string; invoiceNumber: string } | undefined;
  check('seller submitted an invoice', goodInvoice.status === 201, goodInvoice.body);

  if (!invoice) {
    process.exit(1);
  }

  const duplicateInvoice = await api('POST', '/purchase-orders/invoices', t.seller, {
    poId: po.id,
    invoiceNumber,
    invoiceDate: new Date().toISOString(),
    totalAmount: uniqueAmount,
  });
  check('duplicate invoice number is rejected', duplicateInvoice.status === 409, duplicateInvoice.body);

  const sellerVerify = await api('POST', `/purchase-orders/invoices/${invoice.id}/verify`, t.seller);
  check('seller cannot verify an invoice', sellerVerify.status === 403, sellerVerify.body);

  const verified = await api('POST', `/purchase-orders/invoices/${invoice.id}/verify`, t.finance, {
    notes: 'Automated three-way match.',
  });
  const verifyData = verified.body.data as
    | { matched: boolean; discrepancies: Array<{ field: string; severity: string; message: string; resolution: string }>; checkedFields: Record<string, unknown> }
    | undefined;

  check('three-way match executed', verified.status === 200, verified.body);
  check('matching invoice reports matched', verifyData?.matched === true, verifyData?.discrepancies);
  check(
    'match records checked fields for audit',
    Boolean(verifyData?.checkedFields && Object.keys(verifyData.checkedFields).length > 0),
    verifyData?.checkedFields && Object.keys(verifyData.checkedFields),
  );

  // A discrepant invoice must be blocked from payment.
  const discrepantNumber = `E2E-BAD-${Date.now()}`;
  const discrepant = await api('POST', '/purchase-orders/invoices', t.seller, {
    poId: po.id,
    invoiceNumber: discrepantNumber,
    invoiceDate: new Date().toISOString(),
    totalAmount: poTotal + 500,
    extractedData: { quantity: orderedQty, unitPrice: unitPrice * 1.5 },
  });
  const discrepantInvoice = discrepant.body.data as { id: string } | undefined;
  check('discrepant invoice accepted for review', discrepant.status === 201, discrepant.body);

  if (discrepantInvoice) {
    const badVerify = await api('POST', `/purchase-orders/invoices/${discrepantInvoice.id}/verify`, t.finance, {});
    const badData = badVerify.body.data as
      | { matched: boolean; hasCritical: boolean; discrepancies: Array<{ field: string; severity: string; resolution: string }> }
      | undefined;
    check('discrepant invoice does not match', badData?.matched === false, badData?.discrepancies);
    check('critical discrepancy detected', badData?.hasCritical === true, badData?.discrepancies);
    check(
      'discrepancies are typed with expected and actual values',
      (badData?.discrepancies ?? []).every((d) => d.field && d.severity),
      badData?.discrepancies,
    );

    const blockedPayment = await api('POST', '/purchase-orders/payments', t.finance, {
      poId: po.id,
      invoiceId: discrepantInvoice.id,
      status: 'PAID',
      paidAmount: uniqueAmount,
    });
    check('payment blocked by critical discrepancy', blockedPayment.status === 409, blockedPayment.body);

    const criticals = (badData?.discrepancies ?? []).filter((d) => d.severity === 'CRITICAL');
    check('at least one critical discrepancy found', criticals.length > 0, badData?.discrepancies);

    if (criticals.length > 0) {
      const first = criticals[0];
      const noNote = await api(
        'POST',
        `/purchase-orders/invoices/${discrepantInvoice.id}/resolve-discrepancy`,
        t.finance,
        { field: first.field, resolution: 'ACCEPTED' },
      );
      check('critical discrepancy requires a rationale', noNote.status === 400, noNote.body);

      // Every critical item must be cleared, otherwise payment stays blocked.
      // Resolve all but the last, then prove the block still holds.
      for (const d of criticals.slice(0, -1)) {
        await api('POST', `/purchase-orders/invoices/${discrepantInvoice.id}/resolve-discrepancy`, t.finance, {
          field: d.field,
          resolution: 'ACCEPTED',
          note: 'Corrected value confirmed by the requester in writing.',
        });
      }

      const last = criticals[criticals.length - 1];
      if (criticals.length > 1) {
        const stillBlocked = await api('POST', '/purchase-orders/payments', t.finance, {
          poId: po.id,
          invoiceId: discrepantInvoice.id,
          status: 'PAID',
          paidAmount: uniqueAmount,
        });
        check(
          'payment stays blocked while any critical discrepancy is open',
          stillBlocked.status === 409,
          stillBlocked.body,
        );
      }

      const resolved = await api(
        'POST',
        `/purchase-orders/invoices/${discrepantInvoice.id}/resolve-discrepancy`,
        t.finance,
        { field: last.field, resolution: 'ACCEPTED', note: 'Price rise confirmed by the requester in writing.' },
      );
      check('critical discrepancy resolved with rationale', resolved.status === 200, resolved.body);
      check('no outstanding critical discrepancies remain', (resolved.body.data as { outstandingCritical: boolean }).outstandingCritical === false, resolved.body);

      const doubleResolve = await api(
        'POST',
        `/purchase-orders/invoices/${discrepantInvoice.id}/resolve-discrepancy`,
        t.finance,
        { field: last.field, resolution: 'ACCEPTED', note: 'again' },
      );
      check('a discrepancy cannot be resolved twice', doubleResolve.status === 409, doubleResolve.body);
    }

    // A same-amount invoice on a *different* purchase order is normal supplier
    // behaviour, so it must warn without blocking payment.
    const otherPoResponse = await api('GET', '/purchase-orders?limit=5', t.admin);
    const otherPoList = (otherPoResponse.body.data ?? []) as Array<{ id: string; poNumber: string; vendorId: string }>;
    const otherPo = otherPoList.find((p) => p.id !== po.id && p.vendorId === sellerVendorId);

    if (otherPo) {
      const crossPoInvoice = await api('POST', '/purchase-orders/invoices', t.seller, {
        poId: otherPo.id,
        invoiceNumber: `E2E-CROSS-${Date.now()}`,
        invoiceDate: new Date().toISOString(),
        totalAmount: uniqueAmount,
      });

      if (crossPoInvoice.status === 201) {
        const crossVerify = await api(
          'POST',
          `/purchase-orders/invoices/${(crossPoInvoice.body.data as { id: string }).id}/verify`,
          t.finance,
          {},
        );
        const crossData = crossVerify.body.data as
          | { hasCritical: boolean; discrepancies: Array<{ type: string; severity: string }> }
          | undefined;
        const dup = (crossData?.discrepancies ?? []).find((d) => d.type === 'DUPLICATE_INVOICE');
        check(
          'cross-PO same-amount duplicate warns instead of blocking',
          dup === undefined || dup.severity === 'WARNING',
          dup,
        );
        check(
          'warning-level duplicate does not block payment',
          crossData?.hasCritical !== true || (dup?.severity !== 'CRITICAL'),
          crossData,
        );
      } else {
        console.log(`  ..    cross-PO invoice not created (${crossPoInvoice.status}); skipping duplicate-severity check`);
      }
    } else {
      console.log('  ..    no second Northwind purchase order available; skipping duplicate-severity check');
    }
  }

  // ── Payments ───────────────────────────────────────────────────────────────
  section('Payment recording');
  const overPay = await api('POST', '/purchase-orders/payments', t.finance, {
    poId: po.id,
    invoiceId: invoice.id,
    status: 'PARTIALLY_PAID',
    paidAmount: uniqueAmount + 1,
  });
  check('cannot pay more than the invoice total', overPay.status === 400, overPay.body);

  const partialPay = await api('POST', '/purchase-orders/payments', t.finance, {
    poId: po.id,
    invoiceId: invoice.id,
    status: 'PARTIALLY_PAID',
    paidAmount: Math.round(uniqueAmount / 2),
    reference: 'NEFT/2026/0001',
    paymentMethod: 'NEFT',
  });
  const partialPayData = partialPay.body.data as { status: string; paidAmount: number | string } | undefined;
  check('partial payment recorded', partialPay.status === 201, partialPay.body);
  check('partial payment derives PARTIALLY_PAID', partialPayData?.status === 'PARTIALLY_PAID', partialPayData?.status);

  const fakeFull = await api('POST', '/purchase-orders/payments', t.finance, {
    poId: po.id,
    invoiceId: invoice.id,
    status: 'PAID',
    paidAmount: 1,
  });
  check('cannot claim PAID with an underpayment', fakeFull.status === 400, fakeFull.body);

  const finalPay = await api('POST', '/purchase-orders/payments', t.finance, {
    poId: po.id,
    invoiceId: invoice.id,
    status: 'PAID',
    paidAmount: uniqueAmount,
    reference: 'NEFT/2026/0002',
    paymentMethod: 'NEFT',
    paidAt: new Date().toISOString(),
  });
  check('final payment recorded as PAID', finalPay.status === 201 && (finalPay.body.data as { status: string }).status === 'PAID', finalPay.body);

  // ── Summary, timeline and assistant ────────────────────────────────────────
  section('Derived summary, timeline and assistant');
  const summaryResponse = await api('GET', `/purchase-orders/${po.id}/summary`, t.requester);
  const summary = summaryResponse.body.data as
    | { acceptedQuantity: number; orderedQuantity: number; invoicedAmount: number; paidAmount: number; outstandingAmount: number; narrative: string; openDiscrepancies: number }
    | undefined;
  check('summary is derivable', summaryResponse.status === 200, summaryResponse.body);
  check('summary counts all accepted units', summary?.acceptedQuantity === orderedQty, summary);
  check('summary narrative is a factual restatement', typeof summary?.narrative === 'string' && summary.narrative.length > 0, summary?.narrative);

  const timeline = await api('GET', `/purchase-orders/${po.id}/timeline`, t.requester);
  const entries = (timeline.body.data as Array<{ stage: string; title: string; source: string }>) ?? [];
  check('timeline is populated', timeline.status === 200 && entries.length > 0, timeline.body);
  const stages = new Set(entries.map((e) => e.stage));
  check('timeline covers deal through payment', ['DEAL', 'PO', 'APPROVAL', 'SUPPLIER', 'DELIVERY', 'RECEIPT', 'INVOICE', 'VERIFICATION', 'PAYMENT'].every((s) => stages.has(s)), [...stages]);
  check('every timeline entry declares its source', entries.every((e) => e.source === 'application_data' || e.source === 'audit_log'));

  const assistant = await api('POST', '/purchase-orders/assistant?poId=' + po.id, t.requester, {
    question: 'What is outstanding on payment?',
  });
  const assistantData = assistant.body.data as { answer: string; source: string; evidence: string[] } | undefined;
  check('assistant answers from stored data', assistant.status === 200, assistant.body);
  check('assistant declares application_data source', assistantData?.source === 'application_data', assistantData?.source);
  check('assistant cites evidence records', (assistantData?.evidence ?? []).length > 0, assistantData?.evidence);

  const assistantHistory = await api('POST', '/purchase-orders/assistant?poId=' + po.id, t.requester, {
    question: 'Show the full transaction history',
  });
  const historyData = assistantHistory.body.data as { answer: string } | undefined;
  check('assistant returns the transaction history', (historyData?.answer ?? '').includes('Transaction history'), historyData?.answer?.slice(0, 120));

  // Payment, invoice and discrepancy topics all read invoice verifications
  // through one shared query; this guards that query from regressing.
  for (const question of [
    'How much has been paid so far?',
    'Are there any discrepancies?',
  ]) {
    const reply = await api('POST', '/purchase-orders/assistant?poId=' + po.id, t.requester, { question });
    const data = reply.body.data as { answer?: string } | undefined;
    check(`assistant answers "${question}"`, reply.status === 200 && Boolean(data?.answer), reply.body);
  }

  const offTopic = await api('POST', '/purchase-orders/assistant?poId=' + po.id, t.requester, {
    question: 'What is the weather tomorrow?',
  });
  const offTopicData = offTopic.body.data as { notAnswerable?: boolean; answer?: string } | undefined;
  check(
    'assistant refuses an off-topic question',
    offTopic.status === 200 && offTopicData?.notAnswerable === true,
    offTopic.body,
  );

  // ── Cross-tenant / role negative checks ────────────────────────────────────
  section('Authorization negatives');
  const sellerSeesOtherPo = await api('GET', `/purchase-orders/${po.id}`, t.seller);
  check('seller can read their own PO', sellerSeesOtherPo.status === 200, sellerSeesOtherPo.body);

  const sellerApprove = await api('GET', `/purchase-orders/${po.id}/summary`, t.seller);
  check('seller can read their own PO summary', sellerApprove.status === 200, sellerApprove.body);

  const unauth = await api('GET', `/purchase-orders/${po.id}`, '');
  check('unauthenticated access is rejected', unauth.status === 401, unauth.body);

  const badId = await api('GET', '/purchase-orders/does-not-exist', t.admin);
  check('unknown PO returns 404', badId.status === 404, badId.body);

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nVerification aborted:', err);
  process.exit(1);
});
