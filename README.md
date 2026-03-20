# Flash Card

A local-first flashcard app built with Expo and React Native.

## Current platforms

- iOS / Android: uses local SQLite
- Web: uses a web-first fallback backed by browser local storage

The web build is intentionally independent from native SQLite so it can run and deploy quickly.

## CSV format

Use these columns:

```csv
front,type,back,set
은 / 는,marker,topic marker,Day 01
가다,v.,ไป,Day 01
행복,n.,ความสุข,Day 05
```

Required columns:

- `front`
- `type`
- `back`
- `set`

## Local development

1. Install Node.js LTS
2. Install dependencies

```bash
npm install
```

3. Start Expo

```bash
npm start
```

4. For web specifically:

```bash
npm run web
```

## Build web

Create a static production web build:

```bash
npm run build:web
```

This writes the deployable output to `dist/`.

## Deploy web for free

### Vercel

1. Push this repo to GitHub
2. Import the repo into Vercel
3. Use these settings:

- Framework preset: `Other`
- Build command: `npm run build:web`
- Output directory: `dist`

### Netlify

1. Connect the repo
2. Use:

- Build command: `npm run build:web`
- Publish directory: `dist`

## Notes

- Native and web storage are separate. Web data lives in the browser, not in the phone SQLite database.
- Resetting or clearing browser storage will remove web data.
- Audio and speech support on web depend on the browser.
