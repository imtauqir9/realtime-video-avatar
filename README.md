# Realtime Video Avatar (Tavus)

Build a realtime, lifelike video avatar of yourself: you type a question, and a talking-head video of
you answers in real time, in your voice and personality. The avatar is powered by an LLM that knows
about you from a short bio you write.

It uses [Tavus CVI](https://docs.tavus.io/sections/conversational-video-interface/overview-cvi)
(Conversational Video Interface). For the technical deep-dive see [TAVUS.md](./TAVUS.md).

## The three phases

The build is staged so you prove the concept for free before paying or recording anything.

- **Phase 1 — Prototype (free tier, stock face).** Prove the whole pipeline end to end: text in, an LLM
  that knows about you, realtime talking-head video out. The face is a Tavus stock person for now.
  This is the bulk of the work and it costs nothing.
- **Phase 2 — A polished web UI.** A React app (`avatar/`) plus a tiny Node `backend/`, with Type /
  Talk / Face-to-face modes (text, voice, or full video-to-video). `npm install && npm run dev`.
- **Phase 3 — Make it look like you (paid).** Upgrade to a paid plan, record a ~60-second clip, train a
  custom replica of yourself (and optionally clone your voice), then change one setting. Same demo,
  your face.

---

## Phase 1 — Prototype (detailed steps)

### Prerequisites

- A Tavus account (the free tier is fine). Sign up at [tavus.io](https://www.tavus.io).
- [`uv`](https://docs.astral.sh/uv/) installed. This repo is a uv project pinned to **Python 3.12**
  (`pyproject.toml` + `.python-version`); the first `uv run` creates the virtual environment and installs
  dependencies automatically, so there's no separate setup step.

### Step 1 — Create your `knowledge/ME.md`

**You need to create a file `knowledge/ME.md`** describing yourself. This is the only content that makes
the avatar "you". The profile for Imran Tauqir is already in this repo at `knowledge/ME.md`, built
from imrantauqir.com. Edit it as needed, or copy its shape for another person.

Guidelines:
- Start the file with a top-level heading that is your name, e.g. `# Jane Smith`. The script uses that
  line as the avatar's name.
- Write it as concise notes about who you are: what you do, your background, how you come across, and
  how people can find you. A page or so is plenty.
- Keep it under roughly 3,000 words. The persona prompt works best at around 5,000 tokens, so shorter
  is better and faster.

### Step 2 — Get your Tavus API key

In the Tavus Developer Portal: **API Key -> Create New Key**, give it a name, and copy the key
(store it safely; it is shown once).

### Step 3 — Configure your environment

Copy the example env file and paste your key in:

```bash
cp .env.example .env
# then edit .env and set TAVUS_API_KEY=...
```

You can leave every other value commented out; the defaults are sensible (replica
`r2c3392fa1fc`, hosted model `tavus-claude-haiku-4.5`, 10-minute conversation cap). To use a
stock face instead, set `TAVUS_REPLICA_ID` — see `.env.example`.

### Step 4 — Run the setup script

```bash
uv run setup_demo.py
```

This reads `knowledge/ME.md`, builds a spoken-style system prompt, creates a Tavus **persona** (full
pipeline, stock replica, hosted LLM) and a live **conversation**, and writes a `demo.html` file. It
prints the `conversation_url` and the path to `demo.html`.

### Step 5 — Talk to your avatar

The script opens `demo.html` automatically (or open it yourself). The avatar joins the call and you'll
see the talking-head video.
Type a question in the box and press Enter; the avatar answers out loud in real time, and the latest
reply also shows as a caption. (If the browser asks for camera/mic, you can allow or skip it; this demo
only needs to send text.)

That's the proof of concept: **text in, an LLM that knows about you, realtime lifelike video out.**

### Step 6 — Personas are managed for you

A persona bakes your `knowledge/ME.md` into a prompt. The script handles its lifecycle, so you never
copy ids by hand:

- **First run** (no `TAVUS_PERSONA_ID` in `.env`): it creates a persona and writes the id back to `.env`
  automatically.
- **Later runs:** it reuses that persona and just opens a fresh conversation.
- **After you edit `ME.md`** (the prompt is fixed at creation time), rebuild the persona with:
  ```bash
  uv run setup_demo.py --update-persona
  ```
  This creates a fresh persona and overwrites `TAVUS_PERSONA_ID` in `.env`.

**Changing the face:** set `TAVUS_REPLICA_ID` in `.env` (see `.env.example` for a male example) and re-run
`uv run setup_demo.py`. The new replica wins immediately — the script passes it to each conversation,
overriding the persona's default — and a video-trained replica brings its own voice, so no persona
rebuild is needed (that's what Phase 3 does).

### Notes and limits

- **Each run is one live session.** A Tavus conversation is a single Daily room; once it ends (you
  leave the call, or it times out) the room is gone and `demo.html` will say "meeting does not exist".
  To talk again, just re-run `uv run setup_demo.py` — think of it as "start a new session". (There's a
  ~2 minute grace after you leave, so a quick refresh/rejoin still works.)
- The free tier includes about **25 live minutes total**. Each conversation here is capped at 10
  minutes (`DEMO_MAX_MINUTES`) so an idle tab doesn't drain them.
- The face is a stock Tavus person until Phase 3 — that's expected.

---

## Phase 2 — A polished web UI

A proper web app lives in `avatar/` (Vite + React + TypeScript) backed by a tiny zero-dependency Node
server in `avatar/backend/`. The backend holds your API key and creates/ends conversations; the frontend
has a custom-styled avatar stage, a live transcript, and a text box.

You choose how to talk to the avatar when you start a session:

- **Type** — text in, video out (no mic or camera, no permission prompt).
- **Talk** — your mic is on, so you speak and it replies (voice → video).
- **Face to face** — mic + camera, so it can see and hear you (video → video), with a self-view.

In any session the text box still works, and there are in-call **Mic** / **Camera** toggles.

### Prerequisites

- Node 20+.
- You've run Phase 1 at least once, so the root `.env` has `TAVUS_API_KEY` and a `TAVUS_PERSONA_ID`
  (the backend reuses that persona; it also reads `TAVUS_REPLICA_ID`).

### Run it

```bash
cd avatar
npm install
npm run dev
```

`npm run dev` starts the backend (reading the root `.env`) and the Vite dev server together. Open
**http://localhost:5173**, pick **Type**, **Talk**, or **Face to face**, and go. Each start is a fresh
session; click **End** (or close the tab) to stop it. (Talk/Face to face will prompt for mic/camera.)

### How it fits together

- `avatar/backend/server.mjs` — zero-dependency Node server. Reads the root `.env`, exposes
  `POST /api/conversations` and `POST /api/conversations/:id/end`, and calls the Tavus API with your key,
  which never reaches the browser. No dependencies, so the frontend's `npm run dev` starts it directly.
- `avatar/` (and `avatar/src/`) — the React frontend; the Vite dev server proxies `/api` to the backend.
  Styled with the project palette (`#ecad0a` / `#209dd7` / `#753991` over grays).

### Change the face/voice

Set `TAVUS_REPLICA_ID` in `.env` and restart `npm run dev` — the backend passes it on each new
conversation, so the face updates immediately. To keep the voice matched to the face, also run
`uv run setup_demo.py --update-persona` once so the reused persona is rebuilt around the new replica.

---

## Phase 3 — Make it look like you (paid)

You've already upgraded the account, so now you swap the stock face for your own: record a clip, let
Tavus train a replica of you, then change one line in `.env`. Do the recording in the **Tavus Developer
Portal** (the same site as your API key) — it hosts and validates the video for you, which is much
simpler than the raw `POST /v2/replicas` API.

### Step 1 — Go to the replica creation page

Sign in at **[platform.tavus.io](https://platform.tavus.io)** and open **Replicas** in the left nav,
then **Create Replica** — or jump straight there:
**[platform.tavus.io/dev/replicas/create](https://platform.tavus.io/dev/replicas/create)**.

This is the guided flow with upload checks and inline validation. Choose **video** training (not image):
video gives the most realistic clone and captures your real voice from the clip.

### Step 2 — Record (or upload) the ~60-second clip

That page gives you two ways to provide the footage:

- **Record in the browser** — quickest; the portal walks you through it and shows the consent text to
  read aloud. Good for a first pass.
- **Upload a pre-recorded file (recommended for best quality)** — record yourself with a desktop app
  first, then drag the file onto the page. On a Mac: **QuickTime Player -> File -> New Movie Recording**
  (choose Maximum quality; a recent MacBook camera or your iPhone via Continuity Camera gives 1080p),
  record, then **File -> Save**. Desktop recording beats the in-browser recorder on resolution and
  stability.

Either way, follow the spec exactly (full details in [TAVUS.md](./TAVUS.md) section 5):

- One continuous take, ~60s: **30s speaking** naturally (teeth visible, minimal movement, no hand
  gestures), then **30s still** (head still, eyes on camera, lips neutral and closed).
- 1080p+, 25+ FPS, `.mp4`, under 750 MB. Camera at eye level, face filling >=25% of the frame, sit
  ~3 ft back, neck visible, plain background, simple even lighting.
- **Open by reading the consent line verbatim** (the portal displays it):
  > "I, [FULL NAME], am currently speaking and consent Tavus to create an AI clone of me by using the
  > audio and video samples I provide. I understand that this AI clone can be used to create videos that
  > look and sound like me."

### Step 3 — Name it and train

Give the replica a name (e.g. `ed_replica`) and submit. Training runs **~4-5 hours**; the portal shows
the status and you can close the tab. When it finishes, the replica's page shows its **replica id**
(starts with `r`) — copy it. (Optional: for an even closer voice, clone yourself in ElevenLabs or
Cartesia — see [TAVUS.md](./TAVUS.md) section 6 — but the video already captures your voice, so you can
skip this.)

### Step 4 — Point the app at your face

In `.env`, set your new replica id:

```bash
TAVUS_REPLICA_ID=r...   # your new replica id
```

Rebuild the persona once so its default replica and voice match the new face:

```bash
uv run setup_demo.py --update-persona
```

Then start the site exactly as in [Phase 2](#phase-2--a-polished-web-ui):

```bash
cd avatar
npm run dev
```

Open http://localhost:5173 and pick a mode — it now joins as **you**, with your face and the voice from
your clip. Nothing else changes.

---

## Files

- `README.md` — this guide.
- `knowledge/ME.md` — the bio that makes the avatar you (edit this).
- `setup_demo.py` — Phase 1 script: creates the persona + conversation and writes `demo.html`.
- `.env.example` — environment template (copy to `.env`).
- `pyproject.toml` / `.python-version` / `uv.lock` — uv project, pinned to Python 3.12.
- `avatar/` — Phase 2 web app (Vite + React + TypeScript), self-contained.
  - `avatar/backend/` — its zero-dependency Node server (holds the API key, creates/ends conversations).
- `TAVUS.md` — detailed Tavus reference with links into the official docs.
- `CLAUDE.md` — project goals, requirements, and the decision to use Tavus.
