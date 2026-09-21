# AVCLPR Production Monitoring

Minimum monitored signals:

- API availability and HTTP 5xx rate
- PostgreSQL connectivity, connection pool saturation and storage growth
- AI service availability
- Camera worker count, reconnects and dropped frames
- Edge outbox depth and oldest pending event age
- Event ingestion rate
- OCR/detection failures
- Evidence storage usage
- Authentication failures and account lockouts
- Watchlist changes and alert acknowledgement activity

The application health endpoint is a liveness/dependency check. Production monitoring should scrape a dedicated metrics endpoint and send alerts to the approved operations/SIEM platform.

Suggested alert thresholds:

- API unavailable: immediate
- PostgreSQL unavailable: immediate
- AI unavailable: immediate
- Edge queue age > 15 minutes: warning
- Edge queue age > 60 minutes: critical
- Disk usage > 80%: warning; > 90%: critical
- Camera disconnected > 5 minutes: warning
- Repeated authentication failures: security alert
