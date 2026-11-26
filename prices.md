# Prices

USD per million tokens, per model id, each row in force from its date until a later row for the same id. `node bin/llmtop.mjs` uses them to spread the host's recorded cost over requests, to estimate a session the host left without a cost record, and to check the host's figures; it never replaces a cost the host recorded. A cache write the host did not split into 5m and 1h is priced as a 1h write.

When `scan` reports that a model misses this table, run `node bin/llmtop.mjs prices`, check the fitted prices against the provider's price list, and add a row from the day the price changed. Never edit a row in place: earlier days keep their price.

| model | from | input | output | cache read | cache write 5m | cache write 1h |
| --- | --- | --- | --- | --- | --- | --- |
| claude-opus-5-5 | 2026-10-01 | 4 | 20 | 0.20 | 5 | 8 |
| claude-sonnet-5-5 | 2026-10-01 | 2 | 10 | 0.10 | 2.50 | 4 |
| claude-haiku-5-5 | 2026-10-01 | 0.10 | 0.50 | 0.01 | 0.125 | 0.20 |
| claude-fable-5-2 | 2026-11-01 | 8 | 40 | 0.20 | 10 | 16 |
| gpt-6.2-astra | 2026-08-01 | 8 | 40 | 0.40 | 8 | 8 |
| gpt-6-astra | 2026-08-01 | 8 | 40 | 0.40 | 8 | 8 |
| gpt-6.2-sol | 2026-08-01 | 2 | 10 | 0.10 | 2 | 2 |
| gpt-6.1-sol | 2026-08-01 | 2 | 10 | 0.10 | 2 | 2 |
| gpt-6-sol | 2026-08-01 | 2 | 10 | 0.10 | 2 | 2 |
| gpt-6.1-terra | 2026-08-01 | 1 | 5 | 0.05 | 1 | 1 |
| gpt-5.6-terra | 2026-08-01 | 1 | 5 | 0.05 | 1 | 1 |
| gpt-6-luna | 2026-08-01 | 0.10 | 0.50 | 0.01 | 0.10 | 0.10 |
| gpt-5.6-sol | 2026-08-01 | 4 | 20 | 0.40 | 4 | 4 |
| gpt-5.6-luna | 2026-08-01 | 0.10 | 0.50 | 0.01 | 0.10 | 0.10 |
| codex-auto-review | 2026-01-01 | 0 | 0 | 0 | 0 | 0 |
| gemini-4-neon | 2026-10-01 | 3 | 15 | 0.15 | 3 | 3 |
| gemini-4-carbon | 2026-12-01 | 4 | 20 | 0.20 | 4 | 4 |
| gemini-4-hydrogen | 2026-10-01 | 1.50 | 7.50 | 0.075 | 1.50 | 1.50 |
| gemini-4-argon | 2026-12-01 | 4 | 20 | 0.20 | 4 | 4 |
