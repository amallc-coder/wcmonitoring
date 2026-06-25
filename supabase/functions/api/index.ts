// Clinilytics Wound Care — Supabase Edge Function (auth: "user").
// Uses @supabase/server: withSupabase validates the caller's JWT and injects an
// RLS-scoped client (ctx.supabase) plus an admin client (ctx.supabaseAdmin).
// Every query runs as the signed-in user, so org-scoped RLS does the access control.
//
// Routes (base: /functions/v1/api):
//   GET    /api/<table>            list rows in the caller's org
//   GET    /api/<table>/<id>       one row
//   POST   /api/<table>            create (org_id auto-stamped by trigger)
//   PATCH  /api/<table>/<id>       update
//   DELETE /api/<table>/<id>       delete
// <table> ∈ facilities | patients | wounds
//
// On Supabase Edge Functions SUPABASE_URL / keys / JWKS are injected automatically.
import { withSupabase } from "npm:@supabase/server"

const TABLES = new Set(["facilities", "patients", "wounds"])
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export default {
  fetch: withSupabase({ auth: "user" }, async (req: Request, ctx: any) => {
    const url = new URL(req.url)
    const parts = url.pathname.split("/").filter(Boolean)
    const i = parts.indexOf("api")
    const table = i >= 0 ? parts[i + 1] : undefined
    const id = i >= 0 ? parts[i + 2] : undefined

    if (!table || !TABLES.has(table)) return json({ error: "Unknown resource" }, 404)
    const db = ctx.supabase.from(table)

    try {
      if (req.method === "GET") {
        const q = id ? db.select("*").eq("id", id).single() : db.select("*").order("updated_at", { ascending: false })
        const { data, error } = await q
        if (error) throw error
        return json(data)
      }
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({}))
        const { data, error } = await db.insert(body).select().single()
        if (error) throw error
        return json(data, 201)
      }
      if ((req.method === "PATCH" || req.method === "PUT") && id) {
        const body = await req.json().catch(() => ({}))
        const { data, error } = await db.update(body).eq("id", id).select().single()
        if (error) throw error
        return json(data)
      }
      if (req.method === "DELETE" && id) {
        const { error } = await db.delete().eq("id", id)
        if (error) throw error
        return json({ ok: true })
      }
      return json({ error: "Method not allowed" }, 405)
    } catch (e: any) {
      // RLS denials surface here as Postgres errors — return 403 rather than 500.
      const msg = (e && e.message) || "request failed"
      const status = /row-level security|permission|denied/i.test(msg) ? 403 : 400
      return json({ error: msg }, status)
    }
  }),
}
