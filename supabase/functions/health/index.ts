// Public health check (auth: "none"). Requires verify_jwt = false in config.toml.
import { withSupabase } from "npm:@supabase/server"

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }
const _handler = withSupabase({ auth: "none" }, async () =>
  new Response(JSON.stringify({ ok: true, service: "wound-care", ts: new Date().toISOString() }),
    { headers: { "content-type": "application/json", ...CORS } }))

export default {
  fetch: async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
    const res = await _handler(req)
    const h = new Headers(res.headers); Object.entries(CORS).forEach(([k, v]) => h.set(k, v))
    return new Response(res.body, { status: res.status, headers: h })
  },
}
