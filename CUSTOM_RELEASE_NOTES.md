# Custom OpenClaw 2026.8.35-D

Candidate based on custom 8.35-C. Compilation does not switch the running Gateway. UI, package/plugin versions, dependency locks, and database schema versions remain on 2026.8.35. All C/A/B fixes and custom apt/entrypoint settings are retained.

## D backports

| Official PR                                                | Adaptation and boundary                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [140388](https://github.com/openclaw/openclaw/pull/140388) | Retry only proven pre-tunnel proxy failures; an accepted CONNECT followed by connection loss stays ambiguous.                                                                                                                                                                                                                                                     |
| [156842](https://github.com/openclaw/openclaw/pull/156842) | New Telegram text/rich-text sends use fresh connections; polling, edits, proxy/DNS policy and cleanup retain their owners.                                                                                                                                                                                                                                        |
| [168738](https://github.com/openclaw/openclaw/pull/168738) | Ordinary inbound final text opts into one saved-text replay after a typed ambiguous transport failure, at most two total sends. No model/tool rerun. Media, controls, untyped errors, accepted partial/identityless results remain excluded. Existing synchronous 8.35 queue owns retry, custody and settlement; no newer worker architecture or schema imported. |
| [169010](https://github.com/openclaw/openclaw/pull/169010) | Startup/reconnect scans exclude active producers before claiming local recovery ownership.                                                                                                                                                                                                                                                                        |
| [165444](https://github.com/openclaw/openclaw/pull/165444) | Cron/hooks forward existing catalog-backed model thinking capability; no global/task effort or native Codex upgrade.                                                                                                                                                                                                                                              |
| [164633](https://github.com/openclaw/openclaw/pull/164633) | Per-agent context limits merge defaults field by field.                                                                                                                                                                                                                                                                                                           |
| [169029](https://github.com/openclaw/openclaw/pull/169029) | Doctor validates raw UTF-8 before and after archiving duplicate memory files, preserving invalid bytes rather than rewriting replacement characters.                                                                                                                                                                                                              |

## Delivery limits

Saved-final replay accepts the possibility of one duplicate when Telegram accepted a message but its response was lost. This is not delivery reconciliation. Permission is granted only by the ordinary inbound final dispatcher; cron/invest and command-mediated completion coverage is not claimed. Old queue records acquire no replay permission automatically. Existing partial-send protection and exact claim/timestamp fences remain authoritative. Exhausted failures retain the 8.35 dispatcher notice lifecycle.

No production Telegram messages, broker access, investment rule changes, task enabling, or memory resets are part of building this candidate. Loopback HTTP and SQLite checks establish transport/queue behavior, not live Telegram or provider-account availability. Live Telegram Test Server credentials are unavailable for this maintenance checkout; no real-group message is sent as a substitute.

## Previous C release

# Custom OpenClaw 2026.8.35-C

Candidate built from the custom 8.35-B source. This source release does not switch an existing installation to the candidate image.

## Added backports

| Upstream                                                    | Behavior                                                                                         | Adaptation to 8.35                                                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#168400](https://github.com/openclaw/openclaw/pull/168400) | Recover a missing streamed Codex answer tail from authoritative completed-item text.             | Keep the assistant text map private; reconcile through the existing assistant projection and await it at the completion caller. Equal or divergent completed text is not appended.                        |
| [#169728](https://github.com/openclaw/openclaw/pull/169728) | Recognize DeepSeek `calls` wrappers and separator variants, and hide DSML in direct replies.     | Share the existing wrapper grammar between recovery and filtering. Direct calls filter text without recovering tools; managed calls retain existing terminal, cancellation, size, and tool-policy checks. |
| [#166782](https://github.com/openclaw/openclaw/pull/166782) | Avoid repeatedly parsing a complete long answer after a settled reply directive.                 | Adapt to 8.35's existing incremental reply-text owner. Ambiguous Markdown, new directives, media, and terminal messages retain canonical parsing.                                                         |
| [#135653](https://github.com/openclaw/openclaw/pull/135653) | Explicitly reset derived memory indexes and embedding cache without deleting canonical sessions. | Use existing 8.35 locks, schema definitions, and maintenance validation; preserve the custom provider guard and incremental maintenance behavior.                                                         |

All previous A/B backports and build customizations are retained. UI source, dependency versions, and database schema versions remain on the custom 8.35 baseline. Upstream package/plugin version remains `2026.8.35`; Docker labels and build identity identify `2026.8.35-C`.

## Memory reset

Inspect the command before using it:

```sh
openclaw memory reset --help
```

Reset one agent's derived index explicitly, then rebuild normally:

```sh
openclaw memory reset --agent <agent-id> --yes
openclaw memory index --agent <agent-id>
```

Interactive confirmation defaults to no; non-interactive resets require `--yes`. This command is not run during compilation or deployment. It does not recover previously deleted history, shrink the database file, or perform a privacy purge. Never delete the shared agent SQLite database or its sidecars to reset memory.

## Scope and validation limits

Speech transcription, skipped-cron configuration, September UI changes, and newer database migrations are excluded. Existing investment schedules and rules are unchanged.

Regression evidence must distinguish baseline failures from fixed owner/sibling suites and compiled artifact checks. Synthetic loopback transport and SQLite tests do not establish live provider-account availability or live Telegram delivery. The pre-existing ambiguity when a provider emits both valid DSML and equivalent native tool calls is not given a new deduplication policy by this backport.
