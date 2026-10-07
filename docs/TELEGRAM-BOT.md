# Telegram alerts

Creators (and anyone else with a linked wallet) can get their task alerts in
Telegram: deadline reminders, "deadline passed", and the task status changes
that already appear in the in-app bell. It is **opt-in, removable, and carries
no task content**.

Status: built and tested against mocks. **Not yet run against the real Telegram
API**: no bot exists yet and this was written in a sandbox that cannot reach
Telegram. Treat the "Setup" and "Verify" steps below as the first real test.

## What it sends

| Alert | When | Source |
|---|---|---|
| Deadline approaching | 24 h and 1 h before the deadline, for a task still open, being worked, or waiting for review | `a2aExpirySweep.ts` via `deadlineReminders.ts` |
| Deadline passed | Task closed unclaimed, or the agent missed the deadline | existing `expired` notices |
| Task accepted / result submitted / completed / verification failed | As they happen | existing `notifyLifecycle` |
| Dispute ruled | When a dispute ruling refunds the poster (a ruling for the worker arrives as "completed") | `notifyLifecycle` from `disputeListener.ts`, in the `indexer` process |

Reminders are once per task per window (`notifyOnce` keys `remind:<task>:<seconds>`),
so restarts and API replicas cannot double-send. A reminder only fires for a
mark the task lived through: the sweep records when it first saw each task
(`notif:seen:remind:<task>`) and skips a mark that had already passed by then.
So a task posted with the default 24 h deadline gets no "24 hours left" message
right after posting, only the 1 h one later. A reminder also only fires while the
task is freshly inside its window; a sweep outage longer than the window's grace
(3 h for the 24 h mark, 15 min for the 1 h mark) skips that reminder rather than
sending a late one.

Tasks posted together get one reminder message. Arc has no batch create yet,
so **Post many** sends one transaction per task, and their deadlines end up
minutes apart. When one of a poster's reminders goes out, that poster's other
tasks whose same mark is at most 15 min away are reminded in the same sweep
tick (`REMINDER_PULL_AHEAD_SEC`). The Telegram outbox then merges them into one
message. The copy stays true: 75 min is "about an hour". A task posted later is
never pulled in on its own; it waits for its own mark.

Open-submission tasks (`docs/OPEN-SUBMISSION-TASKS.md`, behind
`OPEN_SUBMISSION_ENABLED`, off until the escrow upgrade) add these. Only
"Submissions" is a new type, offered in Settings only while open submission
is on; the rest reuse the types above, so their toggles cover them:

| Alert | Type | To | When |
|---|---|---|---|
| First submission on your task | `submissions` | poster | the first agent submits |
| New submissions on your task ("N agents have submitted so far") | `submissions` | poster | at most once an hour while submissions are open |
| Submissions closed (with how many submitted, and who picks) | `submissions` | poster | the deadline passes; the count is the escrow's |
| No submissions came in | `expired` | poster | the deadline passes with nobody submitted |
| Pick a winner soon | `deadline_soon` | poster | an hour before the poster's pick window ends |
| Winner picked — escrow released | `completed` | poster | a winner is paid |
| Your submission won | `completed` | winner | a winner is paid |
| Another submission was picked | `failed` | every other submitter | a winner is paid |
| Task closed with no winner — escrow refunded / No submission was picked | `completed` / `failed` | poster / submitters | a judge voids the task |

They carry counts and fixed copy only, never a result or an agent address.
Sources: `openSubmissionEvents.ts` (from the escrow's events, in the indexer)
and `openSubmissionSweep.ts` (the deadline summary and pick reminder).

## Privacy

A Telegram message leaves the platform's access control, so it is built from a
whitelist (`formatNotification` in `services/telegram.ts`), not from the whole
notification:

- **Sent:** the notice's fixed title, a short task id (`0xabcdef12…`), and a link
  into the app (which needs a sign-in). The deadline reminders and "deadline
  passed" notices also include their generic one-line body.
- **Never sent:** a brief, task title, result, or any agent address. The in-app
  bodies for accepted/submitted/failed notices contain a shortened agent address,
  so they are deliberately not forwarded. This is covered by a test.
- The same text goes out for public and private tasks.

Linking a chat to a wallet ties a Telegram account to that wallet in this
server's Redis, and Telegram itself sees the messages. That is why it is opt-in
and why it can be removed from either side.

## How linking works

1. A signed-in user presses **Connect Telegram** in Settings. The server mints a
   single-use nonce bound to their wallets (valid 10 minutes) and returns
   `https://t.me/<bot>?start=<nonce>`.
2. They open it and press **Start**. Telegram calls the webhook with `/start <nonce>`;
   the server consumes the nonce and links that chat to those wallets.
3. Only a **private chat** can link (a group would show alerts to everyone in it).
   A chat already connected to other wallets is not switched by a new link: the
   user must send `/stop` first. Otherwise anyone could send someone their own
   link and take over that person's alerts.
4. **Disconnect** in Settings, or `/stop` in the chat, removes the link and the
   chat's preferences. A chat that blocks the bot is unlinked automatically.

Bot commands: `/start <nonce>`, `/status`, `/stop`, `/help`.

Redis keys: `tg:link:<wallet>`, `tg:chat:<chatId>`, `tg:prefs:<chatId>`,
`tg:nonce:<nonce>`, `tg:nonce-of:<wallet>`, `tg:update:<id>`.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and note the token and
   the username.
2. Add to the backend's environment file (see `backend/.env.example`):
   ```
   TELEGRAM_BOT_TOKEN=<token from BotFather>
   TELEGRAM_WEBHOOK_SECRET=<random string, A-Z a-z 0-9 _ - only, up to 256 chars>
   TELEGRAM_BOT_USERNAME=<bot username without the @>
   ```
   Generate the secret with, for example, `openssl rand -hex 32`.
3. Apply it to both backend services, which share that file:
   ```
   docker compose up -d --force-recreate api indexer
   ```
   `api` serves the webhook and sends most alerts. `indexer` runs the chain
   event loops, which send the dispute-ruling alerts; recreating only `api`
   leaves it without the token, so those alerts never reach Telegram. A plain
   restart does not pick up new settings.
4. Point Telegram at the webhook once. The URL must be public HTTPS:
   ```
   curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d "url=<PUBLIC_API_URL>/api/v1/telegram/webhook" \
     -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
     -d 'allowed_updates=["message"]'
   ```
   Telegram then sends the secret back in the `X-Telegram-Bot-Api-Secret-Token`
   header and the server refuses any request without it.
5. Optionally set the bot's description and command list in BotFather.

With no `TELEGRAM_BOT_TOKEN` the feature is off: the Settings card is hidden and
the webhook answers 503. With a token but no secret, the webhook answers 503.

## Verify (first real run)

- [ ] `getWebhookInfo` shows the URL and no `last_error_message`.
- [ ] Settings shows **Connect Telegram**; pressing it opens the bot; **Start**
      makes the page switch to the toggles on its own.
- [ ] `/status` in the chat lists your shortened wallet.
- [ ] Post a task with a deadline about 2 hours out: no reminder right away;
      a "Deadline approaching" message arrives once, at about 1 hour left.
- [ ] Toggle "Deadline approaching" off: the next reminder does not arrive.
- [ ] **Disconnect Telegram** (or `/stop`): nothing further is sent.
- [ ] Read a received message end to end: it must contain no brief, title or
      agent address.

## Operating notes

- **Webhook, not polling,** so several API instances do not each poll Telegram.
- **Rate limiting.** The webhook sits behind the global per-IP limiter (100 a
  minute). Only bot commands come in (notifications go out), and Telegram sends
  from a small set of addresses, so a very busy bot could hit it. If that
  happens, exempt `/api/v1/telegram/webhook` in `middleware/rateLimit.ts`; the
  secret check is cheap.
- **Rotating the token or secret.** Change the env value, recreate both
  services (`docker compose up -d --force-recreate api indexer`), and run
  `setWebhook` again with the new secret.
- **Bursts become one message.** Bulk-posted tasks share a deadline, so their
  reminders and expiry notices fall due together. Each chat has an in-memory
  outbox. Alerts wait until none has arrived for 5 s, or for at most 30 s
  after the first, and then go out as one message per kind of notice. One
  alert reads as before. Several become "Deadline approaching (20 tasks)" with
  up to 10 task links and a count of the rest. A repeat for the same task is
  sent once.
- **Waiting never overrides consent.** Before each message, and again before
  each retry after a 429, the chat's linked wallets and preferences are read
  again:
  - after `/stop` or **Disconnect**, nothing that was still waiting goes out;
  - a type switched off is skipped;
  - a wallet moved to another chat is no longer reported to the old one.
- **Order.** A newer alert for the same task and wallet replaces a waiting one
  of another kind, so "Payout credited" is never followed by a stale
  "Submission didn't pass".
- **Pacing.** Messages to one chat are at least 1.1 s apart, and sends from
  one process at least 40 ms apart. That stays under Telegram's limits of
  about 1 a second per chat and 30 a second per bot. The API and the indexer
  each pace their own sends.
- **Failures never block** the in-app notification or the sweep. A send is
  tried up to 3 times. An alert waits out Telegram's `retry_after` for up to
  60 s; a bot-command reply waits at most 5 s. After the last try it gives up
  with a log line. Logs redact the bot token.
- **Delivery is best effort, at most once per notice.** The outbox lives in
  memory. A restart drops whatever is waiting, which is at most 30 s of
  alerts. If Telegram is down for longer than the retries, that alert is not
  sent. Either way, the notice is still in the in-app feed.
- The reminder windows are constants in `services/deadlineReminders.ts`.

## Code map

- `services/telegram.ts`: send, message format, the per-chat outbox (`deliverToTelegram`), webhook commands.
- `services/telegramStore.ts`: links, preferences, nonces (Redis).
- `routes/telegram.ts`: `POST /webhook`, `POST /link`, `GET /status`, `PUT /prefs`, `DELETE /link`.
- `services/notificationStore.ts`: `notify()` calls `deliverToTelegram` after the feed write.
- `services/deadlineReminders.ts` and `services/a2aExpirySweep.ts`: reminder windows and where they are sent.
- Frontend: `components/settings/TelegramAlerts.tsx`, `services/telegram.ts`.
