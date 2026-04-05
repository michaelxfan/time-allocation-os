# Time Allocation OS — WHOOP Integration

A local Node.js app that connects to the WHOOP API via OAuth, fetches your recovery/sleep/workout data, and exposes clean JSON endpoints for use in a personal dashboard.

## Quick Start

```bash
cd time-allocation-os
cp .env.example .env       # then add your credentials (see below)
npm install
npm start                  # opens at http://localhost:3000
```

## Getting WHOOP Credentials

1. Go to **[developer-dashboard.whoop.com](https://developer-dashboard.whoop.com)**
2. Log in with your WHOOP account
3. Accept the API Terms of Use (if first time)
4. Click **"Create New Application"**
5. Fill in:
   - **App Name**: `Time Allocation OS` (or anything)
   - **Redirect URI**: `http://localhost:3000/callback`
   - **Scopes**: check all of these:
     - `read:recovery`
     - `read:sleep`
     - `read:workout`
     - `read:cycles`
     - `read:profile`
6. Save the app — you'll get a **Client ID** and **Client Secret**

## Where to Paste Credentials

Open the `.env` file and replace the placeholder values:

```env
WHOOP_CLIENT_ID=paste_your_client_id_here
WHOOP_CLIENT_SECRET=paste_your_client_secret_here
WHOOP_REDIRECT_URI=http://localhost:3000/callback
PORT=3000
```

Then restart the server (`npm start`).

## Usage

1. Open `http://localhost:3000`
2. Click **"Connect WHOOP"** — you'll be redirected to WHOOP to authorize
3. After authorizing, you'll be redirected back with a green "Connected" status
4. Click any endpoint card to test the API and see live JSON responses

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/whoop/status` | Connection status (configured, connected, token valid) |
| `GET /api/whoop/recovery` | Latest recovery score, HRV, resting HR |
| `GET /api/whoop/sleep` | Latest sleep performance, hours, efficiency |
| `GET /api/whoop/workout` | Last 5 workouts with strain and HR |
| `GET /api/whoop/cycle` | Current cycle strain data |
| `GET /api/whoop/all` | Combined recovery + sleep + cycle (for dashboard) |

## Token Storage

Tokens are saved to `.whoop-tokens.json` in the project root (git-ignored). This means:
- You only need to authorize once
- Tokens persist across server restarts
- The app auto-refreshes expired tokens using the refresh token
- Click "Disconnect" or delete the file to clear tokens

## File Structure

```
time-allocation-os/
├── .env.example          ← copy to .env, add credentials
├── .env                  ← your credentials (git-ignored)
├── .whoop-tokens.json    ← saved tokens (git-ignored, auto-created)
├── .gitignore
├── package.json
├── server.js             ← Express server + OAuth + API proxy
├── README.md
└── public/
    └── index.html        ← frontend with status + endpoint tester
```

## Troubleshooting

- **"Not Configured"**: your `.env` file is missing or has placeholder values
- **"Not Connected"**: credentials are set but you haven't authorized yet — click Connect
- **401 errors on API calls**: token expired and refresh failed — click Disconnect, then Connect again
- **OAuth error "invalid_redirect_uri"**: make sure the redirect URI in your WHOOP app exactly matches `http://localhost:3000/callback`
