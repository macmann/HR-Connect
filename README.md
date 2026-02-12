# HR Connect

HR Connect is an all-in-one HR operations platform built with **Node.js**, **Express**, **MongoDB**, and a static front-end served from the same backend.

It supports employee lifecycle workflows such as:

- authentication (local + optional Microsoft SSO),
- employee and profile management,
- leave tracking and accrual,
- public career listings and job applications,
- AI-assisted interview and recruitment workflows,
- learning hub content + role assignment reconciliation,
- payroll/salary endpoints,
- role-based administration,
- post-login external synchronization hooks.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Core Capabilities](#core-capabilities)
3. [Project Structure](#project-structure)
4. [Tech Stack](#tech-stack)
5. [Prerequisites](#prerequisites)
6. [Local Development Setup](#local-development-setup)
7. [Environment Variables](#environment-variables)
8. [Authentication and Authorization](#authentication-and-authorization)
9. [API Surface (High-Level)](#api-surface-high-level)
10. [Scheduled Jobs and Background Processing](#scheduled-jobs-and-background-processing)
11. [Data and Migration Scripts](#data-and-migration-scripts)
12. [Testing](#testing)
13. [Operational Notes](#operational-notes)
14. [Deployment Guide](#deployment-guide)
15. [License](#license)

---

## Architecture Overview

- **Single backend server** (`server.js`) exposes REST endpoints and serves static UI assets from `public/`.
- **MongoDB** is the primary data store via `mongodb` driver.
- **Role-based access controls** are enforced for protected endpoints (`authRequired`, `managerOnly`, `superadminOnly`).
- **Modular API routes** are mounted for HR, public careers, learning hub, and admin role management.
- **Cron jobs** initialize at server startup for leave and role-assignment reconciliation.

---

## Core Capabilities

### 1) Employee + Identity Flows
- Local login using `/login`.
- Session token handling via cookie + JWT-backed user context.
- Optional Microsoft SSO via `/auth/microsoft` and callback flow.
- Profile read/update endpoints (`/api/my-profile`, `/api/my-payslip`, `/api/me`).

### 2) Leave Management
- Leave submission endpoints (multiple compatibility routes).
- Leave balance and entitlement calculations.
- Leave reporting, export, and calendar endpoints.
- Monthly accrual + leave cycle reset cron jobs.

### 3) Recruitment + Careers
- Public career pages and application submission.
- Candidate lifecycle endpoints (status updates, comments, CV streaming).
- Position and role-specific recruitment analytics.
- AI interview and recruitment OpenAPI resources.

### 4) Learning Hub
- Protected learning routes mounted at `/api/learning-hub`.
- Learning role assignment reconciliation support + scheduled sync.

### 5) Administration and Settings
- Admin role management routes (`/api/admin-roles`).
- Widget settings and token generation.
- Email and AI settings APIs.
- Post-login sync settings and integration hooks.

### 6) Pairing/Agent Integrations
- Signed agent pairing initialization, poll, and claim routes.
- Replay/sig tolerance windows and rate-limit tuning through env vars.

---

## Project Structure

```text
HR-Connect/
├── api/                         # Modular route handlers (HR, public, learning, admin)
├── cron/                        # Scheduled jobs (leave accrual/reset, learning sync)
├── public/                      # Static front-end assets (HTML/CSS/JS)
├── scripts/                     # One-off scripts (e.g., leave migration)
├── services/                    # Domain services (leave, learning playback, assignments)
├── utils/                       # Shared helpers (token, uploads, leave/cv parser)
├── db.js                        # DB initialization and shared db access
├── server.js                    # Main application entrypoint
├── pairingStore.js              # Pairing request persistence/index helpers
├── aiSettings.js                # AI settings defaults/load/save utilities
└── README.md
```

---

## Tech Stack

- **Runtime:** Node.js
- **Server:** Express 5
- **Database:** MongoDB (`mongodb` driver)
- **Auth/Token:** `jsonwebtoken`, cookie parsing
- **Uploads and parsing:** `multer`, `pdf-parse`, `csv-parse`
- **Email:** `nodemailer`
- **Scheduling:** `node-cron`
- **UI styling toolchain:** Tailwind CSS + PostCSS + Autoprefixer

---

## Prerequisites

- Node.js 18+ (recommended LTS)
- npm 9+
- MongoDB 6+ (local or managed)

---

## Local Development Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Then edit `.env` and fill values for your environment.

3. **Start development server**

   ```bash
   npm run dev
   ```

4. **Open the app**

   - Default URL: `http://localhost:3000`
   - Careers page: `http://localhost:3000/careers`

5. **Optional: run migration script**

   ```bash
   node scripts/migrateLeaveSystem.js
   ```

---

## Environment Variables

The project ships with a starter `.env.example`. Key groups are summarized below.

### Server and CORS

- `PORT` (default `3000`)
- `BODY_LIMIT` (default `3mb`)
- `SESSION_COOKIE_NAME`
- `SESSION_COOKIE_MAX_AGE`
- `SESSION_COOKIE_SAMESITE`
- `CORS_ALLOWED_ORIGINS` (comma-separated; supports wildcard domain pattern in server logic)

### Admin Bootstrap

- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

### Database

- `MONGODB_URI`
- `MONGODB_DB`
- Optional TLS tuning:
  - `MONGODB_FORCE_TLS`
  - `MONGODB_TLS_MIN_VERSION`
  - `MONGODB_TLS_ALLOW_INVALID_CERTS`
  - `MONGODB_SERVER_SELECTION_TIMEOUT_MS`

### SMTP / Email

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_SECURE`
- `SMTP_FROM`

### Microsoft SSO

- `MS_CLIENT_ID`
- `MS_CLIENT_SECRET`
- `MS_TENANT`
- `MS_REDIRECT_URI`

### Pairing / Agent Security

- `PAIR_AGENT_ID`
- `PAIR_AGENT_SECRET`
- `PAIR_TOKEN_SECRET`
- `PAIR_TOKEN_ISSUER`
- `PAIR_TOKEN_AUDIENCE`
- `PAIR_TOKEN_SCOPE`
- `PAIR_TOKEN_TTL_SECONDS`
- `PAIR_REQUEST_TTL_MIN_SECONDS`
- `PAIR_REQUEST_TTL_MAX_SECONDS`
- `PAIR_POLL_LEASE_SECONDS`
- Rate limits:
  - `PAIR_INIT_RATE_LIMIT`, `PAIR_INIT_RATE_WINDOW_MS`
  - `PAIR_POLL_RATE_LIMIT`, `PAIR_POLL_RATE_WINDOW_MS`
  - `PAIR_CLAIM_RATE_LIMIT`, `PAIR_CLAIM_RATE_WINDOW_MS`
- Signature/replay hardening:
  - `PAIR_AGENT_SIGNATURE_TOLERANCE_MS`
  - `PAIR_AGENT_REPLAY_WINDOW_MS`

### Widget Tokens

- `WIDGET_JWT_SECRET`
- `WIDGET_JWT_EXPIRES_IN`

---

## Authentication and Authorization

### Auth
- Main login endpoint: `POST /login`
- Authenticated routes rely on token/cookie middleware.
- Optional Microsoft login flow starts at `GET /auth/microsoft`.

### Role guards
- **Authenticated user:** `authRequired`
- **Manager+ access:** `managerOnly`
- **Superadmin-only access:** `superadminOnly`

These guards protect sensitive operations such as admin role changes, salary endpoints, and selected settings routes.

---

## API Surface (High-Level)

The backend includes a large set of endpoints. High-level groups:

- **Employee & Profile:** `/employees`, `/api/my-profile`, `/api/me`
- **Performance:** `/api/performance/:employeeId`
- **Leave:** `/applications`, `/api/leaves`, `/api/leave/*`, `/leave-report`, `/leave-calendar`
- **Recruitment:** `/recruitment/*`, `/api/recruitment/*`
- **Public Careers + AI Interview:** `/api/public/*`, `/careers`, `/ai-interview/:token`
- **Learning Hub:** `/api/learning-hub/*`
- **Admin Roles:** `/api/admin-roles/*`
- **Settings:** `/settings/widget`, `/settings/email`, `/settings/ai`, `/settings/post-login`
- **Pairing:** `/pair/init`, `/pair/poll`, `/pair/claim`

For route-level details and request/response shapes, inspect:

- `server.js`
- `api/hrPositions.js`
- `api/hrAiInterview.js`
- `api/hrApplications.js`
- `api/publicCareers.js`
- `api/publicAiInterview.js`
- `api/learningHub.js`
- `api/adminRoles.js`

---

## Scheduled Jobs and Background Processing

On server startup, the app initializes:

- `cron/monthlyLeaveCron.js`
- `cron/resetLeaveCycle.js`
- `cron/learningRoleAssignmentSync.js`

Production guard flags prevent duplicate in-memory cron initialization in common runtime patterns.

---

## Data and Migration Scripts

### Leave system migration

Use this script to backfill/normalize leave balance metadata:

```bash
node scripts/migrateLeaveSystem.js
```

This is intentionally manual so operators can control rollout timing.

---

## Testing

Run the native Node test suite:

```bash
npm test
```

Current repository tests include service-level leave accrual coverage.

---

## Operational Notes

- Ensure secrets in `.env` are set to strong random values in non-dev environments.
- Do not expose bearer tokens in front-end code for production integrations; proxy through backend where possible.
- Verify CORS and cookie policy together, especially behind reverse proxies and custom domains.
- Upload paths are served from `/uploads`; confirm persistent storage strategy in production.

---

## Deployment Guide

For a complete production deployment walkthrough (VM provisioning, process manager, reverse proxy, TLS, zero-downtime rollout, backup/restore, and troubleshooting), see:

- [`DEPLOYMENT.md`](DEPLOYMENT.md)

---

## License

This project includes a `LICENSE` file at repository root.
