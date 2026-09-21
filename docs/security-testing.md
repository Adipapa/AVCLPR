# AVCLPR Security Test Plan

## Automated baseline

1. TypeScript build/typecheck
2. Python compile/import checks
3. Dependency vulnerability scan
4. Secret scan
5. API authentication tests
6. RBAC tests for every privileged endpoint
7. Site-access isolation tests
8. Session revocation tests
9. MFA replay/expiry/rate-limit tests
10. Input-validation and request-size tests
11. AI service authentication tests
12. Evidence authorization tests

## Manual penetration test

Before government production acceptance, an independent security assessor must test the deployed system. Scope should include the reverse proxy, dashboard, API, AI service, PostgreSQL exposure, authentication, RBAC/site isolation, evidence access, watchlists, file upload endpoints, RTSP credential handling and administrative workflows.

The external penetration test is an acceptance gate; passing code-level tests is not a substitute for an independent assessment.
