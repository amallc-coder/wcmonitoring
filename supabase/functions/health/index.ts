// Public health check (auth: "none"). Requires verify_jwt = false in config.toml.
import { withSupabase } from "npm:@supabase/server"

export default {
  fetch: withSupabase({ auth: "none" }, async () =>
    new Response(JSON.stringify({ ok: true, service: "wound-care", ts: new Date().toISOString() }),
      { headers: { "content-type": "application/json" } })),
}
