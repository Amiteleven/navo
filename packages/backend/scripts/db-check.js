const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function check() {
  try {
    await prisma.$connect();
    
    // Basic connectivity
    const result = await prisma.$queryRawUnsafe('SELECT current_database() AS db, current_schema() AS schema, NOW()::text AS ts');
    console.log('\n=== NEON DB CONNECTION STATUS ===');
    console.log('✅ CONNECTED');
    console.log('   Database :', result[0].db);
    console.log('   Schema   :', result[0].schema);
    console.log('   Timestamp:', result[0].ts);

    // Tables
    const tables = await prisma.$queryRawUnsafe("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    console.log('\n=== TABLES IN PUBLIC SCHEMA ===');
    console.log('Total tables:', tables.length);
    tables.forEach(t => console.log('  -', t.tablename));

    // Seed data
    const tc = await prisma.tenant.count();
    const uc = await prisma.user.count();
    const vc = await prisma.vendor.count();
    const rc = await prisma.procurementRequest.count();
    console.log('\n=== SEED DATA ROWS ===');
    console.log('  Tenants  :', tc);
    console.log('  Users    :', uc);
    console.log('  Vendors  :', vc);
    console.log('  Requests :', rc);

    console.log('\n✅ Neon DB is fully connected and healthy!');
  } catch (err) {
    console.error('\n❌ Connection failed:', err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

check();
