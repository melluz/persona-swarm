# Waves: Harbor Desk

A campaign of small waves against one app, each starting from where the last one left the
database. Wave 1 builds the app up from empty; later waves use and stress what it built. After each
wave: triage the run, add confirmed problems to `known-issues.yaml`, tick the coverage below, and
write the next wave for what is still untouched.

Accounts: Admin 1–2 (`admin-1`, `admin-2`), Agent 1–3 (`agent-1` … `agent-3`), Customer 1–2
(`customer-1`, `customer-2`). All seeded and made up.

## Coverage (wave that first touched it)

Admin
- [x] Team: invite agents, roles (wave 1)
- [x] Queues and routing rules (wave 1)
- [x] Saved replies (macros) (wave 1)
- [ ] Business hours and SLA timers
- [x] Customer import from CSV, including a broken file (wave 1)
- [ ] Reports: first response time, tickets per queue, export
- [ ] Audit log

Agent
- [x] Shared inbox: filters, assign to me (wave 1)
- [x] Reply with a macro, internal note (wave 1)
- [ ] Merge duplicates, close, reopen
- [x] Keyboard shortcuts (wave 2)

Customer
- [x] Send a ticket with an attachment (wave 1)
- [ ] Reply to an answer, rate the answer

Access
- [x] Keyboard only (wave 2)
- [x] Screen reader (wave 2)
- [x] No colour vision (wave 2)
- [ ] 200% zoom, phone

## Waves

| Wave | Focus | Personas |
| --- | --- | --- |
| 1 | Setup from empty, then first tickets | 2 admins, then 2 customers and 1 agent |
| 2 | Assistive input on the inbox and the admin screens | 4 |
