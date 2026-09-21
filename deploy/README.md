# AVCLPR Production Deployment

## Network boundary

Government WAN -> TLS reverse proxy (:443) -> Node v2 API (:3100, private only) -> AI engine (:8000, private only) -> PostgreSQL (private database network).

Do not expose ports 3100 or 8000 directly to the Internet.

## Required production configuration

- NODE_ENV=production
- ENVIRONMENT=production
- DATABASE_URL
- PGSSL=require
- AVCLPR_AUTH_SECRET
- AVCLPR_MFA_ENCRYPTION_KEY
- AI_SERVICE_TOKEN
- CORS_ORIGINS
- REQUIRE_HTTPS=true
- TRUST_PROXY=true

Secrets must come from the approved government secret-management system, not source control or frontend build artifacts.

## TLS

Terminate TLS at an approved reverse proxy using approved certificates/PKI. Forward X-Forwarded-Proto: https and keep the API/AI services on private interfaces.

## SPA routing

The dashboard uses browser history routing. The reverse proxy must serve index.html for unknown frontend routes.

## Backups

Back up PostgreSQL and evidence storage separately. Backups must be encrypted, access-controlled, monitored, and restoration-tested.
