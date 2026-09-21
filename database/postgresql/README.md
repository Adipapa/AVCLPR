# AVCLPR PostgreSQL Production Database

PostgreSQL is the authoritative production control plane.

Apply migrations in filename order:

1. 001_initial_schema.sql
2. 002_security_and_sessions.sql

Required production controls:

- TLS for PostgreSQL connections.
- Dedicated least-privilege application role.
- Encrypted backups.
- Tested restore procedure.
- Monitoring for connection saturation, disk growth and replication/backup health.
- No application secrets stored in this repository.
- Database migrations must be reviewed and applied through the deployment process.

Edge SQLite databases are for local buffering/offline operation only; they are not the national authoritative user, RBAC, audit or watchlist database.
