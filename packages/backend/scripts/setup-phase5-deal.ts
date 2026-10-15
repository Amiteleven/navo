/**
 * Test setup: produce an accepted Deal owned by the seeded Northwind vendor so
 * the Phase 5 seller flows have a real order to act on.
 *
 * Why part of this is done through Prisma rather than the API:
 *
 * Phase 4 resolves the acting seller by comparing the JWT `userId` directly
 * against `Connection.vendorId` (see respondToConnection and the isVendor check
 * in createOffer). Both columns reference `Vendor.id`, but a seller logs in as a
 * `User`, so `User.id` never equals the `Vendor.id` its account is linked to.
 * A seller therefore cannot respond to a connection or submit an offer against
 * a vendor record, which makes the Northwind deal unreachable over the API.
 *
 * Phase 5 deliberately does NOT repeat that mistake: seller authorization in
 * `po-access.ts` resolves `User.vendorId` -> `Vendor.id` and compares that,
 * which is why the seller isolation checks pass.
 *
 * Everything after the deal room exists goes through the real API, so the offer
 * and deal are genuine application records.
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const BASE = process.env.E2E_BASE ?? 'http://localhost:3000/api';
const PASSWORD = 'password123';

async function api(method: string, path: string, token: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body: parsed };
}

async function main() {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'demo-corp' } });
  const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: 'demo-vendor-northwind' } });
  const requester = await prisma.user.findUniqueOrThrow({
    where: { email_tenantId: { email: 'requester@demo.com', tenantId: tenant.id } },
  });

  // Reuse an existing Northwind deal room if a previous run created one.
  let dealRoom = await prisma.dealRoom.findFirst({
    where: { tenantId: tenant.id, vendorId: vendor.id, status: { in: ['ACTIVE', 'NEGOTIATING'] } },
  });

  let connection = dealRoom
    ? await prisma.connection.findUnique({ where: { id: dealRoom.connectionId } })
    : null;

  if (!dealRoom || !connection) {
    // 1. Buyer creates the request over the real API.
    const request = await api('POST', '/requests', (await login('requester@demo.com')).token, {
      title: 'Northwind industrial bearing assortment',
      item: 'Industrial bearing set',
      description: 'Sealed bearing assortment for the Gurugram plant maintenance team.',
      categoryId: (await prisma.category.findFirst({ where: { tenantId: tenant.id } }))?.id,
      quantity: 12,
      unit: 'set',
      location: 'Warehouse 4, Sector 18, Gurugram, Haryana 122015',
      requiredDate: new Date(Date.now() + 30 * 86400000).toISOString(),
      // Priority is a numeric enum, not a string label.
      priority: 2,
      descriptionRequired: false,
    });

    if (request.status >= 400) {
      throw new Error(`request creation failed: ${JSON.stringify(request.body)}`);
    }
    const requestId = (request.body.data as { id: string }).id;

    // 2. Buyer opens a connection to Northwind (API path is correct here: it
    //    takes the Vendor.id explicitly).
    const connectionResponse = await api(
      'POST',
      '/deals/connections',
      (await login('requester@demo.com')).token,
      { requestId, vendorId: vendor.id, message: 'Please quote your best price for the bearing assortment.' },
    );
    if (connectionResponse.status >= 400) {
      throw new Error(`connection creation failed: ${JSON.stringify(connectionResponse.body)}`);
    }
    connection = (connectionResponse.body.data as { id: string }) as { id: string };

    // 3. Accept the connection and open the deal room, bypassing the Phase 4
    //    userId/vendorId mismatch described above. The connection endpoint may
    //    already have provisioned a room, so reuse it when present.
    connection = await prisma.connection.update({
      where: { id: connection.id },
      data: { status: 'ACCEPTED', respondedAt: new Date() },
    });

    dealRoom = await prisma.dealRoom.findUnique({ where: { connectionId: connection.id } });
    if (!dealRoom) {
      dealRoom = await prisma.dealRoom.create({
        data: {
          connectionId: connection.id,
          requestId,
          buyerId: requester.id,
          vendorId: vendor.id,
          status: 'NEGOTIATING',
          tenantId: tenant.id,
        },
      });
    } else {
      await prisma.dealRoom.update({
        where: { id: dealRoom.id },
        data: { status: 'NEGOTIATING' },
      });
    }
    console.log(`deal room ${dealRoom.id} ready for ${vendor.name}`);
  } else {
    console.log(`reusing deal room ${dealRoom.id}`);
  }

  // 4. Buyer submits an offer over the real API.
  const buyerToken = (await login('requester@demo.com')).token;
  const offerResponse = await api('POST', '/deals/offers', buyerToken, {
    dealRoomId: dealRoom.id,
    unitPrice: 4825.5,
    quantity: 12,
    gst: 18,
    freightAmount: 1500,
    installationAmount: 750,
    otherCharges: 0,
    warrantyMonths: 24,
    deliveryTimelineDays: 10,
    paymentTerms: 'Net 30 from invoice verification',
    validityDays: 30,
    message: 'Budget confirmed. Please supply within 10 days.',
  });
  if (offerResponse.status >= 400) {
    throw new Error(`offer creation failed: ${JSON.stringify(offerResponse.body)}`);
  }
  const offer = offerResponse.body.data as { id: string };

  // 5. Buyer accepts it, producing the Deal.
  const acceptResponse = await api('POST', '/deals/offers/accept', buyerToken, { offerId: offer.id });
  if (acceptResponse.status >= 400) {
    throw new Error(`offer acceptance failed: ${JSON.stringify(acceptResponse.body)}`);
  }

  const deal = (acceptResponse.body.data as { deal?: { id: string; dealNumber: string }; updatedOffer?: { id: string } });
  console.log(`deal: ${deal.deal?.dealNumber} (${deal.deal?.id})`);
  console.log(deal.deal?.id ?? '');
}

async function login(email: string): Promise<{ token: string }> {
  const response = await api('POST', '/auth/login', '', { email, password: PASSWORD });
  const data = response.body.data as { accessToken?: string } | undefined;
  if (!data?.accessToken) throw new Error(`login failed for ${email}`);
  return { token: data.accessToken };
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());