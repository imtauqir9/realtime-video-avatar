export type Conversation = { conversation_url: string; conversation_id: string; max_seconds?: number };

// Opened from an article ("Ask Imran about this"), the page carries ?brief=<link to a
// briefing on that article>. The backend fetches it (from an allowed host only) and
// the avatar starts the conversation already knowing the article.
function briefLink(): string {
  return new URLSearchParams(window.location.search).get("brief") || "";
}

// The title of the article this page was opened for, or "" when it was opened
// directly. A link that is not from the writing app, or has expired, reports why.
export async function getBrief(): Promise<{ title: string; error: string }> {
  const link = briefLink();
  if (!link) return { title: "", error: "" };
  const r = await fetch(`/api/brief?link=${encodeURIComponent(link)}`);
  const body = await r.json().catch(() => ({}));
  return r.ok ? { title: body.title || "", error: "" } : { title: "", error: body.error || "Could not read the article." };
}

export async function createConversation(): Promise<Conversation> {
  const brief = briefLink();
  const r = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(brief ? { brief } : {}),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    // The backend wraps every Tavus rejection as "Tavus create failed" and puts the real
    // reason (out of credits, replica not found, ...) in `detail`. Surface it or the user
    // sees a generic failure with no way to tell a billing problem from a broken id.
    const detail = e.detail?.message || e.detail?.error || (typeof e.detail === "string" ? e.detail : "");
    const base = e.error || `Failed to create conversation (HTTP ${r.status})`;
    throw new Error(detail ? `${base}: ${detail}` : base);
  }
  return r.json();
}

export async function endConversation(id: string): Promise<void> {
  await fetch(`/api/conversations/${id}/end`, { method: "POST" }).catch(() => {});
}

export type Me = { authRequired: boolean; authed: boolean };

export async function getMe(): Promise<Me> {
  const r = await fetch("/api/me");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function login(code: string): Promise<void> {
  const r = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `Sign-in failed (HTTP ${r.status})`);
  }
}

export async function logout(): Promise<void> {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
}

export type Replica = { image: string; video: string };

export async function getReplica(): Promise<Replica> {
  const r = await fetch("/api/replica");
  if (!r.ok) return { image: "", video: "" };
  return r.json();
}
