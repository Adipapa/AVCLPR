# AVCLPR Evidence Governance

Evidence is security-sensitive operational data.

Production policy must define:

- retention period by evidence class
- legal/operational hold process
- deletion authorization
- evidence export authorization
- chain-of-custody requirements
- hash verification
- access logging
- backup/restore treatment
- storage encryption

No evidence should be deleted solely because a local edge disk is full. Edge cleanup must honor the authoritative retention/hold policy and record the deletion action.
