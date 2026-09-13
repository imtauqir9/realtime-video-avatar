export type Conversation = { conversation_url: string; conversation_id: string };

export async function createConversation(): Promise<Conversation> {
  const r = await fetch("/api/conversations", { method: "POST" });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `Failed to create conversation (HTTP ${r.status})`);
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
