# AVCLPR P0 Production Readiness

## Implemented in the P0 hardening branch

1. Legacy unauthenticated server/default admin removed.
2. Browser-history dashboard routing added.
3. User administration API/UI added.
4. PostgreSQL audit log storage/query/viewer added.
5. Server-side site authorization added to sites, cameras, events, alerts, evidence and audit queries.
6. AI service authentication is mandatory in production.
7. Server-side sessions, idle timeout, expiry and revocation added.
8. TOTP MFA required for privileged roles.
9. Watchlist CRUD and audit logging added.
10. Camera registration/update/delete and audit logging added.
11. PostgreSQL is the authoritative production control plane; SQLite is edge-only.
12. Request validation, payload limits and auth/MFA rate limiting added.
13. HTTPS reverse-proxy configuration and SPA routing fallback added.
14. Production secret requirements documented; deployment must connect them to the approved government secret manager.
15. Evidence access authorization, access logs, hashes and retention-hold fields added.
16. PostgreSQL backup/restore scripts and automated CI restore verification added.
17. Authenticated Prometheus-compatible metrics and monitoring requirements added.
18. Automated CI/security test plan added; independent penetration testing remains an acceptance gate.

## Remaining acceptance gates

- Run `npm install` to regenerate the lockfile after adding `pg` and `@types/pg`; then run CI.
- Provision PostgreSQL and apply migrations.
- Configure the approved government secret manager and certificate/PKI infrastructure.
- Perform a full deployed security assessment/penetration test.
- Test backup restoration against the real production evidence and database environment.
- Validate evidence object storage, retention deletion and legal-hold workflows.
- Validate AI accuracy and multi-camera performance under the pilot workload.

P0 means the engineering foundation is hardened; it does not mean the system is automatically approved for national operational use.
