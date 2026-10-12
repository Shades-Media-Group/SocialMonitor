<a id="top"></a>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-dark.svg">
    <img alt="SocialMonitor" src="assets/brand/logo.svg" width="420">
  </picture>
</p>

<h3 align="center">Watch brands on Instagram, Facebook and TikTok.<br>Every post and comment kept on your computer, sorted into good and bad by AI.</h3>

<p align="center">
  <a href="https://github.com/Shades-Media-Group/SocialMonitor/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Shades-Media-Group/SocialMonitor/ci.yml?branch=main&style=flat-square&label=ci"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-0a0a0b?style=flat-square"></a>
  <img alt="Status: in development" src="https://img.shields.io/badge/status-in%20development-f9000a?style=flat-square">
</p>

<p align="center">
  <a href="https://socialmonitor.shades.md"><b>Website</b></a> ·
  <a href="docs/README.md"><b>Documentation</b></a> ·
  <a href="CHANGELOG.md"><b>Changelog</b></a> ·
  <a href="PRIVACY.md"><b>Privacy</b></a>
</p>

> **In development.** The repository is public while the first version is built. Watch it to hear when 0.1 is ready to run.

## What it does

- **Watches the brands you choose** on Instagram, Facebook and TikTok: one network, several, or all three.
- **Reads every new post,** video included, and writes a short description of what it is about.
- **Keeps every comment** under each post, with likes and counts, in a database on your computer.
- **Sorts the comments with AI:** praise, questions, complaints about the product or the service, and anything that needs an answer.
- **Runs when you say.** Updates are manual by default: choose the brand, the networks, and new posts or all of them. Schedules are optional: every few hours, daily, or at set times.
- **Reports** after every update, or whenever you ask, with export and import of the whole database.
- **Works with Claude.** A built-in MCP server lets Claude read and query your data from any chat.

## Privacy

SocialMonitor is an app you run on your own computer. There is no SocialMonitor server and no account. The database, the browser profile it reads the networks with, and every report stay on your machine. To sort comments, their text goes to Claude through your own Claude Code or Anthropic API key, and nowhere else. Read the [privacy policy](PRIVACY.md).

## Run it

Requires Node 22.18 or newer (see `.nvmrc`) and Yarn 1.

```bash
git clone https://github.com/Shades-Media-Group/SocialMonitor.git
cd SocialMonitor
yarn install
yarn start        # opens the dashboard at http://localhost:4400
```

| Command            | What it does                                               |
| ------------------ | ---------------------------------------------------------- |
| `yarn start`       | Starts the dashboard and the scheduler on your computer    |
| `yarn mcp`         | Starts the MCP server, for Claude                          |
| `yarn verify`      | Typecheck, lint, unit tests and the website build          |
| `yarn brand`       | Regenerates every logo file from one geometry              |
| `yarn deploy:site` | Builds, checks and deploys the website to Cloudflare       |
| `yarn release`     | Bumps the version, writes the changelog and tags a release |

## Part of the Shades family

SocialMonitor is built on [Gradient](https://github.com/Shades-Media-Group/gradient), the Shades Media Group design system, alongside [PageRecast](https://github.com/Shades-Media-Group/PageRecast) and [ImageRefold](https://github.com/Shades-Media-Group/ImageRefold).

## Contributing and support

- **Questions and ideas:** [Discussions](https://github.com/Shades-Media-Group/SocialMonitor/discussions) and [SUPPORT.md](SUPPORT.md).
- **Something broke?** Open a [bug report](https://github.com/Shades-Media-Group/SocialMonitor/issues/new?template=bug.yml).
- **Pull requests:** read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Security issues:** report them privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Shades Media Group. The name and logo are reserved: see [TRADEMARKS.md](TRADEMARKS.md).

---

<p align="center">
  Built by <a href="https://github.com/CristianBrinza">Cristian Brinza</a> | <a href="https://shades.md">Shades Media Group</a>
  <br>
  <sub><a href="#top">Back to top</a></sub>
</p>
