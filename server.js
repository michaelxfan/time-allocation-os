// ============================================================
// Time Allocation OS — WHOOP OAuth Integration Server
//
// SETUP:
//   1. cp .env.example .env   (fill in your WHOOP credentials)
//   2. npm install
//   3. npm start
//   4. Open http://localhost:3000
//   5. Click "Connect WHOOP" and authorize
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config ──────────────────────────────────────────────────

const WHOOP_CLIENT_ID = process.env.WHOOP_CLIENT_ID || '';
const WHOOP_CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET || '';
const WHOOP_REDIRECT_URI = process.env.WHOOP_REDIRECT_URI || `http://localhost:${PORT}/callback`;

const WHOOP_AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API_V1 = 'https://api.prod.whoop.com/developer/v1';
const WHOOP_API_V2 = 'https://api.prod.whoop.com/developer/v2';
// v2 is required for recovery, sleep, workout; v1 works for cycle
const WHOOP_API_BASE = WHOOP_API_V2;

// offline scope is required for refresh tokens
const WHOOP_SCOPES = 'offline read:recovery read:sleep read:workout read:cycles read:profile';

// Token file path — simple JSON persistence for local dev
const TOKEN_FILE = path.join(__dirname, '.whoop-tokens.json');

// ── Token Persistence ───────────────────────────────────────

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      return data;
    }
  } catch (err) {
    console.error('Failed to load tokens:', err.message);
  }
  return { accessToken: null, refreshToken: null, expiresAt: null };
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save tokens:', err.message);
  }
}

function clearTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch (err) {
    console.error('Failed to clear tokens:', err.message);
  }
}

// Load tokens from file on startup
let tokenStore = loadTokens();

function isWhoopConfigured() {
  return WHOOP_CLIENT_ID && WHOOP_CLIENT_ID !== 'your_client_id_here' &&
         WHOOP_CLIENT_SECRET && WHOOP_CLIENT_SECRET !== 'your_client_secret_here';
}

function isTokenValid() {
  return tokenStore.accessToken && tokenStore.expiresAt && Date.now() < tokenStore.expiresAt;
}

// ── HTTPS Helper ────────────────────────────────────────────

function httpsRequest(url, options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ── Token Exchange & Refresh ────────────────────────────────

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: WHOOP_CLIENT_ID,
    client_secret: WHOOP_CLIENT_SECRET,
    redirect_uri: WHOOP_REDIRECT_URI
  }).toString();

  const url = new URL(WHOOP_TOKEN_URL);
  const result = await httpsRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, body);

  if (result.status === 200 && result.body.access_token) {
    tokenStore = {
      accessToken: result.body.access_token,
      refreshToken: result.body.refresh_token || null,
      expiresAt: Date.now() + (result.body.expires_in || 3600) * 1000
    };
    saveTokens(tokenStore);
    return true;
  }
  console.error('Token exchange failed:', result.status, result.body);
  return false;
}

async function refreshAccessToken() {
  if (!tokenStore.refreshToken) return false;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokenStore.refreshToken,
    client_id: WHOOP_CLIENT_ID,
    client_secret: WHOOP_CLIENT_SECRET
  }).toString();

  const url = new URL(WHOOP_TOKEN_URL);
  const result = await httpsRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, body);

  if (result.status === 200 && result.body.access_token) {
    tokenStore = {
      accessToken: result.body.access_token,
      refreshToken: result.body.refresh_token || tokenStore.refreshToken,
      expiresAt: Date.now() + (result.body.expires_in || 3600) * 1000
    };
    saveTokens(tokenStore);
    return true;
  }
  console.error('Token refresh failed:', result.status, result.body);
  tokenStore = { accessToken: null, refreshToken: null, expiresAt: null };
  saveTokens(tokenStore);
  return false;
}

// ── Authenticated WHOOP API Call ────────────────────────────

async function whoopGet(endpoint) {
  // Auto-refresh if token is expired
  if (!isTokenValid()) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      throw new Error('Token expired and refresh failed. Please reconnect.');
    }
  }

  const url = new URL(endpoint);
  const result = await httpsRequest(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${tokenStore.accessToken}` }
  });

  // Handle 401 — token may have been revoked
  if (result.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      // Retry once
      const retry = await httpsRequest(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${tokenStore.accessToken}` }
      });
      return retry;
    }
    throw new Error('Unauthorized. Please reconnect.');
  }

  return result;
}

// ── WHOOP Data Helpers ──────────────────────────────────────

/** Compute total sleep ms from stage summary (v2 API doesn't have a single total field) */
function computeTotalSleepMs(stageSummary) {
  if (!stageSummary) return null;
  const light = stageSummary.total_light_sleep_time_milli || 0;
  const rem = stageSummary.total_rem_sleep_time_milli || 0;
  const sws = stageSummary.total_slow_wave_sleep_time_milli || 0;
  const total = light + rem + sws;
  return total > 0 ? total : null;
}

function computeTotalSleepHours(stageSummary) {
  const ms = computeTotalSleepMs(stageSummary);
  return ms != null ? Math.round((ms / 3600000) * 10) / 10 : null;
}

// ── Middleware: require WHOOP connection ─────────────────────

function requireWhoop(req, res, next) {
  if (!isTokenValid() && !tokenStore.refreshToken) {
    return res.status(401).json({
      error: 'Not connected to WHOOP',
      help: 'Visit http://localhost:' + PORT + ' and click "Connect WHOOP"'
    });
  }
  next();
}

// ── CORS (allows standalone HTML file opened from file:// to call the API) ──

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Static Files ────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ── Status Endpoint ─────────────────────────────────────────

app.get('/api/whoop/status', (req, res) => {
  res.json({
    configured: isWhoopConfigured(),
    connected: isTokenValid() || !!tokenStore.refreshToken,
    tokenValid: isTokenValid(),
    hasRefreshToken: !!tokenStore.refreshToken,
    expiresAt: tokenStore.expiresAt ? new Date(tokenStore.expiresAt).toISOString() : null
  });
});

// ── OAuth Flow ──────────────────────────────────────────────

// Step 1: Redirect to WHOOP authorization page
app.get('/auth/whoop', (req, res) => {
  if (!isWhoopConfigured()) {
    return res.status(400).send(
      '<h2>WHOOP credentials not configured</h2>' +
      '<p>Copy <code>.env.example</code> to <code>.env</code> and add your Client ID and Secret.</p>' +
      '<p><a href="/">Back to home</a></p>'
    );
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: WHOOP_CLIENT_ID,
    redirect_uri: WHOOP_REDIRECT_URI,
    scope: WHOOP_SCOPES,
    state: 'taos-' + Date.now()
  });
  res.redirect(`${WHOOP_AUTH_URL}?${params}`);
});

// Step 2: OAuth callback — exchange code for tokens
app.get('/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error || !code) {
    return res.send(
      `<h2>OAuth Error</h2>` +
      `<p>${error_description || error || 'No authorization code received.'}</p>` +
      `<p><a href="/">Back to home</a></p>`
    );
  }
  try {
    const success = await exchangeCodeForToken(code);
    if (success) {
      console.log('WHOOP connected successfully. Tokens saved.');
      res.redirect('/?connected=1');
    } else {
      res.send('<h2>Token exchange failed</h2><p>Check server logs.</p><p><a href="/">Back</a></p>');
    }
  } catch (err) {
    console.error('Callback error:', err);
    res.send(`<h2>Server Error</h2><p>${err.message}</p><p><a href="/">Back</a></p>`);
  }
});

// Disconnect — clear stored tokens
app.post('/api/whoop/disconnect', (req, res) => {
  tokenStore = { accessToken: null, refreshToken: null, expiresAt: null };
  clearTokens();
  res.json({ disconnected: true });
});

// ── WHOOP Data Endpoints ────────────────────────────────────

// GET /api/whoop/recovery — latest recovery data
// WHOOP v1 API: /developer/v1/recovery/collection
app.get('/api/whoop/recovery', requireWhoop, async (req, res) => {
  try {
    const result = await whoopGet(`${WHOOP_API_BASE}/recovery?limit=1&sort=desc`);
    if (result.status !== 200) {
      return res.status(result.status).json({ error: 'WHOOP API error', status: result.status, detail: result.body });
    }
    const record = result.body?.records?.[0] || null;
    res.json({
      raw: result.body,
      latest: record ? {
        cycleId: record.cycle_id,
        recoveryScore: record.score?.recovery_score ?? null,
        hrvRmssd: record.score?.hrv_rmssd_milli ?? null,
        restingHeartRate: record.score?.resting_heart_rate ?? null,
        skinTempCelsius: record.score?.skin_temp_celsius ?? null,
        spo2: record.score?.spo2_percentage ?? null,
        createdAt: record.created_at
      } : null
    });
  } catch (err) {
    res.status(err.message.includes('reconnect') ? 401 : 500).json({ error: err.message });
  }
});

// GET /api/whoop/sleep — latest sleep data
// WHOOP v1 API: /developer/v1/activity/sleep
app.get('/api/whoop/sleep', requireWhoop, async (req, res) => {
  try {
    const result = await whoopGet(`${WHOOP_API_BASE}/activity/sleep?limit=1&sort=desc`);
    if (result.status !== 200) {
      return res.status(result.status).json({ error: 'WHOOP API error', detail: result.body });
    }
    const record = result.body?.records?.[0] || null;
    res.json({
      raw: result.body,
      latest: record ? {
        sleepId: record.id,
        nap: record.nap,
        sleepPerformance: record.score?.sleep_performance_percentage ?? null,
        sleepConsistency: record.score?.sleep_consistency_percentage ?? null,
        sleepEfficiency: record.score?.sleep_efficiency_percentage ?? null,
        respiratoryRate: record.score?.respiratory_rate ?? null,
        totalSleepTimeMs: computeTotalSleepMs(record.score?.stage_summary),
        totalSleepHours: computeTotalSleepHours(record.score?.stage_summary),
        remSleepMs: record.score?.stage_summary?.total_rem_sleep_time_milli ?? null,
        deepSleepMs: record.score?.stage_summary?.total_slow_wave_sleep_time_milli ?? null,
        start: record.start,
        end: record.end
      } : null
    });
  } catch (err) {
    res.status(err.message.includes('reconnect') ? 401 : 500).json({ error: err.message });
  }
});

// GET /api/whoop/workout — latest workout data
// WHOOP v1 API: /developer/v1/activity/workout
app.get('/api/whoop/workout', requireWhoop, async (req, res) => {
  try {
    const result = await whoopGet(`${WHOOP_API_BASE}/activity/workout?limit=5&sort=desc`);
    if (result.status !== 200) {
      return res.status(result.status).json({ error: 'WHOOP API error', detail: result.body });
    }
    const records = result.body?.records || [];
    res.json({
      raw: result.body,
      latest: records.map(r => ({
        workoutId: r.id,
        sport: r.sport_id,
        strain: r.score?.strain ?? null,
        averageHeartRate: r.score?.average_heart_rate ?? null,
        maxHeartRate: r.score?.max_heart_rate ?? null,
        kilojoules: r.score?.kilojoule ?? null,
        durationMs: r.score?.zone_duration?.zone_zero_milli != null
          ? Object.values(r.score.zone_duration).reduce((a, b) => a + (b || 0), 0)
          : null,
        start: r.start,
        end: r.end
      }))
    });
  } catch (err) {
    res.status(err.message.includes('reconnect') ? 401 : 500).json({ error: err.message });
  }
});

// GET /api/whoop/cycle — latest cycle (strain) data
app.get('/api/whoop/cycle', requireWhoop, async (req, res) => {
  try {
    const result = await whoopGet(`${WHOOP_API_BASE}/cycle?limit=1&sort=desc`);
    if (result.status !== 200) {
      return res.status(result.status).json({ error: 'WHOOP API error', detail: result.body });
    }
    const record = result.body?.records?.[0] || null;
    res.json({
      raw: result.body,
      latest: record ? {
        cycleId: record.id,
        strain: record.score?.strain ?? null,
        kilojoule: record.score?.kilojoule ?? null,
        averageHeartRate: record.score?.average_heart_rate ?? null,
        maxHeartRate: record.score?.max_heart_rate ?? null,
        start: record.start,
        end: record.end
      } : null
    });
  } catch (err) {
    res.status(err.message.includes('reconnect') ? 401 : 500).json({ error: err.message });
  }
});

// GET /api/whoop/all — fetch recovery + sleep + cycle in one call
app.get('/api/whoop/all', requireWhoop, async (req, res) => {
  try {
    const [recoveryRes, sleepRes, cycleRes] = await Promise.all([
      whoopGet(`${WHOOP_API_BASE}/recovery?limit=1&sort=desc`),
      whoopGet(`${WHOOP_API_BASE}/activity/sleep?limit=1&sort=desc`),
      whoopGet(`${WHOOP_API_BASE}/cycle?limit=1&sort=desc`)
    ]);

    const recovery = recoveryRes.status === 200 ? recoveryRes.body?.records?.[0] : null;
    const sleep = sleepRes.status === 200 ? sleepRes.body?.records?.[0] : null;
    const cycle = cycleRes.status === 200 ? cycleRes.body?.records?.[0] : null;

    res.json({
      fetchedAt: new Date().toISOString(),
      recovery: recovery ? {
        recoveryScore: recovery.score?.recovery_score ?? null,
        hrv: recovery.score?.hrv_rmssd_milli ?? null,
        restingHeartRate: recovery.score?.resting_heart_rate ?? null
      } : null,
      sleep: sleep ? {
        sleepPerformance: sleep.score?.sleep_performance_percentage ?? null,
        totalSleepHours: computeTotalSleepHours(sleep.score?.stage_summary),
        sleepEfficiency: sleep.score?.sleep_efficiency_percentage ?? null
      } : null,
      cycle: cycle ? {
        strain: cycle.score?.strain ?? null,
        kilojoule: cycle.score?.kilojoule ?? null,
        averageHeartRate: cycle.score?.average_heart_rate ?? null
      } : null,
      warnings: [
        recoveryRes.status !== 200 ? `recovery: HTTP ${recoveryRes.status}` : null,
        sleepRes.status !== 200 ? `sleep: HTTP ${sleepRes.status}` : null,
        cycleRes.status !== 200 ? `cycle: HTTP ${cycleRes.status}` : null
      ].filter(Boolean)
    });
  } catch (err) {
    res.status(err.message.includes('reconnect') ? 401 : 500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// CLICKUP INTEGRATION
// Customized for Michael's workspace:
//   Team: 90141061782 | Space: 90144756697 ("Space") | User: 94209984
//   Lists: GH, Personal, Innovative (exact names)
// ════════════════════════════════════════════════════════════

const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN || '';
const CLICKUP_API = 'https://api.clickup.com/api/v2';

// ── Workspace config ────────────────────────────────────────
const CLICKUP_SPACE_ID = '90144756697';
const CLICKUP_MICHAEL_USER_ID = '94209984';

// Exact list name → dashboard category mapping
const LIST_NAME_MAP = { 'GH': 'GH', 'Personal': 'Personal', 'Innovative': 'Innovative' };

// Statuses that mean "done"
const CLOSED_STATUSES = ['complete', 'completed', 'done', 'closed', 'archived', 'cancelled'];

// ── AE inference from task title keywords ───────────────────
// Replace this with custom field logic when AE field is added to ClickUp.
const AE_KEYWORDS = {
  3: /\b(deep|strategy|build|design|architect|spec|framework|overhaul|migrate)\b/i,
  2: /\b(review|analyze|plan|research|draft|outline|audit|prep|brainstorm|improve)\b/i,
  1: /\b(email|admin|pay|book|order|schedule|update|clean|organize|stretch|journal|submit|renew)\b/i
};

function inferAEFromTitle(title) {
  for (const [ae, pattern] of Object.entries(AE_KEYWORDS)) {
    if (pattern.test(title)) return parseInt(ae);
  }
  return 2; // default to medium
}

function isClickUpConfigured() {
  return !!CLICKUP_API_TOKEN && CLICKUP_API_TOKEN !== 'your_clickup_api_token_here';
}

// ── ClickUp API helper ──────────────────────────────────────

async function clickUpGet(endpoint) {
  const url = new URL(endpoint.startsWith('http') ? endpoint : CLICKUP_API + endpoint);
  return httpsRequest(url, {
    method: 'GET',
    headers: { 'Authorization': CLICKUP_API_TOKEN, 'Content-Type': 'application/json' }
  });
}

// ── Normalization ───────────────────────────────────────────

function mapPriority(raw) {
  const id = raw.priority?.id ? parseInt(raw.priority.id) : null;
  if (id === 1) return 'P0';  // urgent
  if (id === 2) return 'P1';  // high
  return 'P2';                // normal, low, or null
}

function inferEstimatedMinutes(ae) {
  if (ae === 3) return 60;
  if (ae === 2) return 30;
  return 15;
}

function isAssignedToMichael(raw) {
  return (raw.assignees || []).some(a => String(a.id) === CLICKUP_MICHAEL_USER_ID);
}

function isOpen(raw) {
  const status = (raw.status?.status || '').toLowerCase();
  return !CLOSED_STATUSES.some(s => status.includes(s));
}

// ── Custom field extraction helpers ─────────────────────────
const VALID_LEVERAGE = ['Unblocker', 'Growth', 'Direct Output', 'Maintenance'];

function extractCustomFields(raw) {
  const result = { impact: null, leverage: null };
  const fields = raw.custom_fields || [];
  for (const f of fields) {
    const name = (f.name || '').trim();

    // Impact — numeric 1–5
    if (name === 'Impact') {
      const val = f.value != null ? Number(f.value) : null;
      if (val != null && val >= 1 && val <= 5) result.impact = val;
    }

    // Leverage — dropdown (ClickUp stores selected index + options array)
    if (name === 'Leverage') {
      // Dropdown fields: value is the index of the selected option in type_config.options
      if (f.type === 'drop_down' && f.type_config?.options && f.value != null) {
        const selected = f.type_config.options.find(o => o.orderindex === f.value || o.id === f.value);
        if (selected) result.leverage = selected.name || selected.label || null;
      }
      // Labels field or text fallback
      else if (typeof f.value === 'string') {
        result.leverage = f.value;
      }
    }
  }
  return result;
}

function normalizeLeverage(raw) {
  if (!raw) return 'Direct Output';
  const normalized = raw.trim();
  // Case-insensitive match
  const match = VALID_LEVERAGE.find(v => v.toLowerCase() === normalized.toLowerCase());
  return match || 'Direct Output';
}

function normalizeTask(raw, listCategory) {
  const title = raw.name || 'Untitled';
  const ae = inferAEFromTitle(title);
  const priority = mapPriority(raw);
  const timeEstimate = raw.time_estimate ? Math.round(raw.time_estimate / 60000) : null;

  // Steps from checklists or subtasks
  let steps = [];
  if (raw.checklists?.length) {
    for (const cl of raw.checklists) {
      for (const item of (cl.items || [])) {
        if (item.name) steps.push(item.name);
      }
    }
  }
  // If subtask names available in the response, use them
  if (!steps.length && raw.subtasks?.length) {
    steps = raw.subtasks.map(s => s.name).filter(Boolean);
  }

  // Extract Impact & Leverage custom fields
  const cf = extractCustomFields(raw);
  const impact = cf.impact ?? 3;           // default 3 if missing
  const leverage = normalizeLeverage(cf.leverage); // default 'Direct Output' if missing

  return {
    id: raw.id,
    title,
    list: listCategory,
    ae,
    priority,
    dueDate: raw.due_date ? new Date(parseInt(raw.due_date)).toISOString().split('T')[0] : null,
    recurring: !!(raw.recurrence),
    estimatedMinutes: timeEstimate || inferEstimatedMinutes(ae),
    context: listCategory,
    description: raw.description || null,
    steps,
    assignee: (raw.assignees || [])[0]?.username || null,
    status: raw.status?.status || null,
    source: 'clickup',
    aeSource: 'inferred',
    impact,
    impactSource: cf.impact != null ? 'field' : 'default',
    leverage,
    leverageSource: cf.leverage != null ? 'field' : 'default'
  };
}

// ── Routes ──────────────────────────────────────────────────

app.get('/api/clickup/status', (req, res) => {
  res.json({
    configured: isClickUpConfigured(),
    spaceId: CLICKUP_SPACE_ID,
    userId: CLICKUP_MICHAEL_USER_ID
  });
});

// Debug: explore FULL workspace — all teams, spaces, folders, lists
app.get('/api/clickup/explore', async (req, res) => {
  if (!isClickUpConfigured()) return res.status(400).json({ error: 'Not configured' });
  try {
    const result = [];

    // Get all teams
    const teamsRes = await clickUpGet('/team');
    const teams = teamsRes.body?.teams || [];

    for (const team of teams) {
      const teamObj = { teamId: team.id, teamName: team.name, spaces: [] };

      // Get all spaces in this team
      const spacesRes = await clickUpGet(`/team/${team.id}/space`);
      const spaces = spacesRes.body?.spaces || [];

      for (const space of spaces) {
        const spaceObj = { spaceId: space.id, spaceName: space.name, folderlessLists: [], folders: [] };

        // Folderless lists
        const listsRes = await clickUpGet(`/space/${space.id}/list`);
        spaceObj.folderlessLists = (listsRes.body?.lists || []).map(l => ({ id: l.id, name: l.name, taskCount: l.task_count }));

        // Folders and their lists
        const foldersRes = await clickUpGet(`/space/${space.id}/folder`);
        for (const f of (foldersRes.body?.folders || [])) {
          spaceObj.folders.push({
            id: f.id, name: f.name,
            lists: (f.lists || []).map(l => ({ id: l.id, name: l.name, taskCount: l.task_count }))
          });
        }

        teamObj.spaces.push(spaceObj);
      }
      result.push(teamObj);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Main task fetch: list-by-list from the space
app.get('/api/clickup/tasks', async (req, res) => {
  if (!isClickUpConfigured()) {
    return res.status(400).json({ error: 'ClickUp not configured', help: 'Add CLICKUP_API_TOKEN to .env' });
  }

  const stats = {
    fetched: 0, assignedToMichael: 0, open: 0, mapped: 0,
    excluded: { wrongAssignee: 0, closed: 0, unmappedList: 0 },
    byList: {}
  };

  try {
    // Step 1: Get all lists in the space
    const listsRes = await clickUpGet(`/space/${CLICKUP_SPACE_ID}/list`);
    if (listsRes.status !== 200) {
      return res.status(listsRes.status).json({ error: 'Failed to fetch lists', detail: listsRes.body });
    }

    const lists = listsRes.body?.lists || [];
    const targetLists = lists.filter(l => LIST_NAME_MAP[l.name]);
    const unmatchedLists = lists.filter(l => !LIST_NAME_MAP[l.name]).map(l => l.name);

    // Step 2: Fetch tasks from each target list in parallel
    const listFetches = targetLists.map(async (list) => {
      const category = LIST_NAME_MAP[list.name];
      const params = new URLSearchParams({
        page: '0',
        include_closed: 'false',
        subtasks: 'true'
      });
      const tasksRes = await clickUpGet(`/list/${list.id}/task?${params}`);
      return {
        listId: list.id,
        listName: list.name,
        category,
        tasks: tasksRes.status === 200 ? (tasksRes.body?.tasks || []) : [],
        status: tasksRes.status
      };
    });

    const listResults = await Promise.all(listFetches);

    // Step 3: Normalize and filter
    const normalized = [];
    for (const lr of listResults) {
      stats.byList[lr.category] = { total: lr.tasks.length, included: 0 };
      for (const raw of lr.tasks) {
        stats.fetched++;

        if (!isAssignedToMichael(raw)) { stats.excluded.wrongAssignee++; continue; }
        stats.assignedToMichael++;

        if (!isOpen(raw)) { stats.excluded.closed++; continue; }
        stats.open++;

        const task = normalizeTask(raw, lr.category);
        stats.mapped++;
        stats.byList[lr.category].included++;
        normalized.push(task);
      }
    }

    if (unmatchedLists.length) stats.excluded.unmappedList = unmatchedLists.length;

    res.json({
      tasks: normalized,
      stats,
      unmatchedLists,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('ClickUp fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch ClickUp tasks', detail: err.message });
  }
});

// GET /api/whoop/debug — try multiple API paths to find working endpoints
app.get('/api/whoop/debug', requireWhoop, async (req, res) => {
  const paths = [
    '/developer/v1/cycle',
    '/developer/v1/recovery',
    '/developer/v1/sleep',
    '/developer/v1/workout',
    '/developer/v1/activity/sleep',
    '/developer/v1/activity/workout',
    '/developer/v1/activity/recovery',
    '/developer/v1/recovery/collection',
    '/developer/v2/cycle',
    '/developer/v2/activity/sleep',
    '/developer/v2/activity/workout',
    '/developer/v2/recovery',
  ];
  const results = {};
  for (const p of paths) {
    try {
      const r = await whoopGet(`https://api.prod.whoop.com${p}?limit=1`);
      results[p] = { status: r.status, hasRecords: !!r.body?.records?.length, keys: typeof r.body === 'object' ? Object.keys(r.body) : null };
    } catch (err) {
      results[p] = { error: err.message };
    }
  }
  res.json(results);
});

// ════════════════════════════════════════════════════════════
// GOOGLE CALENDAR INTEGRATION
// ════════════════════════════════════════════════════════════

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/calendar.readonly';

const GOOGLE_TOKEN_FILE = path.join(__dirname, '.google-tokens.json');

// Token store
let googleTokens = { accessToken: null, refreshToken: null, expiresAt: null };

function loadGoogleTokens() {
  try {
    if (fs.existsSync(GOOGLE_TOKEN_FILE)) return JSON.parse(fs.readFileSync(GOOGLE_TOKEN_FILE, 'utf8'));
  } catch {}
  return { accessToken: null, refreshToken: null, expiresAt: null };
}
function saveGoogleTokens(t) {
  try { fs.writeFileSync(GOOGLE_TOKEN_FILE, JSON.stringify(t, null, 2), 'utf8'); } catch {}
}
function clearGoogleTokens() {
  googleTokens = { accessToken: null, refreshToken: null, expiresAt: null };
  try { if (fs.existsSync(GOOGLE_TOKEN_FILE)) fs.unlinkSync(GOOGLE_TOKEN_FILE); } catch {}
}

googleTokens = loadGoogleTokens();

function isGoogleConfigured() {
  return GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID !== 'your_google_client_id' &&
         GOOGLE_CLIENT_SECRET && GOOGLE_CLIENT_SECRET !== 'your_google_client_secret';
}
function isGoogleTokenValid() {
  return googleTokens.accessToken && googleTokens.expiresAt && Date.now() < googleTokens.expiresAt;
}

async function exchangeGoogleCode(code) {
  const body = new URLSearchParams({
    code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code'
  }).toString();
  const res = await httpsRequest(new URL(GOOGLE_TOKEN_URL), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, body);
  if (res.status === 200 && res.body.access_token) {
    googleTokens = {
      accessToken: res.body.access_token,
      refreshToken: res.body.refresh_token || googleTokens.refreshToken,
      expiresAt: Date.now() + (res.body.expires_in || 3600) * 1000
    };
    saveGoogleTokens(googleTokens);
    return true;
  }
  console.error('Google token exchange failed:', res.status, res.body);
  return false;
}

async function refreshGoogleToken() {
  if (!googleTokens.refreshToken) return false;
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: googleTokens.refreshToken, grant_type: 'refresh_token'
  }).toString();
  const res = await httpsRequest(new URL(GOOGLE_TOKEN_URL), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, body);
  if (res.status === 200 && res.body.access_token) {
    googleTokens.accessToken = res.body.access_token;
    googleTokens.expiresAt = Date.now() + (res.body.expires_in || 3600) * 1000;
    saveGoogleTokens(googleTokens);
    return true;
  }
  console.error('Google token refresh failed:', res.status);
  return false;
}

async function googleGet(endpoint) {
  if (!isGoogleTokenValid()) {
    if (!await refreshGoogleToken()) throw new Error('Google token expired');
  }
  const url = new URL(endpoint.startsWith('http') ? endpoint : GOOGLE_CALENDAR_API + endpoint);
  const res = await httpsRequest(url, {
    method: 'GET', headers: { 'Authorization': `Bearer ${googleTokens.accessToken}` }
  });
  if (res.status === 401) {
    if (await refreshGoogleToken()) {
      return httpsRequest(url, {
        method: 'GET', headers: { 'Authorization': `Bearer ${googleTokens.accessToken}` }
      });
    }
    throw new Error('Unauthorized');
  }
  return res;
}

// ── Google Calendar Routes ──────────────────────────────────

app.get('/api/calendar/status', (req, res) => {
  res.json({
    configured: isGoogleConfigured(),
    connected: isGoogleTokenValid() || !!googleTokens.refreshToken,
    tokenValid: isGoogleTokenValid()
  });
});

app.get('/auth/google', (req, res) => {
  if (!isGoogleConfigured()) return res.status(400).send('Google credentials not configured');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code', scope: GOOGLE_SCOPES,
    access_type: 'offline', prompt: 'consent',
    state: 'taos-gcal-' + Date.now()
  });
  res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?gcal_error=' + encodeURIComponent(error || 'no_code'));
  try {
    const ok = await exchangeGoogleCode(code);
    res.redirect(ok ? '/?gcal_connected=1' : '/?gcal_error=token_exchange_failed');
  } catch (err) {
    res.redirect('/?gcal_error=server_error');
  }
});

app.post('/api/calendar/disconnect', (req, res) => {
  clearGoogleTokens();
  res.json({ disconnected: true });
});

// Fetch today's events
app.get('/api/calendar/today', async (req, res) => {
  if (!isGoogleTokenValid() && !googleTokens.refreshToken) {
    return res.status(401).json({ error: 'Not connected to Google Calendar' });
  }
  try {
    // Use local date from query or default to today
    const tz = req.query.tz || 'America/New_York';
    const dateStr = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    const timeMin = `${dateStr}T00:00:00`;
    const timeMax = `${dateStr}T23:59:59`;

    const params = new URLSearchParams({
      timeMin: new Date(`${timeMin}`).toISOString(),
      timeMax: new Date(`${timeMax}`).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
      timeZone: tz
    });

    const result = await googleGet(`/calendars/primary/events?${params}`);
    if (result.status !== 200) {
      return res.status(result.status).json({ error: 'Google Calendar API error', detail: result.body });
    }

    const rawEvents = result.body?.items || [];

    // Normalize events
    const events = rawEvents
      .filter(e => e.status !== 'cancelled')
      .filter(e => {
        // Exclude declined events
        const self = (e.attendees || []).find(a => a.self);
        return !self || self.responseStatus !== 'declined';
      })
      .map(e => ({
        id: e.id,
        title: e.summary || '(No title)',
        start: e.start?.dateTime || e.start?.date || null,
        end: e.end?.dateTime || e.end?.date || null,
        isAllDay: !e.start?.dateTime,
        location: e.location || null,
        calendarId: 'primary',
        status: e.status
      }));

    res.json({ events, date: dateStr, timezone: tz, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Google Calendar fetch error:', err.message);
    if (err.message.includes('expired') || err.message.includes('Unauthorized')) {
      return res.status(401).json({ error: 'Token expired. Please reconnect.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Start ───────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n  Time Allocation OS`);
  console.log(`  http://localhost:${PORT}\n`);

  // WHOOP status
  if (!isWhoopConfigured()) {
    console.log('  ⚠  WHOOP not configured (see .env.example)');
  } else {
    console.log('  ✓  WHOOP credentials loaded' + (tokenStore.refreshToken ? ' (tokens saved)' : ''));
  }

  // ClickUp status
  if (!isClickUpConfigured()) {
    console.log('  ⚠  ClickUp not configured — add CLICKUP_API_TOKEN to .env');
  } else {
    console.log('  ✓  ClickUp configured (space: ' + CLICKUP_SPACE_ID + ', user: ' + CLICKUP_MICHAEL_USER_ID + ')');
  }

  // Google Calendar status
  if (!isGoogleConfigured()) {
    console.log('  ⚠  Google Calendar not configured — add GOOGLE_CLIENT_ID/SECRET to .env');
  } else {
    console.log('  ✓  Google Calendar configured' + (googleTokens.refreshToken ? ' (tokens saved)' : ''));
  }
  console.log('');
});
