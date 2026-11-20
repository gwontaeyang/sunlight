# Sunlight (study_paper)

[한국어](README.ko.md) · [Quick start](#quick-start) · [AI settings](#ai-settings) · [MIT license](LICENSE)

Sunlight is a paper reader that runs on your computer. When you get stuck on a paragraph, select it and ask Claude. Click a verified quote in the answer to see the line in the PDF, then pick up where you left off.

| Light | Dark |
| --- | --- |
| [![Reader in light mode showing a synthetic paper and its notation cards](docs/screenshots/reader-light.png)](docs/screenshots/reader-light.png) | [![The same synthetic paper and cards in dark mode](docs/screenshots/reader-dark.png)](docs/screenshots/reader-dark.png) |

## Quick start

On Linux x64 with glibc, you'll need **Node.js 22.23.5 and npm 10**. If you use nvm, `nvm install` picks up the version from the repository. Run these commands from your checkout.

The quickest way, once you have [Node.js](https://nodejs.org) 22+ installed:

```sh
./start.sh
```

That installs, builds and starts the app. Open the `http://127.0.0.1:…` address it prints; press Ctrl+C to stop.

Install Node from [nodejs.org](https://nodejs.org) or nvm, not your Linux distribution's `npm` package (it is often broken). Or do the steps yourself:

```sh
npm ci
npm run build
npm run start:user -- --user-data
```

Open the library and paste in an arXiv ID. Once the paper is there, you can read, highlight, and take notes before setting up AI. Press **Ctrl+C** in the terminal when you're done. [Open Sunlight](http://127.0.0.1:4310/)

If the default port is busy, run `SP_PORT=4595 npm run start:user -- --user-data` and open the alternate address. [Open port 4595](http://127.0.0.1:4595/)

## Read a paper

Say an equation uses a symbol you don't recognize. Open the notation cards beside the PDF and look up the symbol. If the next step depends on an assumption, open the assumption cards. You can also jump to an indexed equation or check which paper a reference points to.

For a difficult passage, select the text and press **E** for an explanation, or **T** for a translation. If you have a particular question, press **C** and type it. For a figure, hold **Ctrl** and drag around the part you want to ask about. In dark mode you can switch the figure back to its original colors.

Before closing the paper, highlight the line you want to revisit or press **N** to leave yourself a note. Save a term in the glossary or mark your reading progress in the outline when you finish a section.

## AI settings

Open **설정** (Settings) from the library or reader. If you're already signed in to the `claude` CLI on this computer, choose **Claude Code 구독** to use your subscription.

To use your own Anthropic inference key, choose **내 Anthropic API key**, paste it into the password field, and click **키 저장**. Click **키 확인** to check model access. That check doesn't generate an answer. You can replace or delete your key here later.

Save a monthly USD cap before the first API question. The form suggests $20. Settings shows subscription tokens, API spending, and amounts held for unfinished requests. If a connection drops before usage arrives, the hold stays in place. This cap covers this installation. Check your Anthropic account for actual charges. We tested the SDK with a simulated provider. Live authentication and billing are unverified.

## Data and privacy

The server listens only on this computer. PDFs, notes, and the SQLite database stay in `${XDG_DATA_HOME:-~/.local/share}/study_paper/`. Next to it are `study_paper-config/` for optional settings and `study_paper-secrets/` for the key. The key file is readable only by your OS account (0600), inside a private directory (0700). Study-data backups exclude it.

Importing a paper contacts arXiv. When you ask for AI help, your chosen provider receives what the task needs. That can include your question, the paper or its text, and an image you selected.

## Roadmap

- **Study path (planned)** — follow how a paper's argument develops as you read.

## Development

For a scratch installation, keep data, config, and secrets in three sibling directories.

```sh
export SP_DATA_DIR="$PWD/.sunlight-dev/data"
export SP_CONFIG_PATH="$PWD/.sunlight-dev/config/config.json"
export SP_SECRETS_DIR="$PWD/.sunlight-dev/secrets"
export SP_LLM=mock SP_NETWORK=off
npm run typecheck
npm test
npm run build
npm run check:licenses
npm run test:e2e
```

Browser tests use locally installed Google Chrome. The maintainer runbook calls `npm run live:e2e -- <check-args|init|import|run|evaluate|post-check> …`. Its `RESUME=1 EVALUATE=1` mode rechecks saved results (LLM 0 calls). The reader uses [PDF.js](https://github.com/mozilla/pdf.js), [KaTeX](https://github.com/KaTeX/KaTeX), SQLite, and the official [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript). Sunlight is [MIT licensed](LICENSE). Other components retain their own licenses. [Third-party notices](THIRD_PARTY_NOTICES.md)
