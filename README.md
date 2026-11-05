# Pixel Commons

Pixel Commons is a collaborative pixel canvas where users contribute to a shared image.

## Local setup

Install Python, Node.js, pnpm, and Docker with Compose. Start Docker, then run the following from the repository root in PowerShell:

```powershell
Copy-Item .env.example .env
python -m venv .venv
.\.venv\Scripts\python -m pip install -r backend\requirements.txt
docker compose up -d
```

Set `DJANGO_SECRET_KEY` in `.env` to a unique value. You can generate one with:

```powershell
.\.venv\Scripts\python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"
```

Initialize the database and default canvas, then start the backend:

```powershell
cd backend
..\.venv\Scripts\python manage.py migrate
..\.venv\Scripts\python manage.py init_canvas
..\.venv\Scripts\python manage.py runserver 127.0.0.1:8000
```

In a second terminal, start the frontend:

```powershell
cd frontend
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:5173/. Vite proxies API and WebSocket requests to the Django server. PostgreSQL stores canvas state and history, and Redis distributes live updates.

## Checks

From `backend`, run `..\.venv\Scripts\python manage.py test`. From `frontend`, run `pnpm build` and `pnpm lint`. To stop the database and Redis containers, run `docker compose stop` from the repository root.

## GitHub Pages

The Pages workflow builds the frontend with the repository's project path. Set the repository variable `VITE_BACKEND_ORIGIN` to the public HTTPS origin of the Django service, without a trailing slash, and select GitHub Actions under Settings → Pages. The backend must serve HTTPS and secure WebSockets and allow the Pages origin for HTTP and WebSocket requests. The workflow stops before deployment when the backend origin is missing.

## Render backend

The `render.yaml` Blueprint configures a free Python web service, PostgreSQL database, and private Key Value instance in Oregon. In Render, create a Blueprint from this repository after pushing the configuration. Render generates the Django secret and connects the services. The web service runs migrations and initializes the default canvas on startup. Set the Pages repository variable to the web service's `https://...onrender.com` origin after it is deployed.

Free Render PostgreSQL databases expire after 30 days. The free web service also spins down after inactivity and can take time to wake up.

## Features

1. **Account registration** — Users can create an account to participate.
2. **Login and logout** — Users can sign in and end their session.
3. **Session restoration** — Returning users can resume an existing session.
4. **Shared pixel canvas** — Users can view and contribute to a shared 100 × 100 grid.
5. **Color palette** — Users can choose a color for their next pixel.
6. **Pixel placement** — Users can select a coordinate and place a colored pixel.
7. **Placement cooldown** — The server limits how frequently each user can place pixels, and the interface displays the remaining time.
8. **Real-time updates** — Pixel placements are broadcast to connected users viewing the canvas.
9. **Connection recovery** — The canvas reconnects and refreshes its state after a connection interruption.
10. **Zoom and pan** — Users can zoom into the canvas and move around it.
11. **Coordinate navigation** — Users can enter X and Y coordinates to jump to a specific pixel.
12. **Eyedropper tool** — Users can select an existing pixel to pick up its color.
13. **Placement history** — Users can view recent placements and filter the history to their own contributions.
14. **PNG export** — Users can download the canvas as a PNG image.
15. **Shareable pixel links** — Users can copy a link that opens the canvas at a selected coordinate.
