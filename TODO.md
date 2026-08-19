# TODO

Security improvements reviewed but not yet implemented (decided to do performance first — see git log).

## Security

- [x] **Signed email links** — DONE in this branch: `/email/:id` links now carry `?t=<HMAC-SHA256(secret, mailId)>`
      when `LINK_TOKEN_SECRET` is set; bad/missing token → 404. Unset = previous behavior.
- [ ] **Real delete** — the Delete button only hides the Discord message; the KV cache lives until
      `MAIL_TTL`. Purge `Mail:<id>` via `ctx.waitUntil` on delete. (When merging `feat/attachments`,
      also purge `Att:<id>:*`.)
- [ ] **/init GET with ?secret=** — the secret can end up in access logs; accept POST + header only.

## Nice-to-have

- [ ] AbortSignal.timeout on the OpenAI/Workers AI fetch (currently unbounded).
