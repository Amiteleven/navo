import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Clear the demo tenant's transactional rows so the seed can be re-run.
 *
 * Only data belonging to `demo-corp` is touched. Users, vendors and categories
 * are upserted further down and are deliberately left alone; what must go is
 * everything a previous run created, because several of those rows carry fixed
 * natural keys (RFQ-2024-0001 and friends) and would otherwise fail the unique
 * constraint on the second run.
 *
 * Order matters: children before parents, so no delete trips a foreign key.
 * Rows with no `tenantId` of their own are reached through their parent, which
 * is already scoped to this tenant.
 */
async function resetDemoTenant(tenantId: string): Promise<void> {
  const tenant = { tenantId };

  // Room-scoped rows carry only a plain `dealRoomId`, so the tenant's rooms are
  // listed first rather than filtered through a relation that does not exist.
  const rooms = await prisma.dealRoom.findMany({ where: tenant, select: { id: true } });
  const roomIds = rooms.map((room) => room.id);

  // Purchase execution first: `PurchaseOrder.dealId` is a RESTRICT foreign key,
  // so orders must go before the deals that reference them.
  await prisma.goodsReceipt.deleteMany({ where: { po: { tenantId } } });
  await prisma.invoiceVerification.deleteMany({ where: { po: { tenantId } } });
  await prisma.purchaseOrderApproval.deleteMany({ where: { po: { tenantId } } });
  await prisma.deliveryEvent.deleteMany({ where: { po: { tenantId } } });
  await prisma.payment.deleteMany({ where: tenant });
  await prisma.invoice.deleteMany({ where: tenant });
  await prisma.document.deleteMany({ where: tenant });
  await prisma.purchaseOrder.deleteMany({ where: tenant });

  // Negotiation rooms and their contents.
  await prisma.dealMessageRead.deleteMany({ where: { dealRoomId: { in: roomIds } } });
  await prisma.messageAttachment.deleteMany({ where: { dealRoomId: { in: roomIds } } });
  await prisma.negotiationMessage.deleteMany({ where: { dealRoomId: { in: roomIds } } });
  await prisma.dealMessage.deleteMany({ where: { dealRoomId: { in: roomIds } } });
  await prisma.dealOffer.deleteMany({ where: { dealRoomId: { in: roomIds } } });
  await prisma.deal.deleteMany({ where: { dealRoomId: { in: roomIds } } });
  await prisma.connection.deleteMany({ where: tenant });
  await prisma.dealRoom.deleteMany({ where: tenant });

  // Notifications, including anything queued for offline email delivery.
  await prisma.emailDelivery.deleteMany({ where: tenant });
  await prisma.notification.deleteMany({ where: tenant });
  await prisma.notificationPreference.deleteMany({ where: tenant });

  // Marketplace and moderation.
  await prisma.contactRestriction.deleteMany({ where: tenant });
  await prisma.abuseReport.deleteMany({ where: tenant });
  await prisma.marketplaceInterest.deleteMany({ where: tenant });
  await prisma.requestAttachment.deleteMany({ where: tenant });

  // Copilot threads and their grounded proposals.
  await prisma.copilotMessage.deleteMany({ where: { conversation: { tenantId } } });
  await prisma.copilotAction.deleteMany({ where: { conversation: { tenantId } } });
  await prisma.copilotConversation.deleteMany({ where: tenant });

  // Request, RFQ and quote chain.
  await prisma.approval.deleteMany({ where: tenant });
  await prisma.recommendation.deleteMany({ where: { request: { tenantId } } });
  await prisma.quoteAnalysis.deleteMany({ where: { quote: { rfq: { tenantId } } } });
  await prisma.quoteComparison.deleteMany({ where: { quote: { rfq: { tenantId } } } });
  await prisma.quote.deleteMany({ where: { rfq: { tenantId } } });
  await prisma.rFQVendor.deleteMany({ where: { rfq: { tenantId } } });
  await prisma.rFQ.deleteMany({ where: tenant });

  await prisma.auditLog.deleteMany({ where: tenant });
  await prisma.savingsRecord.deleteMany({ where: tenant });
  await prisma.priceBenchmark.deleteMany({ where: tenant });
  await prisma.extractedRequirement.deleteMany({ where: { request: { tenantId } } });
  await prisma.procurementRequest.deleteMany({ where: tenant });

  // VendorPerformance is keyed by vendor rather than tenant, so it is cleared
  // for this tenant's vendors only and then recreated below.
  const vendorIds = (
    await prisma.vendor.findMany({ where: tenant, select: { id: true } })
  ).map((vendor) => vendor.id);
  await prisma.vendorPerformance.deleteMany({ where: { vendorId: { in: vendorIds } } });
}

async function main() {
  console.log('🌱 Seeding database...');

  // Create demo tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo-corp' },
    update: {},
    create: {
      name: 'Demo Corporation',
      slug: 'demo-corp',
      domain: 'demo.navo.app',
      isActive: true,
    },
  });

  console.log('✅ Created tenant:', tenant.name);

  await resetDemoTenant(tenant.id);


  // Hash password
  const passwordHash = await bcrypt.hash('password123', 12);

  // Create demo users
  const admin = await prisma.user.upsert({
    where: { email_tenantId: { email: 'admin@demo.com', tenantId: tenant.id } },
    update: {},
    create: {
      email: 'admin@demo.com',
      passwordHash,
      firstName: 'Admin',
      lastName: 'User',
      role: 'COMPANY_ADMIN',
      isActive: true,
      tenantId: tenant.id,
    },
  });

  const procurementManager = await prisma.user.upsert({
    where: { email_tenantId: { email: 'procurement@demo.com', tenantId: tenant.id } },
    update: {},
    create: {
      email: 'procurement@demo.com',
      passwordHash,
      firstName: 'Priya',
      lastName: 'Sharma',
      role: 'PROCUREMENT_MANAGER',
      isActive: true,
      tenantId: tenant.id,
    },
  });

  const financeApprover = await prisma.user.upsert({
    where: { email_tenantId: { email: 'finance@demo.com', tenantId: tenant.id } },
    update: {},
    create: {
      email: 'finance@demo.com',
      passwordHash,
      firstName: 'Rajesh',
      lastName: 'Kumar',
      role: 'FINANCE_APPROVER',
      isActive: true,
      tenantId: tenant.id,
    },
  });

  const requester = await prisma.user.upsert({
    where: { email_tenantId: { email: 'requester@demo.com', tenantId: tenant.id } },
    update: {},
    create: {
      email: 'requester@demo.com',
      passwordHash,
      firstName: 'Anita',
      lastName: 'Singh',
      role: 'REQUESTER',
      isActive: true,
      tenantId: tenant.id,
    },
  });

  console.log('✅ Created users');

  // Phase 5: a supplier login linked to a Vendor record.
  // Seller authorization resolves vendorId from User.vendorId, so a VENDOR-role
  // user without this link can authenticate but cannot act on any purchase
  // order. Seeding the link is what makes the seller flows reachable.
  const sellerVendor = await prisma.vendor.upsert({
    where: { id: 'demo-vendor-northwind' },
    update: { name: 'Northwind Industrial Supplies', gstin: '27AAACN1234C1ZP' },
    create: {
      id: 'demo-vendor-northwind',
      name: 'Northwind Industrial Supplies',
      email: 'sales@northwind.example',
      status: 'ACTIVE',
      gstin: '27AAACN1234C1ZP',
      isPublic: true,
      approvedAt: new Date(),
      tenantId: tenant.id,
    },
  });

  const sellerUser = await prisma.user.upsert({
    where: { email_tenantId: { email: 'seller@demo.com', tenantId: tenant.id } },
    update: { vendorId: sellerVendor.id },
    create: {
      email: 'seller@demo.com',
      passwordHash,
      firstName: 'Vikram',
      lastName: 'Desai',
      role: 'VENDOR',
      isActive: true,
      vendorId: sellerVendor.id,
      tenantId: tenant.id,
    },
  });

  console.log('✅ Created seller account seller@demo.com ->', sellerVendor.name);

  // Create categories
  const categories = await Promise.all([
    prisma.category.upsert({
      where: { name_tenantId: { name: 'IT Hardware', tenantId: tenant.id } },
      update: {},
      create: { name: 'IT Hardware', description: 'Computers, laptops, servers, peripherals', tenantId: tenant.id },
    }),
    prisma.category.upsert({
      where: { name_tenantId: { name: 'Software', tenantId: tenant.id } },
      update: {},
      create: { name: 'Software', description: 'Licenses, SaaS subscriptions, development tools', tenantId: tenant.id },
    }),
    prisma.category.upsert({
      where: { name_tenantId: { name: 'Office Supplies', tenantId: tenant.id } },
      update: {},
      create: { name: 'Office Supplies', description: 'Stationery, furniture, consumables', tenantId: tenant.id },
    }),
    prisma.category.upsert({
      where: { name_tenantId: { name: 'Professional Services', tenantId: tenant.id } },
      update: {},
      create: { name: 'Professional Services', description: 'Consulting, marketing, legal, accounting', tenantId: tenant.id },
    }),
    prisma.category.upsert({
      where: { name_tenantId: { name: 'Facilities', tenantId: tenant.id } },
      update: {},
      create: { name: 'Facilities', description: 'Maintenance, cleaning, security, utilities', tenantId: tenant.id },
    }),
  ]);

  console.log('✅ Created categories');

  const itHardware = categories.find(c => c.name === 'IT Hardware')!;
  const software = categories.find(c => c.name === 'Software')!;
  const officeSupplies = categories.find(c => c.name === 'Office Supplies')!;
  const profServices = categories.find(c => c.name === 'Professional Services')!;

  // Create vendors
  const vendors = await Promise.all([
    prisma.vendor.upsert({
      where: { id: 'vendor-dell' },
      update: {},
      create: {
        id: 'vendor-dell',
        name: 'Dell Technologies',
        categoryId: itHardware.id,
        contactPerson: 'Sarah Johnson',
        email: 'sales@dell.com',
        phone: '+1-800-624-9897',
        address: 'One Dell Way',
        city: 'Round Rock',
        state: 'Texas',
        country: 'USA',
        postalCode: '78682',
        products: 'Laptops, Desktops, Servers, Monitors, Storage',
        status: 'ACTIVE',
        approvedAt: new Date(),
        approvedBy: admin.id,
        tenantId: tenant.id,
      },
    }),
    prisma.vendor.upsert({
      where: { id: 'vendor-hp' },
      update: {},
      create: {
        id: 'vendor-hp',
        name: 'HP Inc.',
        categoryId: itHardware.id,
        contactPerson: 'Michael Chen',
        email: 'procurement@hp.com',
        phone: '+1-800-474-6836',
        address: '1501 Page Mill Road',
        city: 'Palo Alto',
        state: 'California',
        country: 'USA',
        postalCode: '94304',
        products: 'Laptops, Printers, Workstations, Accessories',
        status: 'ACTIVE',
        approvedAt: new Date(),
        approvedBy: admin.id,
        tenantId: tenant.id,
      },
    }),
    prisma.vendor.upsert({
      where: { id: 'vendor-lenovo' },
      update: {},
      create: {
        id: 'vendor-lenovo',
        name: 'Lenovo Group',
        categoryId: itHardware.id,
        contactPerson: 'Emily Watson',
        email: 'b2b@lenovo.com',
        phone: '+1-855-253-6686',
        address: '1009 ThinkPlace',
        city: 'Morrisville',
        state: 'North Carolina',
        country: 'USA',
        postalCode: '27560',
        products: 'ThinkPad Laptops, ThinkCentre Desktops, ThinkStation Workstations',
        status: 'ACTIVE',
        approvedAt: new Date(),
        approvedBy: admin.id,
        tenantId: tenant.id,
      },
    }),
    prisma.vendor.upsert({
      where: { id: 'vendor-microsoft' },
      update: {},
      create: {
        id: 'vendor-microsoft',
        name: 'Microsoft Corporation',
        categoryId: software.id,
        contactPerson: 'David Park',
        email: 'licensing@microsoft.com',
        phone: '+1-800-642-7676',
        address: 'One Microsoft Way',
        city: 'Redmond',
        state: 'Washington',
        country: 'USA',
        postalCode: '98052',
        products: 'Office 365, Azure, Windows Server, SQL Server, Dynamics 365',
        status: 'ACTIVE',
        approvedAt: new Date(),
        approvedBy: admin.id,
        tenantId: tenant.id,
      },
    }),
    prisma.vendor.upsert({
      where: { id: 'vendor-aws' },
      update: {},
      create: {
        id: 'vendor-aws',
        name: 'Amazon Web Services',
        categoryId: software.id,
        contactPerson: 'Lisa Thompson',
        email: 'aws-sales@amazon.com',
        phone: '+1-800-555-0199',
        address: '410 Terry Avenue North',
        city: 'Seattle',
        state: 'Washington',
        country: 'USA',
        postalCode: '98109',
        products: 'EC2, S3, RDS, Lambda, CloudFront, Enterprise Support',
        status: 'ACTIVE',
        approvedAt: new Date(),
        approvedBy: admin.id,
        tenantId: tenant.id,
      },
    }),
    prisma.vendor.upsert({
      where: { id: 'vendor-steelcase' },
      update: {},
      create: {
        id: 'vendor-steelcase',
        name: 'Steelcase Inc.',
        categoryId: officeSupplies.id,
        contactPerson: 'Robert Martinez',
        email: 'contracts@steelcase.com',
        phone: '+1-616-247-2710',
        address: '901 44th Street SE',
        city: 'Grand Rapids',
        state: 'Michigan',
        country: 'USA',
        postalCode: '49508',
        products: 'Office Chairs, Desks, Collaborative Furniture, Architectural Walls',
        status: 'ACTIVE',
        approvedAt: new Date(),
        approvedBy: admin.id,
        tenantId: tenant.id,
      },
    }),
    prisma.vendor.upsert({
      where: { id: 'vendor-accenture' },
      update: {},
      create: {
        id: 'vendor-accenture',
        name: 'Accenture',
        categoryId: profServices.id,
        contactPerson: 'Jennifer Lee',
        email: 'procurement@accenture.com',
        phone: '+1-312-693-8000',
        address: '161 North Clark Street',
        city: 'Chicago',
        state: 'Illinois',
        country: 'USA',
        postalCode: '60601',
        products: 'Strategy Consulting, Digital Transformation, Technology Services, Operations',
        status: 'ACTIVE',
        approvedAt: new Date(),
        approvedBy: admin.id,
        tenantId: tenant.id,
      },
    }),
    prisma.vendor.upsert({
      where: { id: 'vendor-local-it' },
      update: {},
      create: {
        id: 'vendor-local-it',
        name: 'Bangalore IT Solutions Pvt Ltd',
        categoryId: itHardware.id,
        contactPerson: 'Ravi Kumar',
        email: 'sales@bangalore-it.com',
        phone: '+91-80-4567-8900',
        address: '123 MG Road',
        city: 'Bangalore',
        state: 'Karnataka',
        country: 'India',
        postalCode: '560001',
        products: 'Laptops, Desktops, Network Equipment, AMC Services',
        status: 'ACTIVE',
        approvedAt: new Date(),
        approvedBy: admin.id,
        tenantId: tenant.id,
      },
    }),
  ]);

  console.log('✅ Created vendors');

  // Create vendor performance records
  for (const vendor of vendors) {
    await prisma.vendorPerformance.upsert({
      where: { vendorId: vendor.id },
      update: {},
      create: {
        vendorId: vendor.id,
        totalOrders: Math.floor(Math.random() * 50) + 5,
        onTimeDelivery: 85 + Math.random() * 15,
        qualityRating: 4.0 + Math.random() * 1.0,
        responsiveness: 4.0 + Math.random() * 1.0,
        lastOrderDate: new Date(Date.now() - Math.random() * 90 * 24 * 60 * 60 * 1000),
      },
    });
  }

  console.log('✅ Created vendor performance');

  // Create sample procurement requests
  const requests = await Promise.all([
    prisma.procurementRequest.create({
      data: {
        title: '50 Laptops for Bangalore Office',
        description: 'We need 50 laptops for our new Bangalore office by 15 November. Requirements: 16GB RAM, 512GB SSD, 14-inch display, Windows 11 Pro, 3-year warranty. Budget approximately $50,000.',
        categoryId: itHardware.id,
        item: 'Laptop',
        quantity: 50,
        unit: 'units',
        location: 'Bangalore',
        requiredDate: new Date('2024-11-15'),
        specifications: '16GB RAM, 512GB SSD, 14-inch display, Windows 11 Pro, 3-year warranty',
        estimatedBudget: 50000,
        priority: 2,
        status: 'RECOMMENDATION_READY',
        requesterId: requester.id,
        assigneeId: procurementManager.id,
        tenantId: tenant.id,
      },
    }),
    prisma.procurementRequest.create({
      data: {
        title: 'Office 365 Licenses - 200 Users',
        description: 'Annual renewal of Microsoft Office 365 E3 licenses for 200 users. Need volume licensing agreement with monthly billing option.',
        categoryId: software.id,
        item: 'Office 365 E3 License',
        quantity: 200,
        unit: 'licenses',
        location: 'All Offices',
        requiredDate: new Date('2024-12-01'),
        specifications: 'E3 plan with Teams, Exchange, SharePoint, OneDrive',
        estimatedBudget: 48000,
        priority: 1,
        status: 'APPROVED',
        requesterId: requester.id,
        assigneeId: procurementManager.id,
        tenantId: tenant.id,
      },
    }),
    prisma.procurementRequest.create({
      data: {
        title: 'Ergonomic Chairs for Mumbai Office',
        description: '100 ergonomic office chairs for the new Mumbai facility. Must have adjustable lumbar support, armrests, and breathable mesh back. Delivery by end of October.',
        categoryId: officeSupplies.id,
        item: 'Ergonomic Office Chair',
        quantity: 100,
        unit: 'units',
        location: 'Mumbai',
        requiredDate: new Date('2024-10-31'),
        specifications: 'Adjustable lumbar support, 4D armrests, breathable mesh back, 5-year warranty',
        estimatedBudget: 75000,
        priority: 2,
        status: 'QUOTES_RECEIVED',
        requesterId: requester.id,
        assigneeId: procurementManager.id,
        tenantId: tenant.id,
      },
    }),
    prisma.procurementRequest.create({
      data: {
        title: 'Marketing Agency for Q1 Campaign',
        description: 'Looking for a digital marketing agency to manage our Q1 2025 product launch campaign. Scope: social media, content creation, paid ads, analytics. Budget $30,000 - $50,000.',
        categoryId: profServices.id,
        item: 'Digital Marketing Services',
        quantity: 1,
        unit: 'engagement',
        location: 'Remote',
        requiredDate: new Date('2025-01-15'),
        specifications: 'Social media management, content creation, paid advertising, analytics reporting',
        estimatedBudget: 50000,
        priority: 3,
        status: 'VENDORS_IDENTIFIED',
        requesterId: requester.id,
        assigneeId: procurementManager.id,
        tenantId: tenant.id,
      },
    }),
    prisma.procurementRequest.create({
      data: {
        title: 'AWS Enterprise Support - 12 Months',
        description: 'Renewal of AWS Enterprise Support plan for 12 months. Current plan expires March 2025. Need architectural guidance and 24/7 support.',
        categoryId: software.id,
        item: 'AWS Enterprise Support',
        quantity: 1,
        unit: 'subscription',
        location: 'Cloud',
        requiredDate: new Date('2025-03-01'),
        specifications: 'Enterprise tier, 24/7 support, TAM access, architectural reviews',
        estimatedBudget: 120000,
        priority: 1,
        status: 'RFQ_SENT',
        requesterId: requester.id,
        assigneeId: procurementManager.id,
        tenantId: tenant.id,
      },
    }),
  ]);

  console.log('✅ Created procurement requests');

  // Create extracted requirements for the first request
  const laptopRequest = requests[0];
  await prisma.extractedRequirement.create({
    data: {
      requestId: laptopRequest.id,
      category: 'IT Hardware',
      item: 'Laptop',
      quantity: 50,
      unit: 'units',
      location: 'Bangalore',
      requiredDate: new Date('2024-11-15'),
      specifications: '16GB RAM, 512GB SSD, 14-inch display, Windows 11 Pro, 3-year warranty',
      budget: 50000,
      missingFields: [],
      confidence: 0.95,
    },
  });

  // Create RFQs
  const dell = vendors.find(v => v.id === 'vendor-dell')!;
  const hp = vendors.find(v => v.id === 'vendor-hp')!;
  const lenovo = vendors.find(v => v.id === 'vendor-lenovo')!;
  const localIT = vendors.find(v => v.id === 'vendor-local-it')!;

  const rfq1 = await prisma.rFQ.create({
    data: {
      rfqNumber: 'RFQ-2024-0001',
      requestId: laptopRequest.id,
      title: 'RFQ: 50 Laptops for Bangalore Office',
      description: 'Procurement of 50 business laptops for new Bangalore office. Specifications: 16GB RAM, 512GB SSD, 14-inch display, Windows 11 Pro, 3-year on-site warranty.',
      quantity: 50,
      specifications: '16GB RAM, 512GB SSD, 14-inch display, Windows 11 Pro, 3-year on-site warranty',
      deliveryLocation: 'Bangalore Office, 123 Tech Park, Whitefield, Bangalore 560066',
      requiredDeliveryDate: new Date('2024-11-10'),
      submissionDeadline: new Date('2024-10-25'),
      status: 'RESPONSES_RECEIVED',
      createdById: procurementManager.id,
      tenantId: tenant.id,
      vendors: {
        create: [
          { vendorId: dell.id, status: 'RESPONDED', respondedAt: new Date('2024-10-20') },
          { vendorId: hp.id, status: 'RESPONDED', respondedAt: new Date('2024-10-21') },
          { vendorId: lenovo.id, status: 'RESPONDED', respondedAt: new Date('2024-10-22') },
          { vendorId: localIT.id, status: 'RESPONDED', respondedAt: new Date('2024-10-23') },
        ],
      },
    },
  });

  const rfq2 = await prisma.rFQ.create({
    data: {
      rfqNumber: 'RFQ-2024-0002',
      requestId: requests[2].id, // Chairs request
      title: 'RFQ: 100 Ergonomic Chairs for Mumbai Office',
      description: 'Procurement of 100 ergonomic office chairs for Mumbai facility.',
      quantity: 100,
      specifications: 'Adjustable lumbar support, 4D armrests, breathable mesh back, 5-year warranty',
      deliveryLocation: 'Mumbai Office, 456 Business Park, Andheri East, Mumbai 400069',
      requiredDeliveryDate: new Date('2024-10-25'),
      submissionDeadline: new Date('2024-10-15'),
      status: 'RESPONSES_RECEIVED',
      createdById: procurementManager.id,
      tenantId: tenant.id,
      vendors: {
        create: [
          { vendorId: vendors.find(v => v.id === 'vendor-steelcase')!.id, status: 'RESPONDED', respondedAt: new Date('2024-10-10') },
        ],
      },
    },
  });

  console.log('✅ Created RFQs');

  // Create quotes for RFQ-1 (Laptops)
  const quotes1 = await Promise.all([
    prisma.quote.create({
      data: {
        rfqId: rfq1.id,
        vendorId: dell.id,
        unitPrice: 899,
        quantity: 50,
        taxRate: 18,
        taxAmount: 8091,
        freightAmount: 2500,
        installationAmount: 0,
        warrantyMonths: 36,
        deliveryTimelineDays: 14,
        paymentTerms: 'Net 30',
        validityDays: 30,
        otherCharges: 0,
        status: 'SUBMITTED',
        submittedAt: new Date('2024-10-20'),
        tenantId: tenant.id,
      },
    }),
    prisma.quote.create({
      data: {
        rfqId: rfq1.id,
        vendorId: hp.id,
        unitPrice: 949,
        quantity: 50,
        taxRate: 18,
        taxAmount: 8541,
        freightAmount: 2000,
        installationAmount: 0,
        warrantyMonths: 36,
        deliveryTimelineDays: 10,
        paymentTerms: 'Net 45',
        validityDays: 45,
        otherCharges: 0,
        status: 'SUBMITTED',
        submittedAt: new Date('2024-10-21'),
        tenantId: tenant.id,
      },
    }),
    prisma.quote.create({
      data: {
        rfqId: rfq1.id,
        vendorId: lenovo.id,
        unitPrice: 879,
        quantity: 50,
        taxRate: 18,
        taxAmount: 7911,
        freightAmount: 3000,
        installationAmount: 0,
        warrantyMonths: 36,
        deliveryTimelineDays: 21,
        paymentTerms: 'Net 30',
        validityDays: 30,
        otherCharges: 0,
        status: 'SUBMITTED',
        submittedAt: new Date('2024-10-22'),
        tenantId: tenant.id,
      },
    }),
    prisma.quote.create({
      data: {
        rfqId: rfq1.id,
        vendorId: localIT.id,
        unitPrice: 829,
        quantity: 50,
        taxRate: 18,
        taxAmount: 7461,
        freightAmount: 1500,
        installationAmount: 5000,
        warrantyMonths: 36,
        deliveryTimelineDays: 7,
        paymentTerms: 'Net 30',
        validityDays: 30,
        otherCharges: 0,
        status: 'SUBMITTED',
        submittedAt: new Date('2024-10-23'),
        tenantId: tenant.id,
      },
    }),
  ]);

  // Create comparisons for quotes
  for (const quote of quotes1) {
    const basePrice = quote.unitPrice * quote.quantity;
    const totalLandedCost = basePrice + quote.taxAmount + quote.freightAmount + quote.installationAmount + quote.otherCharges;
    
    await prisma.quoteComparison.create({
      data: {
        quoteId: quote.id,
        basePrice,
        taxAmount: quote.taxAmount,
        freightAmount: quote.freightAmount,
        installationAmount: quote.installationAmount,
        otherCharges: quote.otherCharges,
        totalLandedCost,
        deliveryDays: quote.deliveryTimelineDays,
        paymentTerms: quote.paymentTerms,
        warrantyMonths: quote.warrantyMonths,
        validityDays: quote.validityDays,
      },
    });
  }

  // Update ranks
  const sortedQuotes = [...quotes1].sort((a, b) => {
    const aTotal = a.unitPrice * a.quantity + a.taxAmount + a.freightAmount + a.installationAmount + a.otherCharges;
    const bTotal = b.unitPrice * b.quantity + b.taxAmount + b.freightAmount + b.installationAmount + b.otherCharges;
    return aTotal - bTotal;
  });
  
  for (let i = 0; i < sortedQuotes.length; i++) {
    await prisma.quoteComparison.update({
      where: { quoteId: sortedQuotes[i].id },
      data: { rank: i + 1 },
    });
  }

  console.log('✅ Created quotes and comparisons');

  // Create recommendation for laptop request
  await prisma.recommendation.create({
    data: {
      requestId: laptopRequest.id,
      recommendedQuoteId: quotes1.find(q => q.vendorId === localIT.id)!.id,
      reasoning: 'Bangalore IT Solutions offers the lowest total landed cost at ₹4,420,500 with the fastest delivery (7 days). They are a local vendor with on-site installation included. While Dell and Lenovo have slightly lower unit prices, the total cost including freight and installation makes Bangalore IT Solutions the best value. All vendors offer 3-year warranty and Net 30 payment terms.',
      factors: {
        commercial: 'Best total landed cost',
        delivery: 'Fastest delivery (7 days)',
        vendor: 'Local vendor with good track record',
        warranty: 'Standard 3-year warranty from all vendors',
        payment: 'Net 30 terms from all vendors',
      },
      commercialValue: 92,
      deliveryScore: 95,
      specificationScore: 100,
      vendorStatusScore: 88,
      historicalScore: 85,
      benchmarkScore: 90,
      paymentTermsScore: 80,
      warrantyScore: 100,
      riskScore: 15,
      totalScore: 91.25,
    },
  });

  console.log('✅ Created recommendation');

  // Create approval for laptop request
  await prisma.approval.create({
    data: {
      requestId: laptopRequest.id,
      approverId: financeApprover.id,
      status: 'PENDING',
      tenantId: tenant.id,
    },
  });

  console.log('✅ Created approval');

  // Create audit logs
  const auditLogs = [
    { userId: requester.id, action: 'CREATED', entityType: 'ProcurementRequest', entityId: laptopRequest.id, newStatus: 'DRAFT', tenantId: tenant.id, metadata: { title: laptopRequest.title } },
    { userId: requester.id, action: 'SUBMITTED', entityType: 'ProcurementRequest', entityId: laptopRequest.id, previousStatus: 'DRAFT', newStatus: 'SUBMITTED', tenantId: tenant.id },
    { userId: procurementManager.id, action: 'STATUS_CHANGED', entityType: 'ProcurementRequest', entityId: laptopRequest.id, previousStatus: 'SUBMITTED', newStatus: 'REQUIREMENT_EXTRACTED', tenantId: tenant.id, aiRecommendation: 'Extracted: 50 Laptops, Bangalore, Nov 15' },
    { userId: procurementManager.id, action: 'RFQ_CREATED', entityType: 'RFQ', entityId: rfq1.id, tenantId: tenant.id, metadata: { rfqNumber: rfq1.rfqNumber, vendorCount: 4 } },
    { userId: procurementManager.id, action: 'RFQ_SENT', entityType: 'RFQ', entityId: rfq1.id, previousStatus: 'DRAFT', newStatus: 'SENT', tenantId: tenant.id },
    { userId: procurementManager.id, action: 'QUOTE_RECEIVED', entityType: 'Quote', entityId: quotes1[0].id, tenantId: tenant.id, metadata: { vendor: 'Dell', amount: 44950 } },
    { userId: procurementManager.id, action: 'QUOTE_RECEIVED', entityType: 'Quote', entityId: quotes1[1].id, tenantId: tenant.id, metadata: { vendor: 'HP', amount: 47450 } },
    { userId: procurementManager.id, action: 'QUOTE_RECEIVED', entityType: 'Quote', entityId: quotes1[2].id, tenantId: tenant.id, metadata: { vendor: 'Lenovo', amount: 43950 } },
    { userId: procurementManager.id, action: 'QUOTE_RECEIVED', entityType: 'Quote', entityId: quotes1[3].id, tenantId: tenant.id, metadata: { vendor: 'Bangalore IT Solutions', amount: 41450 } },
    { userId: procurementManager.id, action: 'RECOMMENDATION_GENERATED', entityType: 'Recommendation', entityId: laptopRequest.id, tenantId: tenant.id, aiRecommendation: 'Recommended: Bangalore IT Solutions' },
    { userId: procurementManager.id, action: 'CREATED', entityType: 'Approval', entityId: laptopRequest.id, newStatus: 'PENDING', tenantId: tenant.id, metadata: { approver: financeApprover.email } },
  ];

  for (const log of auditLogs) {
    await prisma.auditLog.create({ data: log });
  }

  console.log('✅ Created audit logs');

  console.log('🎉 Database seeding completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });