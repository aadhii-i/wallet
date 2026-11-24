# Contribution and review records

This section records our implementation work, its evidence, and the next steps
for supervisor reviews. Ownership is described by workstream, not by lines of
code or commit count. Shared work and inherited architecture are identified
explicitly.

## Current review pack

- [Supervisor contribution report](QD-Wallet-Contribution-Report.md)
- [Evidence and validation record](evidence-2026-11-24.md)
- [Milestone log](milestone-log.md)
- [Integration checkpoint](../changes/2026-11-24-main-integration.md)

PDF copies are private reference and manual-submission artifacts; they are kept
outside the repository. The Markdown reports remain the versioned source.

The earlier [project progress report](../QD-Wallet-Progress-Report.md)
describes an earlier stage. In particular, its statement that device-to-server
Threshold Raccoon signing is pending has been superseded by the integrated
shared-wallet implementation. Use the current review pack for the November
integration review; retain the earlier report as a historical record.

## Maintaining these records

For every completed development milestone, add a dated milestone-log entry
covering the problem, delivered behavior, contribution boundary, validation,
remaining limitations, and the next action. Link the implementation or its
change note from the evidence record. Record a pass only after observing it;
identify skipped tests and local simulators explicitly.

Keep the supervisor report concise and update its review date when its claims
change. Regenerate and visually inspect the submission PDF from the same text.
Keep detailed implementation references in the evidence record rather than in
the supervisor narrative. Never include passwords, recovery phrases, private
keys, provider credentials, or private wallet data in any record.

## Development principles

Our target is a usable wallet suitable for eventual release, with post-quantum
threshold authorization supported by evidence. Research prototypes and
conventional blockchain signatures must remain clearly distinguished.
Password protection, key storage, recovery, session handling, transaction
confirmation, and dependency security are part of release assessment.

Preserve Adhil's agreed base architecture. Obtain project-owner approval before
changing that architecture or its protocol assumptions. Record flaws and
proposed alternatives openly. Use clear names and focused code; document
security assumptions, invariants, and non-obvious decisions without duplicating
every statement in comments. A passing test suite is not a security audit.
