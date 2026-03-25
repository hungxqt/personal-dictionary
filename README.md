# Vocab Translator

Vocab Translator is a Chrome extension for translating text, saving vocabulary to a personal deck, and highlighting known source words or phrases directly on web pages.

It is built as a Manifest V3 extension with plain JavaScript modules and no build step.

## Features

- Translate text inside the popup with Google Cloud Translation.
- Save translations into a deck with timestamps and language-pair metadata.
- Keep the newest deck items first, with search, pagination, import, export, cut, copy-like paste, and bulk delete tools.
- Import deck data from `JSON`, `CSV`, `Plain text`, and the extension's `database.db` format.
- Store the deck in default extension storage or in a user-selected custom `database.db` file.
- Highlight saved source-side deck entries on web pages.
- Show a hover tooltip with the saved meaning for highlighted words or phrases.
- Show an inline selection bubble on web pages that can quick-translate selected text to Vietnamese and save it to the deck.
- Load English synonyms and antonyms from Merriam-Webster's Collegiate Thesaurus API, then translate those terms into the current target language with Google.
- Disable highlighting on specific URLs or domains from Settings.

## Project Structure

```text
assets/                 Extension icons
background/            Service worker and background message handlers
content/               Page highlighter, tooltip, and inline selection UI
lib/                   Shared helpers for translation and database access
popup/                 Popup HTML, CSS, and main extension UI logic
manifest.json          Manifest V3 configuration
```

## Requirements

- Google Cloud Translation API key
  Required for main translation and for translating thesaurus results.
- Merriam-Webster Collegiate Thesaurus API key
  Optional, only needed for the `Synonyms` and `Antonyms` buttons.
- Google Chrome or another Chromium browser with Manifest V3 support

## Install

1. Open `chrome://extensions`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select this project folder:
   `vocab-translator`

## First-Time Setup

1. Open the extension popup.
2. Go to `Settings`.
3. Add your `Google API Key`.
4. Optionally add your `Merriam-Webster API Key`.
5. If you want deck data outside extension storage, choose `Choose Another Location` and pick a `database.db` file.

## How To Use

### Translate Tab

- Choose source and target languages.
- Enter text and press `Translate` or press `Enter` in the source box.
- Save the result with `Save to Deck`.
- Click `Synonyms` or `Antonyms` after translating to load thesaurus results for English source text.

### Deck Tab

- Search cards with the search field.
- Sort by newest, oldest, `A-Z`, or `Z-A`.
- Use the checkbox in each row plus the icon toolbar for bulk actions.
- Import and export deck data with the toolbar icons.

### Settings Tab

- Save or clear API keys.
- Switch between default storage and a custom database file.
- Enable or disable page highlighting.
- Add blocked URL rules where highlighting should not run.
- Apply the latest highlight settings to the current tab.

## Storage Model

- Default mode stores deck items in extension storage.
- Custom mode writes the deck to a selected `database.db` or `.json` file through the File System Access API.
- The extension stores the custom file handle in IndexedDB so the choice can persist between popup sessions.
- Browser security rules do not expose the full OS path of the selected custom file, so the UI can only show the file name.

## Highlight Behavior

- Only the original/source text from saved deck items is highlighted on web pages.
- Highlights are skipped on blocked URLs or domains from Settings.
- Hovering a highlight shows the saved translated meaning.
- Selecting text on a normal web page shows a small inline action bubble.

## Limitations

- Merriam-Webster thesaurus lookup is English-only.
- Some pages cannot be scripted by extensions, such as `chrome://` pages and the Chrome Web Store.
- Phrase highlighting works best when the phrase appears inside a single text block on the page.
- If you reload the extension during development, refresh open tabs too so old content scripts are replaced.

## Development Notes

- There is no build or bundling step. Edit the source files directly.
- After changing popup, background, or content-script files:
  - Reload the unpacked extension.
  - Refresh any webpages where the content script was already running.
- Main files:
  - `popup/popup.js` controls the popup UI and deck features.
  - `content/highlighter.js` controls page highlighting, hover tooltips, and inline selection translation.
  - `background/service-worker.js` handles cached selections and inline save/translate requests.
  - `lib/translator.js` contains Google and Merriam-Webster API helpers.
  - `lib/database.js` contains deck storage and custom database file handling.

## Permissions

- `storage`
  Stores settings, deck data, database metadata, and cached state.
- `activeTab`
  Reads selected text from the current tab and applies highlight refresh actions.
- `scripting`
  Reads selection directly from the active page when needed.
- Host permissions:
  - `https://translation.googleapis.com/*`
  - `https://www.dictionaryapi.com/*`
