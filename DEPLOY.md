# Putting Wayneday online

About 20 minutes, no credit card. You end up with a link like `https://wayneday.onrender.com` that you open as host and share with your group.

| Piece | Service | Why |
| --- | --- | --- |
| Data | **Supabase** (your existing project) | Postgres that keeps the rosters |
| Website + API | **Render**, free web service | Runs the Node server straight from this GitHub repo |
| Host sign-in | **Google Cloud**, OAuth client | "Sign in with Google" for hosts and co-hosts |
| Your own domain (optional) | **Cloudflare** | Point e.g. `roster.yourdomain.com` at Render |

Members never need an account — they join with the session code and a PIN. Only hosts and co-hosts sign in with Google.

## 1. Database — Supabase

Wayneday keeps everything in one table, `wayneday_sessions`, which it creates itself. It can share your existing project without touching your other tables, or you can make a new free project for it.

1. Open your project at [supabase.com/dashboard](https://supabase.com/dashboard) → **Connect** (top bar).
2. Under **Connection string**, pick **Session pooler** (works from Render, which has no IPv6) and copy the URI. It looks like
   `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`
3. Put your database password in place of `[YOUR-PASSWORD]`. Forgot it? **Project Settings → Database → Reset database password**.

Keep this as your `DATABASE_URL`. Free Supabase projects pause after a week with no activity; if the app ever says it can't reach the database, open the dashboard and press **Restore**.

## 2. Website — Render

1. The code is on the branch `claude/cool-franklin-oudt4v`. Merge it into `main` on GitHub (or pick that branch in step 3).
2. Go to [render.com](https://render.com) and sign up with GitHub.
3. **New → Blueprint**, choose the `pleukzqa/wayneday` repo. Render reads `render.yaml` and sets up a free web service.
4. It asks for two values:
   - `DATABASE_URL` — the Supabase URI from step 1.
   - `GOOGLE_CLIENT_ID` — leave it empty for now (you'll add it in step 3).
5. **Apply**. The first build takes a few minutes. When it's live, open `https://<your-service>.onrender.com/api/health` — it should say `{"ok":true,"store":"postgres"}`.

`SESSION_SECRET` is generated for you; it keeps hosts signed in across restarts.

The free plan sleeps after 15 minutes without visitors, so the first visit after a quiet spell takes up to a minute to wake. Nothing is lost — the data is in Supabase. (Render's $7/month plan never sleeps, if that becomes annoying.)

## 3. Host sign-in — Google

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project (e.g. "Wayneday").
2. **APIs & Services → OAuth consent screen** (shown as **Google Auth Platform**): app name *Wayneday*, your email as support and developer contact, audience **External**.
3. **Audience → Publish app**. Sign-in only asks for name and email, so no Google review is needed, and any Google account can sign in. (If you leave it in *Testing*, add every host and co-host under *Test users*.)
4. **Clients → Create client → Web application**.
   - **Authorized JavaScript origins**: `https://<your-service>.onrender.com` (and your own domain if you add one, and `http://localhost:5173` for local development).
   - No redirect URIs needed.
5. Copy the **Client ID** (`…apps.googleusercontent.com`).
6. In Render → your service → **Environment**, set `GOOGLE_CLIENT_ID` to it and save. Render redeploys by itself.

Open your site: the home page now shows **Sign in with Google** under *Host a session*.

## 4. Use it

1. Sign in with Google → **Create session**.
2. **Setup → 👑 Hosts**: add your co-host's Google email. Send them the session link; they open it and tap *Host or co-host? Sign in with Google*.
3. Fill in the period, shift slots, hospital roster and students, then **Copy invite** and post it in your group chat. Students pick their name and set a PIN.
4. Your sessions are listed under **🗂️ My rosters** on the home page, on any device where you sign in.

## Optional: your own domain with Cloudflare

1. Render → your service → **Settings → Custom Domains → Add**, e.g. `roster.yourdomain.com`.
2. Cloudflare → your domain → **DNS → Add record**: type `CNAME`, name `roster`, target `<your-service>.onrender.com`. Set the proxy to **DNS only** (grey cloud) until Render shows the certificate as issued; you can turn the orange cloud on afterwards with SSL/TLS mode **Full**.
3. Add `https://roster.yourdomain.com` to the Google client's **Authorized JavaScript origins**.

## Optional: Google Sheets and Calendar exports

The same client ID also turns on "Save to Google Sheets" and "Add to Google Calendar". Enable the **Google Drive API** and **Google Calendar API** in the same Cloud project. Calendar access is a *sensitive* scope: until Google verifies the app, people see an "unverified app" warning (they can continue via *Advanced*), or you can add them as test users. Without it, the .xlsx / .ics downloads still work.

## Running it elsewhere

Any host that runs Node 22 works: `npm ci --include=dev && npm run build`, then `npm start`. The settings are environment variables:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres connection URI. Without it, sessions are JSON files in `DATA_DIR` (fine on a machine with a disk, lost on hosts that wipe the disk on restart). |
| `GOOGLE_CLIENT_ID` | Turns on Google sign-in for hosts, and Google exports. Without it, the host is whoever created the session on that browser. |
| `SESSION_SECRET` | Long random string that signs host sign-ins. |
| `PORT` | Port to listen on (default 8787). |

Saves are safe with several copies of the server running: each save names the version it replaces and retries if someone saved first.
