# Tesco ERM Web — Backend

Express + MongoDB API for the **ERM Web** employee portal. Mirrors the
mobile-app backend so an employee can sign in on phone OR web with the
same credentials and see the same data.

## Architecture

```
                          MongoDB Atlas (single ERM database)
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
  HRMS Backend            ERM Mobile Backend           ERM Web Backend
 (admin portal)            (mobile app API)            (THIS PROJECT)
        │                          │                          │
  HRMS Frontend          ERM Mobile App (Expo)        ERM Web Frontend
```

All three backends share the same `employees` collection — so an
employee record created in HRMS is immediately usable for login on
either the mobile app OR this web backend.

## Folder layout

```
Backend/
├── src/
│   ├── app.js                 # Express bootstrap, manual CORS, route mounting
│   ├── keepAlive.js           # Cron that pings /api/health every 10 min
│   ├── routes/                # Endpoint definitions
│   │   ├── auth.js            # /api/auth/login, signup, OTP
│   │   ├── attendance.js      # check-in/out, today, monthly, calendar
│   │   ├── leave.js           # apply leave/permission, view history
│   │   ├── allowance.js       # submit + view petrol/travel claims
│   │   ├── profile.js         # /api/profile
│   │   ├── payslip.js         # view payslips
│   │   ├── announcement.js    # company announcements
│   │   ├── notification.js    # personal notifications
│   │   ├── complaint.js       # file + view complaints
│   │   └── adminBackfill.js   # one-off admin maintenance
│   ├── controllers/           # Business logic
│   ├── models/                # Mongoose schemas
│   ├── middleware/            # JWT auth middleware
│   └── utils/                 # Email, notify, leave policy helpers
├── package.json
├── .env                       # Secrets — NOT committed
├── .gitignore
└── README.md
```

## Local development

```powershell
cd "F:\ERM-WEB APP\ERM (web) - UI\ERM (web)\Backend"
npm install
npm run dev
```

Server boots on `http://localhost:5001` (port set in `.env`).

Verify it works:
```powershell
curl.exe http://localhost:5001/api/health
# Expected: {"ok":true,"time":"...","uptime":1.2}
```

## Production deploy (Render)

### 1. Push to GitHub

```powershell
cd "F:\ERM-WEB APP\ERM (web) - UI\ERM (web)\Backend"
git init
git add .
git commit -m "Initial ERM Web backend"
git remote add origin <your-github-repo-url>
git push -u origin main
```

(The `.gitignore` keeps `.env` and `node_modules` out of the push.)

### 2. Create Render service

1. Render dashboard → **New +** → **Web Service**
2. Connect the GitHub repo you just pushed
3. **Root Directory:** `Backend` (if you committed from the project root) or empty (if you committed from inside the Backend folder)
4. **Runtime:** Node
5. **Build Command:** `npm install`
6. **Start Command:** `npm start`

### 3. Add environment variables on Render

Copy each line from your local `.env` into the Render **Environment** tab.
At minimum you MUST set:

- `MONGO_URI`
- `JWT_SECRET`
- `JWT_EXPIRE`
- `SENDGRID_API_KEY` + `SENDGRID_FROM` + `SENDGRID_FROM_NAME`
- `ADMIN_SECRET`
- `NODE_ENV=production`
- `CORS_ORIGINS=https://your-erm-web-frontend.vercel.app` (your live web URL)
- `KEEP_ALIVE=true`

### 4. Verify it's live

After Render shows "Deploy live" (~90 sec), open the assigned URL —
e.g. `https://erm-web-backend.onrender.com` — in a browser. You should
see:

```json
{
  "name": "Tesco ERM API",
  "status": "running",
  "endpoints": [...]
}
```

## Wiring the ERM Web frontend

In `F:\ERM-WEB APP\ERM (web) - UI\ERM (web)\Frontend\`, mirror the
HRMS pattern:

**Create `.env.production`:**
```
VITE_API_URL=https://YOUR-ERM-WEB-BACKEND.onrender.com
```

**Create `src/config/api.js`:**
```js
function normalizeApiBase(raw) {
  const fallback = 'http://localhost:5001/api';
  const value = (raw && String(raw).trim()) || fallback;
  const trimmed = value.replace(/\/+$/, '');
  return /\/api$/i.test(trimmed) ? trimmed : trimmed + '/api';
}

export const API = normalizeApiBase(import.meta.env.VITE_API_URL);

if (typeof window !== 'undefined') {
  console.log('[ERM Web] API base URL →', API);
}
```

Then in every component:
```js
import { API } from './config/api';
const res = await fetch(`${API}/auth/login`, { method: 'POST', ... });
```

## Endpoints (employee-facing)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Email + password → JWT |
| GET  | `/api/profile` | Employee's own record |
| POST | `/api/attendance/checkin` | Mark check-in (with lat/lng) |
| POST | `/api/attendance/checkout` | Mark check-out |
| GET  | `/api/attendance/today` | Today's record |
| GET  | `/api/attendance/monthly?month=&year=` | Calendar month |
| GET  | `/api/attendance/history` | Past attendance |
| POST | `/api/leave/apply` | Submit leave request |
| POST | `/api/leave/permission` | Submit permission request |
| GET  | `/api/leave/my?month=&year=&type=` | Personal leave history |
| POST | `/api/allowance/submit` | Submit petrol/travel claim |
| GET  | `/api/allowance/my` | Personal allowance history |
| GET  | `/api/announcement` | Active announcements |
| GET  | `/api/notification` | Personal notifications |
| PATCH | `/api/notification/read-all` | Mark all read |
| POST | `/api/complaint` | File a complaint |
| GET  | `/api/payslip` | List payslips |

Full list at `/` of the running server.

## Key points to remember

1. **`JWT_SECRET` matches the mobile backend** — same token works on both.
   If you want independent sessions, change it.
2. **`ADMIN_SECRET` matches HRMS's `MOBILE_ADMIN_SECRET`** — so HRMS can
   reach admin endpoints here for cross-app data sync.
3. **`.env` must NEVER be committed** — secrets in there. The
   `.gitignore` already excludes it.
4. **Port 5001 locally** so the mobile backend (5000) and HRMS backend
   (8001) can all run on the same machine without clashing.
5. **`CORS_ORIGINS` empty → allow all** (dev mode). Set it on Render
   once you know the production frontend URL.
