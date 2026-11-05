// Public project settings. The anon key is already public in the browser and
// grants nothing without row-level security, so it lives here rather than in a
// Netlify variable. ANTHROPIC_API_KEY is the only secret and the only variable.
export const SUPABASE_URL = "https://piiahxbeqsrzagjximoh.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBpaWFoeGJlcXNyemFnanhpbW9oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1OTg1NzMsImV4cCI6MjA5OTE3NDU3M30.cWRlOx3XfE1ImM84vCqglnql1NuS0OvVcao-Ulhqg1s";

export const MODELS = {
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

// Netlify stops synchronous functions at 60 seconds.
export const AI_TIMEOUT_MS = 50_000;

// Headers for a Supabase request made as the signed-in user, so row-level
// security and auth.uid() apply.
export function supabaseHeaders(token) {
  return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` };
}
