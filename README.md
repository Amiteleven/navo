# NAVO - Autonomous Procurement Agent

> **Tell Navo what you need. Navo does the procurement work.**

NAVO is a production-quality B2B SaaS application that automates the procurement workflow for companies. It allows employees to submit natural-language procurement requests and autonomously manages the entire process from requirement extraction to vendor selection, RFQ creation, quote comparison, and approval.

## 🎯 Core Workflow

```
REQUEST → REQUIREMENT → VENDORS → RFQ → QUOTES → COMPARISON → RECOMMENDATION → APPROVAL
```

## ✨ Features

### For Requesters
- **Natural Language Input**: Describe needs in plain English - "We need 50 laptops for Bangalore office by Nov 15"
- **AI Requirement Extraction**: Automatically extracts category, item, quantity, location, dates, specs, budget
- **Missing Information Detection**: Identifies and asks only for necessary missing details
- **Real-time Status Tracking**: Visual procurement journey with clear business-language stages

### For Procurement Managers
- **Vendor Master Management**: Complete vendor database with categories, contacts, performance tracking
- **Automated RFQ Creation**: Generate professional RFQs from approved requirements
- **Vendor Communication**: Controlled vendor invitation and quote collection
- **Smart Quote Comparison**: Normalized total landed cost comparison (base + tax + freight + installation + other)

### For Finance Approvers
- **Approval Dashboard**: Pending approvals with full context
- **AI Recommendations**: Data-driven vendor recommendations with clear reasoning
- **Commercial Analysis**: Total landed cost, delivery, warranty, payment terms, risk factors
- **Audit Trail**: Complete history of every decision and action

### Enterprise Features
- **Multi-Tenant Architecture**: Complete data isolation between companies
- **Role-Based Access Control**: Platform Admin, Company Admin, Procurement Manager, Finance Approver, Requester, Viewer
- **JWT Authentication**: Secure token-based auth with refresh tokens
- **Comprehensive Audit Logging**: Every significant action recorded with user, timestamp, and context

## 🏗️ Architecture

```
navo/
├── packages/
│   ├── backend/          # Express.js + TypeScript + Prisma + PostgreSQL
│   ├── frontend/         # React 18 + TypeScript + Vite + Tailwind CSS
│   └── shared/           # Shared types, schemas, utilities
```

### Backend Stack
- **Runtime**: Node.js 20+ with TypeScript
- **Framework**: Express.js with Helmet, CORS, Rate Limiting
- **Database**: PostgreSQL with Prisma ORM
- **Authentication**: JWT (Access + Refresh tokens) with bcrypt
- **AI Integration**: OpenAI GPT-4 for requirement extraction & recommendations
- **Validation**: Zod schemas shared with frontend

### Frontend Stack
- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite 5
- **Styling**: Tailwind CSS with custom design system
- **State Management**: TanStack Query (React Query) for server state
- **Routing**: React Router v6
- **Forms**: React Hook Form with Zod validation
- **UI Components**: Custom accessible component library

## 🚀 Getting Started

### Prerequisites
- Node.js 20+
- PostgreSQL 15+
- pnpm (or npm/yarn)

### Installation

```bash
# Clone and install dependencies
cd navo
pnpm install

# Set up environment variables
cp packages/backend/.env.example packages/backend/.env
cp packages/frontend/.env.example packages/frontend/.env

# Edit packages/backend/.env with your database URL and JWT secrets
# DATABASE_URL="postgresql://user:pass@localhost:5432/navo"
# JWT_SECRET="your-super-secret-key-min-32-chars"
# JWT_REFRESH_SECRET="your-refresh-secret-min-32-chars"

# Generate Prisma client and push schema
cd packages/backend
pnpm db:generate
pnpm db:push

# Seed with demo data
pnpm db:seed

# Start development servers
cd ../..
pnpm dev
```

### Demo Credentials
After seeding, you can log in with:
- **Admin**: admin@demo.com / password123
- **Procurement Manager**: procurement@demo.com / password123
- **Finance Approver**: finance@demo.com / password123
- **Requester**: requester@demo.com / password123

### Access URLs
- Frontend: http://localhost:5173
- Backend API: http://localhost:3000
- Prisma Studio: `pnpm db:studio` (backend)

## 📁 Project Structure

### Backend (`packages/backend/`)
```
src/
├── config/           # Configuration management
├── middleware/       # Auth, tenant isolation, validation, error handling
├── modules/
│   ├── auth/         # Authentication (login, register, JWT)
│   ├── tenants/      # Tenant/company management
│   ├── requests/     # Procurement requests CRUD + workflow
│   ├── vendors/      # Vendor master + performance
│   ├── rfqs/         # RFQ creation + vendor invitation
│   ├── quotes/       # Quote submission + comparison
│   ├── approvals/    # Approval workflow + AI recommendations
│   ├── audit/        # Audit logging
│   ├── categories/   # Procurement categories
│   └── ai/           # OpenAI integration
├── utils/            # Prisma client, JWT, errors
└── index.ts          # Express app entry point
```

### Frontend (`packages/frontend/`)
```
src/
├── components/
│   ├── layout/       # Sidebar, Header, MainLayout, AuthLayout
│   └── ui/           # Reusable UI components (Button, Input, Card, Table, Modal, etc.)
├── pages/            # Page components (Home, Requests, Vendors, RFQs, Quotes, Approvals, Reports, Settings)
├── context/          # React Context (AuthContext)
├── hooks/            # Custom React hooks
├── services/         # API client (axios with interceptors)
├── types/            # TypeScript interfaces
└── utils/            # Utility functions
```

### Shared (`packages/shared/`)
```
src/
├── types/            # TypeScript interfaces matching Prisma models
├── schemas/          # Zod validation schemas
└── index.ts          # Barrel exports
```

## 🔐 Multi-Tenancy & Security

- **Tenant Isolation**: Enforced at database level via `tenantId` on all models
- **Middleware Enforcement**: Backend middleware validates tenant access on every request
- **Role-Based Access**: 6 roles with granular permissions
- **Platform Admin**: Cross-tenant access for platform operations
- **Audit Trail**: Immutable logs for compliance

## 🤖 AI Features

### Requirement Extraction
Input: "We need 50 laptops for our Bangalore office by 15 November."
Output:
```json
{
  "category": "IT Hardware",
  "item": "Laptop",
  "quantity": 50,
  "location": "Bangalore",
  "requiredDate": "2024-11-15",
  "specifications": null,
  "budget": null,
  "missingFields": ["specifications", "budget"],
  "confidence": 0.9
}
```

### Recommendation Engine
Analyzes quotes across:
- Commercial value (30%)
- Delivery timeline (20%)
- Specifications compliance (15%)
- Vendor approval & history (15%)
- Payment terms (10%)
- Warranty (5%)
- Risk factors (5%)

## 📋 API Endpoints

### Authentication
- `POST /api/auth/register` - Register company + admin user
- `POST /api/auth/login` - Login
- `POST /api/auth/refresh` - Refresh access token
- `GET /api/auth/profile` - Get current user
- `POST /api/auth/change-password` - Change password

### Procurement Requests
- `GET /api/requests` - List with filters/pagination
- `POST /api/requests` - Create request
- `GET /api/requests/:id` - Get request with relations
- `PATCH /api/requests/:id` - Update request
- `POST /api/requests/:id/submit` - Submit for processing
- `POST /api/requests/:id/extract` - AI requirement extraction
- `PATCH /api/requests/:id/status` - Update status

### Vendors
- `GET /api/vendors` - List with filters
- `POST /api/vendors` - Create vendor
- `GET /api/vendors/:id` - Get vendor with performance
- `PATCH /api/vendors/:id` - Update vendor
- `GET /api/vendors/search?q=` - Search vendors

### RFQs
- `GET /api/rfqs` - List RFQs
- `POST /api/rfqs` - Create RFQ
- `GET /api/rfqs/:id` - Get RFQ with vendors/quotes
- `POST /api/rfqs/:id/send` - Send to vendors
- `POST /api/rfqs/:id/close` - Close RFQ

### Quotes
- `GET /api/quotes` - List quotes
- `POST /api/quotes` - Submit quote (vendor)
- `GET /api/quotes/rfq/:rfqId/comparison` - Get commercial comparison
- `POST /api/quotes/:id/comparison` - Create comparison

### Approvals
- `GET /api/approvals` - List approvals
- `POST /api/approvals` - Create approval request
- `POST /api/approvals/:id/decide` - Approve/Reject/Changes
- `POST /api/approvals/request/:id/recommendation` - Generate AI recommendation
- `GET /api/approvals/request/:id/recommendation` - Get recommendation

## 🧪 Development

```bash
# Run tests
pnpm test

# Lint
pnpm lint

# Type check
cd packages/backend && pnpm build
cd packages/frontend && pnpm build

# Database studio
cd packages/backend && pnpm db:studio
```

## 📦 Production Deployment

### Backend
```bash
cd packages/backend
pnpm build
# Set production env vars
NODE_ENV=production
# Run migrations
pnpm db:migrate deploy
# Start
pnpm start
```

### Frontend
```bash
cd packages/frontend
pnpm build
# Serve dist/ with nginx or static hosting
```

### Docker (Optional)
```dockerfile
# Multi-stage builds for backend and frontend
# Use docker-compose for local production-like environment
```

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## 📄 License

Proprietary - NAVO Inc.

## 🆘 Support

- Documentation: `/docs` (coming soon)
- Issues: GitHub Issues
- Email: support@navo.ai

---

**NAVO** - Making procurement autonomous, one request at a time.