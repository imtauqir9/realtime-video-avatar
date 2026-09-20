"""Create a Tavus persona + live conversation for a realtime video avatar demo.

Reads your bio from knowledge/ME.md, builds a spoken-style system prompt, creates a Tavus
persona (full pipeline, stock replica, hosted LLM) and a live conversation, then writes
demo.html. Open that file in a browser and type to talk to your avatar in real time.

Usage:  uv run setup_demo.py
"""

import argparse
import os
import sys
import webbrowser
from pathlib import Path

import httpx
from dotenv import load_dotenv

API_BASE = "https://tavusapi.com/v2"
ROOT = Path(__file__).parent

SYSTEM_PROMPT_TEMPLATE = """You are a real-time video avatar of {name}. You speak and appear as {name}, always in the first person.

This is a spoken, face-to-face video conversation, so:
- Speak BRIEFLY in natural, flowing, plain spoken language, the way a real person talks interactively.
- IMPORTANT: Keep answers short, conversational and friendly: usually a phrase, never more than a sentence, and as short as the moment allows. For greetings and small talk, keep it really brief. For example, if asked "Hi there! How are you?", reply like "I'm great, thanks. How about you?"
- Never use markdown, bullet points, headings, code blocks, emojis or em-dashes. Never read a URL or email aloud; if someone needs a link, just tell them in plain words where to find it.
- Only use what you genuinely know about yourself from the notes below. If you do not know something, say so briefly and move on.

Here is everything you know about yourself:

{knowledge}

Remember: this is a quick, interactive spoken chat. Answer in a phrase or a sentence, and share only what is relevant to what they just asked - do not recite your background unprompted.
"""

DEMO_HTML = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Video Avatar Demo</title>
  <script src="https://unpkg.com/@daily-co/daily-js"></script>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #0b0b0f; color: #eee; }
    #stage { display: flex; flex-direction: column; height: 100vh; }
    header { padding: 12px 16px; font-weight: 600; }
    #video { flex: 1; min-height: 0; }
    #caption { padding: 8px 16px; min-height: 1.4em; color: #9ad8ff; }
    #bar { display: flex; gap: 8px; padding: 12px 16px; background: #15151c; }
    #msg { flex: 1; padding: 12px; border-radius: 8px; border: 1px solid #333; background: #1d1d26; color: #eee; font-size: 16px; }
    button { padding: 12px 18px; border: 0; border-radius: 8px; background: #4f7cff; color: #fff; font-size: 16px; cursor: pointer; }
  </style>
</head>
<body>
  <div id="stage">
    <header>Video Avatar Demo &mdash; type a question and press Enter</header>
    <div id="video"></div>
    <div id="caption"></div>
    <form id="bar">
      <input id="msg" autocomplete="off" placeholder="Ask me anything..." />
      <button type="submit">Send</button>
    </form>
  </div>
  <script>
    const CONVERSATION_URL = "__CONVERSATION_URL__";
    const CONVERSATION_ID = "__CONVERSATION_ID__";

    const call = window.Daily.createFrame(document.getElementById("video"), {
      showLeaveButton: true,
      iframeStyle: { width: "100%", height: "100%", border: "0" },
    });
    call.join({ url: CONVERSATION_URL });

    const caption = document.getElementById("caption");
    call.on("app-message", (ev) => {
      const d = (ev && ev.data) || {};
      if (d.event_type === "conversation.utterance" && d.properties && d.properties.role === "replica") {
        caption.textContent = d.properties.speech || "";
      }
    });

    const form = document.getElementById("bar");
    const input = document.getElementById("msg");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      call.sendAppMessage({
        message_type: "conversation",
        event_type: "conversation.respond",
        conversation_id: CONVERSATION_ID,
        properties: { text: text },
      }, "*");
      input.value = "";
    });
  </script>
</body>
</html>
"""


def die(msg: str) -> None:
    print(f"\nError: {msg}\n", file=sys.stderr)
    sys.exit(1)


def set_env_var(env_path: Path, key: str, value: str) -> None:
    """Set KEY=value in the .env file, replacing any existing or commented line for KEY.

    Writes LF newlines, so it behaves the same on macOS, Linux and Windows whether or
    not the key was already present.
    """
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    assignment = f"{key}={value}"
    for i, line in enumerate(lines):
        if line.strip().lstrip("#").strip().startswith(f"{key}="):
            lines[i] = assignment
            break
    else:
        lines.append(assignment)
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def end_active_conversations(client) -> None:
    """Best-effort: end any still-active conversations so a new one can start.

    The free tier allows only one concurrent conversation, and each run leaves the
    previous one live until it times out, so we clean up first.
    """
    try:
        convs = client.get("/conversations", params={"limit": 100}).json().get("data", [])
    except Exception:
        return
    for c in convs:
        if c.get("status") == "active":
            try:
                client.post(f"/conversations/{c['conversation_id']}/end")
            except Exception:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a Tavus persona + conversation for the video avatar demo."
    )
    parser.add_argument(
        "--update-persona", action="store_true",
        help="(Re)create the persona from knowledge/ME.md and save its id to .env. "
             "Happens automatically when no TAVUS_PERSONA_ID is set. Use this after editing ME.md.",
    )
    args = parser.parse_args()

    env_path = ROOT / ".env"
    load_dotenv(env_path)

    api_key = os.environ.get("TAVUS_API_KEY", "").strip()
    if not api_key:
        die("TAVUS_API_KEY is not set. Copy .env.example to .env and paste your key.")

    knowledge_file = ROOT / os.environ.get("KNOWLEDGE_FILE", "knowledge/ME.md")
    if not knowledge_file.exists():
        die(f"{knowledge_file} not found. Create it first (see README, Phase 1).")
    knowledge = knowledge_file.read_text(encoding="utf-8").strip()

    name = next(
        (line[2:].strip() for line in knowledge.splitlines() if line.startswith("# ")),
        "the person described below",
    )

    replica_id = os.environ.get("TAVUS_REPLICA_ID", "r045d2c98f20").strip()
    llm_model = os.environ.get("TAVUS_LLM_MODEL", "tavus-claude-haiku-4.5").strip()
    max_minutes = int(os.environ.get("DEMO_MAX_MINUTES", "10"))

    headers = {"x-api-key": api_key, "Content-Type": "application/json"}
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(name=name, knowledge=knowledge)

    with httpx.Client(base_url=API_BASE, headers=headers, timeout=60) as client:
        existing_persona = os.environ.get("TAVUS_PERSONA_ID", "").strip()
        if args.update_persona or not existing_persona:
            reason = "--update-persona" if existing_persona else "no TAVUS_PERSONA_ID set"
            print(f"Creating persona for {name} ({reason})...")
            r = client.post("/personas", json={
                "persona_name": f"{name} (video avatar demo)",
                "system_prompt": system_prompt,
                "pipeline_mode": "full",
                "default_replica_id": replica_id,
                # turn-taking patience low: shorten the wait after the user stops before the avatar replies
                "layers": {
                    "llm": {"model": llm_model},
                    "conversational_flow": {"turn_taking_patience": "low"},
                },
            })
            if r.status_code >= 300:
                die(f"Create persona failed ({r.status_code}): {r.text}")
            persona_id = r.json()["persona_id"]
            set_env_var(env_path, "TAVUS_PERSONA_ID", persona_id)
            print(f"  persona_id = {persona_id}  (saved to .env)")
        else:
            persona_id = existing_persona
            print(f"Reusing persona {persona_id}  (use --update-persona after editing knowledge/ME.md)")

        end_active_conversations(client)  # free the concurrency slot from any prior session

        print("Creating conversation...")
        r = client.post("/conversations", json={
            "persona_id": persona_id,
            "replica_id": replica_id,  # overrides the persona's default replica, so TAVUS_REPLICA_ID always wins
            "conversation_name": f"{name} video avatar demo",
            "properties": {
                "max_call_duration": max_minutes * 60,
                # grace period so a quick refresh/rejoin doesn't kill the session (default is 0)
                "participant_left_timeout": 120,
                "enable_closed_captions": True,
                "language": "english",
            },
        })
        if r.status_code >= 300:
            die(f"Create conversation failed ({r.status_code}): {r.text}")
        conv = r.json()

    conversation_url = conv["conversation_url"]
    conversation_id = conv["conversation_id"]

    out = ROOT / "demo.html"
    out.write_text(
        DEMO_HTML.replace("__CONVERSATION_URL__", conversation_url).replace("__CONVERSATION_ID__", conversation_id),
        encoding="utf-8",
    )

    print("\nReady - opening demo.html in your browser.")
    print(f"  conversation_url : {conversation_url}")
    print(f"  demo file        : {out}")
    print(f"  (this is one live session; it auto-ends ~2 min after you leave or after {max_minutes} min."
          " Re-run to start a new one. Free tier gives ~25 live minutes total.)\n")
    webbrowser.open(out.as_uri())


if __name__ == "__main__":
    main()
