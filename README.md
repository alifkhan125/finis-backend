# PremierDD Backend API

Construction management backend built with **NestJS**, **Prisma**, **PostgreSQL**, **S3**, **Resend**, and **PDF export support**.

This README is written for developers who want to integrate the API from a frontend, mobile app, or another backend service.

---

## What This Backend Covers

- Admin and super admin dashboards
- Companies, projects, floors, units, team, tasks, subtasks
- Payroll and expense management
- Reports and PDF export
- Mailbox send/reply + inbound webhook processing
- Notifications
- File uploads to S3
- Role-based access control

---

## Local Setup and Connection

The backend is the central service for both sibling clients:

- `finis-dashboard` connects through `VITE_API_BASE_URL`
- `finis` connects through `EXPO_PUBLIC_API_BASE_URL`
- REST and Socket.IO use the same backend origin and port

The default local API address is .env .

### Requirements

- Node.js 20 or 22
- pnpm
- PostgreSQL
- JDK/Android tooling is not required for the backend

### Install and configure

```bash
cd ~/Desktop/project/finis/finis-backend
pnpm install
cp .env.example .env
```

Set at least these values in `.env`:

```dotenv
PORT=6000
DATABASE_URL="postgresql://user:password@localhost:5432/finis_db?schema=public"
JWT_SECRET="replace_with_a_long_random_secret"
FRONTEND_URL="http://localhost:5173"
```

`FRONTEND_URL` must be the dashboard origin. Stripe uses it for checkout
success and cancellation redirects.

Configure Stripe, Resend, S3/R2, and Firebase variables from `.env.example`
only when their related features are needed. Never commit the real `.env`.

### Prepare Prisma/PostgreSQL

Create the PostgreSQL database referenced by `DATABASE_URL`, then run:

```bash
pnpm exec prisma generate
pnpm exec prisma db push
```

Open Prisma Studio when database inspection is needed:

```bash
pnpm exec prisma studio
```

Prisma Studio normally opens at `http://localhost:5555`.

### Run locally

```bash
pnpm dev
```

The API listens on all interfaces at port `6000`, so an emulator, physical
phone, or another computer can connect when the firewall/network allows it.

### Build and production

```bash
pnpm build
pnpm start:prod
```

### Stripe webhook during local development

Stripe cannot send events directly to `localhost`. Use the Stripe CLI:

```bash
stripe listen --forward-to localhost:6000/subscription/webhook
```

Copy the displayed `whsec_...` value into `STRIPE_WEBHOOK_SECRET`, then restart
the backend. Alternatively, expose port `6000` through an HTTPS tunnel and set
this endpoint in Stripe:

```text
https://YOUR-BACKEND-TUNNEL/subscription/webhook
```

The webhook is a `POST` endpoint; opening it in a browser sends `GET` and is
expected to return `Cannot GET /subscription/webhook`.

### Verify the connection

With the backend running, a request to .env should reach
NestJS. A `404` JSON response at `/` still proves the server is reachable when
no root route is defined. Confirm database access by opening Prisma Studio or
using a real login/API request from either client.

---

## Core Conventions

### Authentication

- Most routes require `Authorization: Bearer <token>`
- Auth token is a JWT
- `auth_user` is stored client-side in the frontend

### Roles

Main roles used across the app:

- `super_admin`
- `admin`
- `manager`
- `worker`

### API Response Pattern

Most endpoints return an envelope like:

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Request successful",
  "data": {}
}
```


Some endpoints may return raw JSON or binary responses, such as PDF downloads.

### Date Format

- Dates are sent as ISO strings in query/body
- Example: `2026-07-01T00:00:00.000Z`

### File Uploads

- Use `multipart/form-data`
- Common file fields:
  - `file`
  - `beforePhoto`
  - `afterPhoto`
  - `receipt`

---

## Role Scope

### Admin

- Sees only own companies and their related projects, workers, payroll, expenses, reports
- Admin report endpoints do not require `companyId` or `projectId`

### Super Admin

- Sees all companies and all related records
- Can optionally scope reports using `companyId` and sometimes `projectId`

---

## Main Modules

### Dashboard

- `GET /super-admin/dashboard`
- `GET /super-admin/dashboard/recent-activity`
- `GET /super-admin/dashboard/workforce-status`
- `GET /super-admin/dashboard/attendance-summary`
- `GET /super-admin/dashboard/attendance-records`

### Companies

Admin:

- `GET /admin/companies`
- `GET /admin/companies/:id`
- `POST /admin/companies`
- `PUT /admin/companies/:id`
- `DELETE /admin/companies/:id`

Super admin:

- `GET /super-admin/companies`
- `GET /super-admin/companies/:id`
- `POST /super-admin/companies`
- `PUT /super-admin/companies/:id`
- `DELETE /super-admin/companies/:id`

### Projects

Admin:

- `GET /admin/projects`
- `GET /admin/projects/:id`
- `POST /admin/projects`
- `PUT /admin/projects/:id`
- `DELETE /admin/projects/:id`
- `GET /admin/projects/:id/floor-plan`
- `PUT /admin/projects/:id/rooms/:unitId`
- `DELETE /admin/projects/:id/rooms/:unitId`

Super admin:

- `GET /super-admin/projects`
- `GET /super-admin/projects/:id`
- `POST /super-admin/projects`
- `PUT /super-admin/projects/:id`
- `DELETE /super-admin/projects/:id`

### Workforce

- `GET /workers`
- `GET /workers/:id`
- `POST /workers`
- `PUT /workers/:id`
- `DELETE /workers/:id`

### Time Tracking

- `GET /time-tracking/attendance`
- `GET /time-tracking/adjustments`
- `POST /time-tracking/adjustments`
- `PUT /time-tracking/adjustments/:id`
- `PATCH /time-tracking/adjustments/:id/approve`
- `PATCH /time-tracking/adjustments/:id/reject`
- `GET /time-tracking/schedules`

### Payroll

- `GET /payroll/records`
- `POST /payroll/calculate`
- `PATCH /payroll/records/:id/approve`
- `GET /payroll/config`
- `PUT /payroll/config`

### Inventory

- `GET /inventory`
- `POST /inventory`
- `PUT /inventory/:id`
- `DELETE /inventory/:id`

### Chat / Messaging

- `GET /chat/conversations`
- `GET /chat/conversations/:conversationId/messages`
- `POST /chat/conversations/:conversationId/messages`
- `POST /chat/conversations/:conversationId/read`

### Mailbox

- `POST /mail/send`
- `GET /mailbox`
- `GET /mailbox/:conversationId`
- `POST /mailbox/:conversationId/favorite`
- `DELETE /mailbox/:conversationId/favorite`

Mailbox reply flow is already wired so the frontend can:

- upload a PDF directly while sending
- send without a separate upload API
- save and resend the same PDF attachment

### Webhook

- `POST /webhook/inbound`

Inbound email webhook uses **Svix signature verification**.

Required headers:

- `svix-id`
- `svix-timestamp`
- `svix-signature`

If one of these is missing, the server returns:

- `400 Missing webhook signature`

---

## Reports API

Reports are available for both `admin` and `super_admin`.

### Report Types

- `payroll`
- `project_invoices`
- `worker_performance`
- `expense`

### Frequency Values

- `daily`
- `weekly`
- `monthly`
- `quarterly`
- `yearly`

### Admin Reports

Admin routes use the admin scope automatically.
No `companyId` or `projectId` is needed.

- `GET /admin/reports/generate`
- `GET /admin/reports`
- `GET /admin/reports/export`

Example:

```http
GET /admin/reports/generate?type=project_invoices&frequency=monthly&startDate=2026-06-01&endDate=2026-06-30
```

### Super Admin Reports

Super admin routes can see all companies.
Optional `companyId` and `projectId` can be used where supported.

- `GET /super_admin/reports/generate`
- `GET /super_admin/reports`
- `POST /super_admin/reports/generate`
- `GET /super_admin/reports/export`

Example:

```http
GET /super_admin/reports/generate?type=expense&frequency=monthly&startDate=2026-06-01&endDate=2026-06-30&companyId=COMPANY_ID
```

### Export Format

- `export` endpoints return a **PDF**
- `generate` endpoints return **JSON**

### Important Report Notes

- Payroll and payroll-related deductions were configured so `grossPay = netPay`
- No amount is deducted in the current payroll calculation flow
- Admin report views are scoped to the admin's own company data
- Super admin sees all admin/company data together

---

## Reports Integration Example

### Generate JSON Report

```ts
const res = await fetch(`${baseUrl}/admin/reports/generate?type=payroll&frequency=monthly&startDate=2026-06-01&endDate=2026-06-30`, {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const data = await res.json();
```

### Download PDF Export

```ts
const res = await fetch(`${baseUrl}/admin/reports/export?type=payroll&startDate=2026-06-01&endDate=2026-06-30`, {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const blob = await res.blob();
```

---

## Mail Send Flow

`POST /mail/send` accepts:

- sender info
- recipient email
- subject
- optional PDF attachment
- optional body content

Current behavior:

- PDF is uploaded to S3
- Mail can be sent with the uploaded attachment
- No separate upload endpoint is needed for mail sending

Example multipart form fields:

- `from`
- `to`
- `subject`
- `body`
- `file`

---

## Frontend Integration Notes

If you are integrating from the React dashboard:

- `ReportsPage` uses backend report endpoints directly
- `DashboardPage` links to `/reports`
- `Schedule` is currently UI-only
- `Export All` downloads a PDF

Recommended flow:

1. Select report type
2. Select frequency
3. Pick start and end dates
4. Call `generate`
5. Use `export` when you need a PDF file

---

## Frontend Route Map

The dashboard frontend routes live in:

- `Finis-Pro-Dashboard/src/app/router.tsx`

Common routes:

- `/`
- `/reports`
- `/projects`
- `/companies`
- `/workforce`
- `/time-tracking`
- `/geofencing`
- `/chat`
- `/inventory`

---

## Environment Variables

The authoritative template is `.env.example`. Main groups are:

- Server: `PORT`, `DATABASE_URL`, `JWT_SECRET`, `FRONTEND_URL`
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- Mailbox: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`,
  `MAILBOX_FROM_EMAIL`, `MAILBOX_REPLY_DOMAIN`
- Storage: `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`,
  `S3_REGION`, `R2_ENDPOINT`, `R2_PUBLIC_URL`
- Push notifications: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
  `FIREBASE_PRIVATE_KEY`

Client variables such as `VITE_API_BASE_URL` and
`EXPO_PUBLIC_API_BASE_URL` belong in their respective client `.env` files, not
in the backend `.env`.

---

## Pagination

Some list endpoints support pagination through:

- `page`
- `limit`

Example:

```http
GET /mailbox?page=1&limit=20&status=active
```

---

## Common Status Values

### Mailbox

- `active`
- `closed`

### Conversation favorite

- `favorite`
- `unfavorite`

### Payroll

- `draft`
- `approved`
- `paid`

### Expense

- `pending`
- `approved`
- `rejected`

### Reports

- `payroll`
- `project_invoices`
- `worker_performance`
- `expense`

---

## Integration Rules

When adding a new endpoint:

1. Add the backend route
2. Update the frontend endpoint map
3. Keep the response envelope consistent
4. Add the TypeScript type near the feature that uses it
5. If the endpoint returns a file, set proper headers

When adding a new report:

1. Add the type to the DTO enum
2. Add service logic
3. Update frontend report selector
4. Update PDF export formatting if needed

---

## Useful References

- Backend report controller: `premierdd/src/super-admin/reports/reports.controller.ts`
- Backend report service: `premierdd/src/super-admin/reports/reports.service.ts`
- Admin report controller: `premierdd/src/admin/reports/reports.controller.ts`
- Frontend reports page: `Finis-Pro-Dashboard/src/features/reports/pages/ReportsPage.tsx`
- Frontend endpoint map: `Finis-Pro-Dashboard/src/services/api/endpoints.ts`

---

## Notes

- `generate` returns data
- `export` returns PDF
- Admin does not send `companyId` or `projectId`
- Super admin may scope reports by company when needed
- Mailbox webhook must be signed by Svix headers

If you want, I can also add a separate `docs/API_REFERENCE.md` with endpoint-by-endpoint request/response examples.
