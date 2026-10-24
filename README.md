# The Archivist for Obsidian

Keeps your vault's notes in [The Archivist](https://the-archivist.cc), a private, lifelong archive of your email and notes that you and your AI agents can search and ask about.

Install it, choose **Connect**, approve this device in your browser, and from then on your notes sync quietly in the background, on desktop and mobile.

## Before you install

- **You need an account.** The Archivist is in a closed beta; you can [ask for a place](https://the-archivist.cc).
- **It uses the network.** It sends your vault's Markdown notes (their paths and text) to your archive at `app.the-archivist.cc`, and nowhere else. That's the whole point of the plugin. You can change the address in settings, for development.
- **No telemetry.** It collects nothing about you or how you use it.
- **It only reads your vault.** It never changes, moves or deletes a note.

## What it syncs

Every Markdown note in the vault, except:

- Obsidian's settings folder, the trash, and the attachment folder if you've set one;
- folders and patterns you list under **Leave out**, such as `Private` or `Journal/**/drafts`;
- notes over 10 MB, which are listed in settings.

Attachments, PDFs and images aren't synced.

Each vault syncs to one folder in your archive, named `obsidian-` and the vault's name unless you change it.

## How it syncs

- When Obsidian starts, about 2 minutes after you stop editing, and every 15 minutes as a backstop (5, 15, 60 minutes or never).
- On demand with the command **The Archivist: Sync now**.
- A note you delete in Obsidian is removed from the archive at the next sync. If a sync would remove more than 20 notes and more than a quarter of the folder, it stops and asks first, in case the vault hasn't finished loading or a folder is missing.
- One device syncs each vault. Connecting a second device for the same vault disconnects the first.

## Your sign-in

Connecting gives this device a token that can only sync this vault's folder: it can't read or search your archive. It's kept in Obsidian's secret storage on this device, never in the vault, so it doesn't travel with Obsidian Sync, iCloud or git. **Disconnect** in settings revokes it; you can also revoke it in your archive under Settings → Access tokens.

## Installing during the beta

Until the plugin is listed in Obsidian's community plugins, install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat): add the beta plugin `code-ministry-ltd/the-archivist-obsidian`.

Needs Obsidian 1.11.4 or later.

## Development

```sh
npm install
npm run dev        # rebuilds main.js on change
npm test
npm run typecheck
npx eslint .       # Obsidian's own plugin rules
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/the-archivist/` to try a build. To release, run `npm version patch` (or `minor`), then push the tag; the release workflow attaches the files.

The server side lives in The Archivist's own repository: device sign-in and the sync protocol are in its specs 0005 and 0001 §5.5.

## Licence

MIT, © Code Ministry Ltd.
