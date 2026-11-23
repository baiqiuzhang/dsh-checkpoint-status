# dsh-checkpoint-status

**[中文](README.md) | English**

Sidebar session marks plus a workspace-wide checkpoint inheritance tree.

- **Row mark**: checkpointed / stale (long-unused) / inherited from another session.
- **Footer button**: opens the inheritance forest for all workspaces, with per-session digests and statistics.

Everything is read-only and local to the client: it reads `sessions.list`, `sessions.refreshProjections`, `projectionValues` and `workspaces.list`. No Host routes, no extra storage, no telemetry.

## Install

```
dsh plugin --profile desktop add https://github.com/baiqiuzhang/dsh-checkpoint-status/releases/download/v0.1.0/dsh-checkpoint-status-0.1.0.tgz
```

Restart DSH after installing (the client bundle is resolved at startup).

## Limits

- The mark never competes with the built-in activity/pending mark in the same cell.
- Stale detection is a client-side heuristic based on the session catalog (`staleDays`, default 7).
- No Host half: nothing is persisted beyond the client's own config key.

## License

MIT
