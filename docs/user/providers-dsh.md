# DeepSeek Harness

Install `@deepseek-ai/dsh` on the machine running your environment, then enable
it in **Settings > Providers**. See
[provider setup](./install.md#providers).

```sh
npm install --global @deepseek-ai/dsh
```

T3 Code runs the harness as `dsh --profile acp`, its Agent Client Protocol
binding. If `dsh` is not on the server's `PATH`, set **Binary path** to the
executable.

## Credentials

The harness resolves `DEEPSEEK_API_KEY` from its own credential store first, then
the environment it launches with. Either path works:

- Run `dsh` once and store a key, which writes it to the harness's home.
- Add a `DEEPSEEK_API_KEY` environment variable to the provider instance. Mark it
  sensitive; T3 Code does not display a saved secret again.

Set **DSH_HOME path** to give this instance its own home and credential store,
for example to keep a second account separate. Leave it empty to use the machine
default.

## Approvals

The Agent Client Protocol binding never asks T3 Code to approve a tool call.
DeepSeek Harness writes, edits, and runs commands in the workspace with the
privileges of the user running the server, and T3 Code's permission modes do not
change that. The provider card carries a **Runs without approvals** badge for
this reason, and the interaction-mode toggle is hidden.

Run the harness only on a workspace and machine where that is acceptable.

## Models

**Refresh provider status** in **Settings > Providers** re-reads the harness's
model catalog and reasoning levels. Each model is listed under the provider that
serves it, so a model id reads as `deepseek-official/deepseek-v4-pro`. Selecting a
model without the provider prefix keeps the provider the session already uses.

Reasoning effort is a per-session setting the harness advertises alongside the
model: `off`, `low`, `high`, or `max`. A model that declares no reasoning levels
shows no selector.

## Sessions

A thread's conversation lives in the harness. Restarting the T3 Code server
reconnects the same harness session, so the agent still remembers earlier work.
