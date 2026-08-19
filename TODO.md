# TODO

Security improvements reviewed but not yet implemented (decided to do performance first — see git log).

## Security

- [ ] **Signed email links** — `/email/:id` is public: anyone with the URL can read the mail
      (OTP / reset links!). Add an HMAC token to the link (`LINK_TOKEN_SECRET` env), 404 without it.
- [ ] **Real delete** — the Delete button only hides the Discord message; the KV cache lives until
      `MAIL_TTL`. Purge `Mail:<id>` via `ctx.waitUntil` on delete. (When merging `feat/attachments`,
      also purge `Att:<id>:*`.)
- [ ] **/init GET with ?secret=** — the secret can end up in access logs; accept POST + header only.

## Nice-to-have

- [ ] AbortSignal.timeout on the OpenAI/Workers AI fetch (currently unbounded).
