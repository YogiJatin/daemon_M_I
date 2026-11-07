# UI Audit: Personal AI OS Dashboard
Audited: 2026-11-07 | Viewports: 390px (Mobile) & 1280px (Desktop) | Auth: Requires Telegram `/pair` 6-digit code

## 1. Control Audit Table

| Screen | Label / Control | Expected Behavior | Actual Behavior | Status |
|---|---|---|---|---|
| Header | ☰ Mobile Menu Toggle | Opens sidebar drawer on mobile | Toggles sidebar overlay smoothly | WORKS |
| Header | OS Core Badge | System branding glyph | Static pill badge | WORKS |
| Header | Scheduler PresenceRing | Shows tick delta and QoS % | Displays live QoS; hidden on mobile | WORKS |
| Header | Command... (Ctrl+K) | Opens multimodal command modal | Opens CommandLayer modal | WORKS |
| Header | ☼ / ☽ Theme Toggle | Switches dark/light theme | Inverts root class cleanly | WORKS |
| Sidebar | Focus Mode | Navigate to Today / Focus view | Routes to `/` TodayView | WORKS |
| Sidebar | Inbox & Proposals | Navigate to Proposals inbox | Routes to `/inbox` | WORKS |
| Sidebar | Memory (nav tab) | View stored facts/memories | Shows TaskListView (`/tasks`) | CONFUSING |
| Sidebar | Academy | View weekly class timetable | Full grid view, redundant on phone | REDUNDANT |
| Sidebar | Timeline | View cryptographic audit chain | Hash ledger, developer/audit only | REDUNDANT |
| Sidebar | Teach Mode | Record desktop actions | Desktop macro recorder, no mobile backend | UNNECESSARY |
| Sidebar | Safe Browser | Isolated browser session | Desktop-only sandbox, inactive on mobile | UNNECESSARY |
| Sidebar | Execution Queue | Tier 2 desktop execution approvals | No mobile execution backend | UNNECESSARY |
| Sidebar | System | Subsystem health vitals | Should be integrated into Settings | REDUNDANT |
| Sidebar | Settings | Pauses, policies, active session | Routes to `/settings` | WORKS |
| Sidebar | Pairing | Connect phone/device via code | Redundant when authenticated | REDUNDANT |
| Sidebar | Quick Panel | Mini dashboard view | Duplicate of TodayView | REDUNDANT |
| Today | Ambient Banner | Date & IST live clock | Formats IST date and time correctly | WORKS |
| Today | Inspect Oldest → | Open inspector for overdue task | Opens bottom sheet inspector | WORKS |
| Today | Done (✓) | Complete overdue/due task | Calls `api.completeTask`, refreshes | WORKS |
| Today | Snooze (⏱) | Open snooze duration modal | Opens modal with +15m,+1h,+3h,tomorrow | WORKS |
| Today | Task Row Click | Inspect task details | Opens Inspector sheet | WORKS |
| Today | Suggest Next (✨) | Call AI advisory for task recommendation | Fetches LLM proposal or shows error | WORKS |
| Today | Attention Budget Bar | Shows sent / daily cap (8) | Displays live progress bar | WORKS |
| Tasks | Add Directive Input | Create new task from text | Calls `api.createTask` (plain text only) | WORKS |
| Tasks | Open / Completed / All | Filter task list by status | Filters rows correctly | WORKS |
| Tasks | Filter Memory Input | Search tasks by title | Client-side search filters rows | WORKS |
| Inbox | Pending / Confirmed / Rejected | Filter proposals by status | Queries `api.getProposals(status)` | WORKS |
| Inbox | Approve & Create (✓) | Convert proposal to active task | Calls `api.confirmProposal`, removes card | WORKS |
| Inbox | Reject (✕) | Dismiss proposal with reason | Calls `api.rejectProposal`, removes card | WORKS |
| Settings | Pause/Resume Reminders | Toggle Rule 13 master pause | Updates `settings.reminders_paused` | WORKS |
| Settings | Enable Notifications | Register Web Push via VAPID | Prompts when VAPID missing | WORKS |
| Settings | Scheduler Invariants | Policy display (IST, Quiet hours) | Static policy display | WORKS |
| Settings | Active PWA Session | Displays user ID and cookie status | Shows session details | WORKS |
| Pair | Pair Device Button | Authenticate with 6-digit code | Calls `/api/v1/auth/pair`, stores token | WORKS |
| Inspector | Complete Directive | Mark task completed from sheet | Calls `completeTask` and closes | WORKS |
| Inspector | Snooze Presets | Snooze task from inspector sheet | Calls `snoozeTask` and closes | WORKS |

## 2. Issues & Anomalies Recorded

- **Missing Dedicated Memory View**: Sidebar "Memory" opened `TaskListView` (tasks). Real `memory_objects` from D1 (facts, preferences, notes) had no dedicated UI.
- **Navigation Overload**: 11 navigation links in sidebar caused clutter on 390px mobile screens. Redundant/desktop tabs (`TeachMode`, `SafeBrowser`, `ExecutionQueue`, `QuickPanel`) had no mobile use case.
- **Tap Targets**: Mobile button targets on certain filter chips and table controls were under 44px (`sm:min-h-[28px]` used without mobile override).
- **Responsive Width**: Quick-add input on Tasks view lacked `flex-1` full-width responsiveness on 360px viewport.
- **Port 27124 / Relay Grep**: Clean. Zero occurrences of `27124`, `browser-relay`, or `localhost` found in `src/`.
- **InnerHTML / Sanitization**: Clean. Zero occurrences of `dangerouslySetInnerHTML` or `innerHTML` across frontend code.

## 3. Plan for U1 Consolidation

1. Consolidate to **5 primary navigation tabs**:
   - `Today`: Ambient briefing, overdue tasks, due today, next class, attention budget, AI advisor.
   - `Tasks`: Directives management, quick add, status filters (open/completed/all), snooze & complete.
   - `Inbox`: Human-in-the-loop proposals from Voice/OCR/Telegram ingress with approve/reject.
   - `Memory`: Authoritative memory objects from D1 (facts, context, preferences) with trust & privacy badges.
   - `Settings`: Reminders master pause gate, Web Push fallback, System Health (Status), and Devices (Desktop mirror & pairing).
2. Hide redundant/unnecessary panels (`TeachMode`, `SafeBrowser`, `ExecutionQueue`, `QuickPanel`, `TimetableGrid`, `AuditTimeline`) from navigation.
3. Mobile-first: Ensure `min-h-[44px]` for all clickable elements, `overflow-x-hidden`, responsive forms.
