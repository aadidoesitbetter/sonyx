const API_URL = process.env.BOT_API_URL ?? "http://localhost:4000";
const API_SECRET = process.env.API_SECRET ?? "sonyx-internal";

async function botFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_SECRET}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getGuildData(guildId: string) {
  return botFetch(`/guilds/${guildId}`);
}

export async function updateGuildSettings(guildId: string, data: Record<string, unknown>) {
  return botFetch(`/guilds/${guildId}/settings`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function playerAction(guildId: string, action: string) {
  return botFetch(`/guilds/${guildId}/player/${action}`, { method: "POST" });
}

export async function getUserProfile(userId: string) {
  return botFetch(`/users/me/profile?userId=${userId}`);
}
