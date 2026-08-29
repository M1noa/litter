# security policy

## supported versions

only the latest `main` is supported with security fixes. this project is a
self-hosted file host; if you run it, keep it updated to the current snapshot
published on the public mirror.

## reporting a vulnerability

please report security issues **privately**. do not open a public issue or PR for
a vulnerability.

- email: security@minoa.cat
- you can also reach out via the contact listed on the project site
  (litter.minoa.cat)

include:

- a description of the issue and its impact
- steps to reproduce, or a proof of concept
- affected version / commit

i will acknowledge within a few days and work with you on a fix and coordinated
disclosure.

## scope notes

litter stores files in a telegram chat you control and metadata in your
postgresql database. things to keep in mind when self-hosting:

- protect your `.env` (tokens, telegram api credentials, db string). anyone with
  the `TOKENS` value can use your api.
- `REQUIRE_API_AUTH=false` (default) leaves public upload/download open; only
  admin routes require a token. set `REQUIRE_API_AUTH=true` to lock the whole api
  down, but note this also breaks the built-in web ui uploader.
- telegram bot tokens and user sessions are sensitive; they live in `*.session`
  files and must never be committed or shared.
- the public mirror is a history-free snapshot. do not rely on its commit history
  for provenance — see the repo's `AGENTS.md` (private) for the real workflow.
