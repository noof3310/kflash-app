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

This repo also includes serverless API routes under `api/`. When you deploy the whole repository to Vercel, those routes are deployed automatically from the project root:

- `GET /api/google/voices`
- `POST /api/google/speak`

Important:

- Do not upload only the `dist/` folder. That would deploy only the static web build and skip `api/`.
- Deploy the repository root, and let Vercel use `dist/` only as the static output directory.
- Keep the `api/` directory at the repository root.

Recommended:

- Commit [vercel.json](/Users/n.sakulsaowapakkul/Documents/kflash-app/vercel.json) so the build/output settings live in the repo instead of only in the dashboard.

### Netlify

1. Connect the repo
2. Use:

- Build command: `npm run build:web`
- Publish directory: `dist`

## Notes

- Native and web storage are separate. Web data lives in the browser, not in the phone SQLite database.
- Resetting or clearing browser storage will remove web data.
- Audio and speech support on web depend on the browser.

## Google TTS backend scaffold

This repo now includes Vercel-style serverless routes for Google Cloud Text-to-Speech:

- `GET /api/health`
- `GET /api/google/voices`
- `POST /api/google/speak`

The app uses a TTS abstraction with two providers:

- `system`
- `google`

If Google is selected but the backend is not configured, the app falls back to system TTS automatically.

### Required backend environment variables

Use either a full service-account JSON blob:

- `GOOGLE_TTS_SERVICE_ACCOUNT_JSON`

Or split fields:

- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

Optional persistent TTS cache on Vercel:

- `UPSTASH_REDIS_REST_KV_REST_API_URL`
- `UPSTASH_REDIS_REST_KV_REST_API_TOKEN`
- `BLOB_READ_WRITE_TOKEN`

The backend also accepts the older alias names:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

If those three cache env vars are present, `/api/google/speak` will:

- store synthesized MP3 files in Vercel Blob
- store cache metadata in Upstash Redis
- reuse cached audio across deploys and serverless instances

If they are missing, the app still works and falls back to in-memory cache only.

If you use the split private key env var, keep the newline escapes as `\n`.

### App environment variables

- Web on the same Vercel deployment defaults to `/api`, so no extra public env var is required.
- Native clients should point at the deployed backend with:

```bash
EXPO_PUBLIC_GOOGLE_TTS_PROXY_BASE_URL=https://your-domain.com/api
```

### Google provider behavior

- Voice list: app calls `/api/google/voices`
- Speech synth: app calls `/api/google/speak`
- Backend exchanges the service account for an OAuth access token and forwards requests to Google Cloud Text-to-Speech
- The client receives MP3 audio and plays it through the shared app audio path

### Deploy notes

If you deploy on Vercel, add the Google env vars in the project settings and redeploy. The static web app continues to use `dist/`, while the backend routes are deployed from `api/` automatically.

Required Vercel setup:

1. Project source must be the repository root, not the `dist/` folder
2. Build command: `npm run build:web`
3. Output directory: `dist`
4. Add backend env vars in Vercel Project Settings:
   - `GOOGLE_TTS_SERVICE_ACCOUNT_JSON`
   - or `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
5. Redeploy

Quick verification after deploy:

- Open `/api/health`
- It should return JSON like `{ "ok": true, "googleTts": { "config": ..., "cache": ... } }`
- Open `/api/google/voices`
- If credentials are configured correctly, it should return JSON instead of your app HTML
- In the app debug screen, repeat the same Google TTS request twice and check whether `Server cache` changes to `persistent-hit`
