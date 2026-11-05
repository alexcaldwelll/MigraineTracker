import { SUPABASE_URL, supabaseHeaders } from "./config.js";

export function bearerToken(req) {
  const match = /^Bearer (\S+)$/i.exec(req.headers.get("Authorization") ?? "");
  return match ? match[1] : null;
}

// Returns the user for a valid token and null for a rejected one. Throws when
// Supabase cannot answer, so an outage or a rate limit is never read as either.
export async function getUser(token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: "GET",
    headers: supabaseHeaders(token),
  });
  if (res.status >= 500 || res.status === 429) throw new Error("Supabase Auth unavailable");
  if (!res.ok) return null;
  const user = await res.json();
  return typeof user?.id === "string" ? { id: user.id } : null;
}
