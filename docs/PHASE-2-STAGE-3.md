# AVCLPR Phase 2 — Stage 3 Acceptance Guide

## Scope completed

This stage establishes the government application foundation for:

- Multi-site registration
- Multi-camera registration under sites
- Authentication
- Password hashing with bcrypt
- Signed bearer tokens using HMAC-SHA256
- Account lockout after repeated failed logins
- Government RBAC roles
- Permission checks on protected APIs
- Audit event recording
- Secure bootstrap of the first administrator
- PostgreSQL central schema for production migration

## Important architecture decision

`server.ts` remains the existing AVCLPR prototype server.

`server-v2.ts` is the new production-foundation API and currently runs independently on port `3100` by default. This avoids breaking the working RTSP prototype while the production control plane is developed.

The SQLite database is currently used as the local edge/pilot control-plane store. `database/postgresql/001_initial_schema.sql` defines the central PostgreSQL target for the production deployment.

## Required environment

Copy `.env.example` to `.env` and set:

- `AVCLPR_AUTH_SECRET` — at least 32 random characters
- `AVCLPR_BOOTSTRAP_SECRET` — one-time administrator bootstrap secret
- `CORS_ORIGINS` — only trusted dashboard origins
- `DATABASE_URL` — central PostgreSQL connection for the next repository layer

Do not commit `.env`.

## Start the foundation API

```bash
npm install
npm run dev:v2
```

The API will listen on:

`http://localhost:3100`

## First administrator bootstrap

Call `POST /api/v2/auth/bootstrap` once with:

```json
{
  "bootstrapSecret": "YOUR_BOOTSTRAP_SECRET",
  "username": "administrator",
  "displayName": "AVCLPR System Administrator",
  "password": "A-long-random-password"
}
```

The password must contain at least 12 characters.

After the first account is created, normal access uses `/api/v2/auth/login`.

## Login

`POST /api/v2/auth/login`

```json
{
  "username": "administrator",
  "password": "A-long-random-password"
}
```

The response contains a bearer token. Send it as:

```text
Authorization: Bearer <token>
```

## Protected APIs

### Sites

- `GET /api/v2/sites`
- `POST /api/v2/sites`

### Cameras

- `GET /api/v2/cameras`
- `GET /api/v2/cameras?siteId=<site-id>`
- `POST /api/v2/cameras`

### Identity

- `GET /api/v2/auth/me`

### Health

- `GET /api/v2/health`

## Government roles

- SUPER_ADMIN
- NATIONAL_ADMIN
- POLICE
- TRANSPORT
- PURA
- GICTA
- INTELLIGENCE
- ANALYST
- OPERATOR
- VIEW_ONLY

The policy is defined in `src/lib/rbac-policy.ts`.

## Acceptance criteria

Stage 3 is accepted when all of the following pass:

1. No default `admin/admin123` account exists in the new control plane.
2. The first administrator is created only with the bootstrap secret.
3. Passwords are stored only as bcrypt hashes.
4. Login issues a signed, time-limited bearer token.
5. Invalid credentials are rejected.
6. Five consecutive failed attempts lock the account temporarily.
7. Protected endpoints reject requests without a valid token.
8. Users without the required permission receive HTTP 403.
9. Site creation is restricted to authorized administrative roles.
10. Camera creation is restricted to authorized administrative roles.
11. Authentication and privileged actions generate audit records.
12. CORS is restricted to configured origins.
13. Camera credentials are represented by `credential_ref`, not plaintext passwords, in the new control-plane schema.

## Not yet production-complete

This stage intentionally does not claim final government production readiness. The next stage must replace the central repository with PostgreSQL, add real audit querying, integrate the AI event contract, harden WebSocket authentication, add MFA, and connect the dashboard to the new authenticated API.
