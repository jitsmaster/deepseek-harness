---
description: "The Claude Code accounts card in the Models page footer: pick which Claude account DSH runs Claude Code as by its plan usage, sign accounts in, and make one the default for every Claude Code on the machine."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-claude-accounts

English | [中文](README.zh.md)

## Summary

Open **Settings**, then **Models**, and scroll to **Claude Code accounts** to choose which Claude account DSH runs Claude Code as. List every email you switch between, sign each in once, and pick the one with the most plan left; each row shows its session and weekly usage so the choice is informed. The card appears only while the Host serves the `llm-claude-code` plugin.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add the emails first: type one in **Add an email** and press **Add**; the card checks it is a plausible address and not already listed. Each email is one row. **Sign in** (or **Sign in again** for an account that already has a login) opens the plugin's sign-in dialog; it asks which email to sign in, opens the Claude sign-in page, and takes the code the page shows. **Remove** takes an email out of the list; its saved login stays on disk.

The radio group chooses the account DSH uses for its own Claude Code calls: one click on an email writes it as `activeAccount`, and the next call runs as that account. Only a signed-in account can be chosen, and nothing ever switches on its own.

Each signed-in row shows the five-hour session and the seven-day weekly window as a bar, the percent used, when the window resets, and when the reading was updated. A reading exists only after that account has served a call, so a new account says **No reading yet**; a window that has reset since its reading says so. The account with the lowest usage is marked **Least used**: accounts are ranked by the larger of their two windows, then by the weekly window, and the badge appears only when at least two signed-in accounts have a reading to compare. Other badges mark **Used by DSH**, **Claude Code default**, and **Not signed in**.

**Make default for all Claude Code** swaps that account's login into the default Claude Code configuration, so every new Claude Code process (terminals, editors, other tools) signs in as it. A confirmation first says that Claude Code sessions already running may keep the old account, or write it back when they refresh their login, so you should restart them, and that your current login files are backed up first. The status is re-read every 15 seconds while the card is open and after each action.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half registers one entry into the Models page's `settings.models.footer` slot. `ClaudeAccountsController` joins two Host answers: the settings entry `llm-claude-code` (read with `settings.describe`, written with `settings.mutate` at the revision it read, paths `accounts` and `activeAccount`) and the `claudeAccounts.status()` reading. It polls status every 15 seconds while the card is mounted, folds overlapping reads into one follow-up, and re-reads settings on `settings/document-updated`, `authorization/settled`, and a connection reset. Sign-in is the existing authorization Remote for the key `llm-claude-code/claude-account`; `SignInDialog` is this package's own copy of the Models page dialog because a client package cannot import another plugin's UI. `accounts-model.ts` holds the pure rules (email checks restated from the plugin so no Host code is imported, the least-used ranking, percent and duration formatting), and the card renders nothing until the settings entry is served.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-settings-models](../ui-settings-models/README.md) — the Models page and the footer slot the card registers into.
- [llm-claude-code](../../llm/llm-claude-code/README.md) — the plugin that owns the accounts, their usage readings, and the default-login swap.
- [api-settings-controller](../../api/settings-controller/README.md) — the `claudeAccounts` Remote namespace the card reads and swaps through.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The card follows the profile entry id** — it reads settings under the entry id `llm-claude-code`; a profile that mounts the plugin under another id shows no card.
- **Usage is as old as the last call** — a reading is written when an account serves a DSH call, so an account used only from a terminal shows an old reading or none.
- **Running Claude Code sessions are not switched** — making an account the default affects new processes only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
