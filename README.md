# mail2discord

> [!NOTE]
> The `feat/attachments` branch adds attachment handling (KV storage, download links, Discord upload). It is **not deployed** and **not merged to `main`** — production still runs the `main` branch without attachment support. See [Attachments](#attachments) for details.

Use a Discord bot (or plain webhook) to get your temporary email.

`mail2discord` is a [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/) Worker that converts incoming emails into rich Discord messages — a Discord-flavored take on [TBXark/mail2telegram](https://github.com/TBXark/mail2telegram), written from scratch.

```
Email (anything@your-domain.com)
        │
        ▼
Cloudflare Email Routing (catch-all)
        │
        ▼
mail2discord Worker
        │   ├── parse (postal-mime) ──► cache in Workers KV
        │   ├── backup forward (optional)
        │   └── notify ──► Discord channel embed with buttons
        ▼
Email → ✉️ → Discord
```

## Features

- **Unlimited disposable addresses** — every prefix of your catch-all domain lands in Discord
- **Two modes**
  - **Bot mode** — embed with interactive buttons (`Preview` / `Summary` / `Text` / `HTML` / `Debug` / `Delete`), slash commands, verified interactions
  - **Webhook mode** — zero-bot setup, notification only (URL buttons)
- **AI summary** — Workers AI or any OpenAI-compatible API
- **Block/white lists** — exact address or regex, managed via `/mail` slash commands or env vars
- **Backup forwarding** — copy every mail to a real inbox via `FORWARD_LIST`
- **Guardian mode** — deduplicates Cloudflare's email retries
- **Safety** — cached HTML view is escaped and inert; mail cache expires via `MAIL_TTL`

## Setup

### 0. Create a Discord application

Bot mode (recommended):

1. <https://discord.com/developers/applications> → **New Application**
2. **Bot** tab → copy the **bot token** (`DISCORD_TOKEN`), enable **Message Content Intent** if you use text-based fallbacks
3. Invite the bot to your server (OAuth2 URL Generator, scope `bot` + `applications.commands`, permission *Send Messages*)
4. Copy the **Public Key** from the **General Information** tab (`DISCORD_PUBLIC_KEY`)
5. Note the **channel ID** where mail should land (`DISCORD_CHANNEL_ID`, enable Developer Mode → right-click channel → Copy ID)

Webhook mode (quick start):

1. Channel settings → **Integrations** → **Webhooks** → **New Webhook** → copy the URL (`DISCORD_WEBHOOK_URL`)
2. Done — no bot, no commands; only URL buttons are available

### 1. Deploy the Worker

CLI:

```bash
git clone <this repo>
cd mail2discord
npm install
cp wrangler.example.jsonc wrangler.jsonc   # fill in your KV namespace id + vars
npx wrangler kv namespace create DB        # create the KV, paste the id
npm run deploy
```

Copy-paste (no CLI): open `build/index.js`, paste it into a new Worker in the Cloudflare dashboard, then set the variables and bind a KV namespace named `DB`.

### 2. Bind the interaction endpoint (bot mode)

- Call `https://<your-worker>.workers.dev/init` once — registers the `/mail` slash commands
- In the Discord Developer Portal set **Interactions Endpoint URL** to `https://<your-worker>/discord`
- Discord shows "Interactions endpoint URL" verified after its PING succeeds

### 3. Configure Cloudflare Email Routing

1. Follow the [official guide](https://developers.cloudflare.com/email-routing/get-started/) for your domain
2. **Email Routing → Routing Rules → Catch-all address** → action **Send to a Worker** → `mail2discord`
3. If you want backups, add the address to `FORWARD_LIST` and verify it under **Destination addresses**

## Configuration

Location: Workers & Pages → your worker → Settings → Variables

| KEY | Description |
|:--|:--|
| `DISCORD_TOKEN` | Bot token (bot mode) |
| `DISCORD_CHANNEL_ID` | Comma-separated channel IDs to deliver to (bot mode) |
| `DISCORD_WEBHOOK_URL` | Webhook URL (webhook mode) — when set, bot delivery is skipped |
| `DISCORD_PUBLIC_KEY` | Application public key — verifies interaction signatures |
| `DOMAIN` | Worker domain, e.g. `mail2discord.you.workers.dev` |
| `FORWARD_LIST` | Backup emails (comma-separated); must be verified destination addresses |
| `BLOCK_LIST` | JSON array of addresses/regex, e.g. `[".*@spam\\.io"]` |
| `WHITE_LIST` | JSON array of addresses/regex; whitelist always wins |
| `BLOCK_POLICY` | `reject,forward,discord` — comma-separated actions for blocked mail. Default `discord` |
| `MAIL_TTL` | Cache TTL seconds (default `86400`); after expiry, view links die |
| `MAX_EMAIL_SIZE` | Bytes; larger mail hits `MAX_EMAIL_SIZE_POLICY` (default `524288`) |
| `MAX_EMAIL_SIZE_POLICY` | `unhandled` / `truncate` / `continue` (default `truncate`) |
| `WORKERS_AI_MODEL` | e.g. `@cf/meta/llama-3.1-8b-instruct`; needs the `AI` binding |
| `OPENAI_API_KEY` | For summaries when Workers AI isn't bound |
| `OPENAI_COMPLETIONS_API` | Default `https://api.openai.com/v1/chat/completions` |
| `OPENAI_CHAT_MODEL` | Default `gpt-4o-mini` |
| `SUMMARY_TARGET_LANG` | Default `english` (e.g. `thai`) |
| `ATTACHMENTS` | Set `false` to keep attachment metadata only. Default: enabled |
| `MAX_ATTACHMENT_SIZE` | Max bytes per stored attachment. Default `8388608` (8 MiB) |
| `MAX_ATTACHMENT_COUNT` | Max stored attachments per mail. Default `10` |
| `DISCORD_UPLOAD_ATTACHMENTS` | `true` to upload attachments as Discord files with the notification. Default: links only |
| `GUARDIAN_MODE` | `true` to dedupe retried deliveries (more KV writes) |
| `DEBUG` | `true` adds a `Debug` button |
| `DB` | KV binding — **Variable name must be `DB`** |

## Slash commands (bot mode)

| Command | Description |
|:--|:--|
| `/mail blocklist add <pattern>` | Block a sender (address or regex) |
| `/mail blocklist remove <pattern>` | Unblock |
| `/mail blocklist` | List entries |
| `/mail whitelist add <pattern>` / `remove` / (none) | Same for the white list |
| `/mail test <address>` | Check an address against both lists |

List rules: whitelist wins over blocklist; entries match exact (case-insensitive) or as regex (`i` flag).

## Message flow

```
┌─────────────────────────────────────┐
│ Hello from the test                 │  ← embed title = subject
│ From: sender@example.com   To: …    │  ← fields
│ [Preview] [Summary] [Text] [HTML]   │  ← buttons (bot mode)
└─────────────────────────────────────┘
```

- **Preview** — plain text inline (≤ 4096 chars)
- **Summary** — AI summary (Workers AI or OpenAI-compatible)
- **Text / HTML** — opens `https://<DOMAIN>/email/<id>?mode=text|html`; HTML is escaped
- **Delete** — tombstones the notification
- Links die after `MAIL_TTL` seconds — use `FORWARD_LIST` for anything you need to keep

## Attachments

> [!WARNING]
> This section applies to the `feat/attachments` branch only. On `main` (deployed), attachments are not supported — forward mail to a real inbox via `FORWARD_LIST` if you need them.

Attachments are extracted (postal-mime) and stored per-mail in KV alongside the cache:

- The notification embed gets an **📎 Attachments** field with size + download links (`https://<DOMAIN>/email/<id>?att=N`, dies with `MAIL_TTL`)
- The web preview page lists every attachment with download links
- `DISCORD_UPLOAD_ATTACHMENTS=true` uploads the files themselves as Discord attachments (multipart), so they live in Discord even after the cache expires — same limits as a normal message (8 MiB each, 10 total by default, tunable via `MAX_ATTACHMENT_SIZE` / `MAX_ATTACHMENT_COUNT`)
- Inline / related parts (cid images, tracking pixels) are **not** stored; they are listed under 📎 Skipped with the reason. Set `ATTACHMENTS=false` to keep metadata only
- Downloads are served with `Content-Disposition: attachment` + `nosniff` — files are never rendered or executed by the browser
- Truncated mail (see `MAX_EMAIL_SIZE_POLICY`) is flagged in the embed: attachments may be incomplete

## Local development

```bash
npm install
npm run typecheck
npm test
npm run build      # bundle to build/index.js
npm run dev        # wrangler dev --email for local email testing
```

## Credits & license

- Architecture inspired by [TBXark/mail2telegram](https://github.com/TBXark/mail2telegram) (MIT)
- This project: MIT — see [LICENSE](./LICENSE)
