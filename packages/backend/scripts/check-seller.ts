import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

async function main() {
  const tenant = await p.tenant.findUnique({ where: { slug: 'demo-corp' } });
  if (!tenant) throw new Error('demo tenant missing');

  const u = await p.user.findUnique({
    where: { email_tenantId: { email: 'seller@demo.com', tenantId: tenant.id } },
    include: { vendor: true },
  });

  console.log(
    JSON.stringify(
      {
        email: u?.email,
        role: u?.role,
        vendorId: u?.vendorId,
        vendorName: u?.vendor?.name,
        vendorStatus: u?.vendor?.status,
      },
      null,
      2,
    ),
  );

  console.log('vendor count:', await p.vendor.count({ where: { tenantId: tenant.id } }));
}

main().finally(() => p.$disconnect());