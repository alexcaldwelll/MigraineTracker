import { SUPABASE_URL, supabaseHeaders } from "./config.js";

// Spends one unit of today's quota. The user's own token is required: the
// function reads auth.uid(), which is null for any other caller.
export async function consumeQuota(token, action) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/consume_ai_quota`, {
    method: "POST",
    headers: { ...supabaseHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ p_action: action }),
  });
  if (!res.ok) throw new Error("Quota check failed");
  return (await res.json()) === true;
}
