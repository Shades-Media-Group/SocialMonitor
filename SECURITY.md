# Security policy

## Supported versions

Security fixes go into the latest release. Pull the repository and run `yarn install` to update.

| Version | Supported |
| ------- | --------- |
| 0.x     | Yes       |

## Reporting a vulnerability

Please report security issues privately, not in public issues:

1. Open [a private security advisory](https://github.com/Shades-Media-Group/SocialMonitor/security/advisories/new), or
2. Email **security@shades.md**.

Include what you found, how to reproduce it, and your SocialMonitor version. You'll get an answer within three working days. Once a fix ships we credit you in the release notes, unless you'd rather stay anonymous.

## How SocialMonitor handles your data

- The dashboard listens on `127.0.0.1` only, so other devices on your network can't reach it. It has no login because it is never exposed.
- The database, the browser profile used to read the networks, and every report live in the `data/` folder on your computer.
- Post and comment text is sent to Claude for sorting, through your own Claude Code or Anthropic API key. Nothing goes to Shades Media Group.
- Keys and the browser profile are never written to logs, exports or reports.

See [PRIVACY.md](PRIVACY.md) for the full policy.
