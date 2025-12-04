# HR Portal

An HR Connect demo portal that bundles leave management, recruitment, performance tracking, and AI-assisted interviews into a single Express/MongoDB application. The Node.js server exposes secured APIs, schedules cron jobs for leave accrual, and serves the browser-based SPA from the `public/` folder.

## Features

- **Authentication & Sessions** – Cookie-based sessions with configurable names, lifetimes, and SameSite policies plus CORS controls for permitted origins.【F:server.js†L80-L119】
- **Employee & Leave Management** – MongoDB-backed storage with helpers for entitlements, accrual, and balance recalculation, plus a CLI migration utility to normalize balances for existing employees.【F:scripts/migrateLeaveSystem.js†L1-L65】【F:services/leaveAccrualService.js†L1-L25】
- **Recruitment & AI Interview APIs** – Endpoints for positions, applications, and AI-guided interview flows exposed under the `api/` folder.【F:server.js†L51-L56】【F:api/hrApplications.js†L1-L25】
- **Branding & Chat Widget Settings** – Configurable branding assets and chat widget defaults with helper modules to persist settings and manage uploads.【F:server.js†L41-L50】【F:utils/uploadPaths.js†L1-L40】
- **Background Jobs** – Monthly leave accrual and leave cycle reset cron tasks that self-register when the server boots, with production safeguards against duplicate scheduling.【F:server.js†L64-L76】

## Project Structure

- `server.js` – Express app entry point wiring authentication, feature routes, cron jobs, uploads, and middleware configuration.【F:server.js†L3-L120】
- `db.js` – MongoDB connection factory with optional caching and helper utilities to sync collections and settings.【F:db.js†L1-L80】
- `api/` – Route handlers for recruitment, career site, and AI interview endpoints consumed by the SPA.【F:server.js†L51-L56】
- `public/` – Client-side SPA assets (HTML, JS, CSS) loaded after authentication.
- `services/` and `utils/` – Leave accrual logic, entitlement defaults, upload helpers, and other shared utilities.【F:services/leaveAccrualService.js†L1-L25】【F:utils/leaveAccrual.js†L1-L60】
- `cron/` – Scheduled jobs for leave accrual and cycle resets imported by the server at startup.【F:server.js†L64-L76】
- `scripts/` – Maintenance utilities such as the leave migration script.【F:scripts/migrateLeaveSystem.js†L1-L65】

## Prerequisites

- Node.js 18+
- MongoDB instance reachable via `MONGODB_URI` (defaults to `mongodb://localhost:27017`).【F:db.js†L5-L11】
- npm (ships with Node.js)

## Configuration

Set environment variables in a `.env` file or your shell before starting the server. Common options include:

- `MONGODB_URI` – MongoDB connection string (default `mongodb://localhost:27017`).【F:db.js†L5-L11】
- `MONGODB_DB` – Database name (default `hrconnect`).【F:db.js†L5-L11】
- `SESSION_COOKIE_NAME` – Session cookie name (default `session_token`).【F:server.js†L80-L84】
- `SESSION_COOKIE_MAX_AGE` – Cookie lifetime in milliseconds (default 7 days).【F:server.js†L80-L84】
- `SESSION_COOKIE_SAMESITE` – SameSite policy (`lax` by default).【F:server.js†L80-L84】
- `CORS_ALLOWED_ORIGINS` – Comma-separated list of allowed origins (empty allows all).【F:server.js†L85-L119】
- `BODY_LIMIT` – JSON payload limit (default `3mb`).【F:server.js†L90-L107】
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `DEFAULT_EMPLOYEE_PASSWORD` – Override default credentials for seeded users.【F:server.js†L107-L118】
- `EMPLOYEE_CSV_PATH` – Optional CSV path for seeding employees via `import.js`.【F:import.js†L64-L116】

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start a local MongoDB instance or point `MONGODB_URI` to an existing cluster.【F:db.js†L5-L11】
3. Run the development server with hot reload:
   ```bash
   npm run dev
   ```
   The app listens on port 3000 by default via `server.js`.

To launch without nodemon hot reload, use `npm start`.

## Database Seeding

Populate sample employees and users by running the import script. You can provide your own CSV (columns: Name, Email, Role, Status, Department, Position, Location, Annual Leave, Casual Leave, Medical Leave) or rely on the built-in sample data:

```bash
node import.js path/to/employees.csv
```

When no CSV is provided, the script seeds three sample employees and matching user accounts with default passwords.【F:import.js†L7-L116】

## Maintenance & Migrations

Normalize leave balances and entitlements after data changes by running the migration script:

```bash
node scripts/migrateLeaveSystem.js
```

The script recalculates balances for every employee, updates leave cycles, and writes results back to MongoDB.【F:scripts/migrateLeaveSystem.js†L1-L65】

## Testing

Run the Node.js test suite:

```bash
npm test
```

## Production Notes

- Cron tasks run automatically on startup; a production guard prevents duplicate scheduling when clustered.【F:server.js†L64-L76】
- Consider setting stricter CORS origins and secure cookie attributes in production environments.【F:server.js†L80-L119】
- Place branding assets and chat widget uploads under the configured upload roots if customizing the portal’s UI.【F:utils/uploadPaths.js†L1-L40】
