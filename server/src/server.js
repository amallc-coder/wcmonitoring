"use strict";
const db = require("./db");
const { buildApp } = require("./app");
const { hashPassword } = require("./auth");

async function seed() {
  // Ensure an org exists
  let org = (await db.query("SELECT id FROM orgs ORDER BY id LIMIT 1")).rows[0];
  if (!org) {
    org = (await db.query("INSERT INTO orgs (name) VALUES ($1) RETURNING id", [process.env.ORG_NAME || "Clinilytics"])).rows[0];
  }
  // Ensure a seed admin exists
  const haveUsers = (await db.query("SELECT 1 FROM users WHERE org_id=$1 LIMIT 1", [org.id])).rows.length;
  if (!haveUsers) {
    const u = process.env.ADMIN_USER || "admin";
    const p = process.env.ADMIN_PASS;
    if (!p) { console.error("FATAL: ADMIN_PASS required to seed the first admin"); process.exit(1); }
    await db.query(
      "INSERT INTO users (org_id,username,name,role,pass_hash) VALUES ($1,$2,$3,'Admin',$4)",
      [org.id, u.toLowerCase(), process.env.ADMIN_NAME || "Administrator", await hashPassword(p)]
    );
    console.log("Seeded admin user '" + u + "'. Change the password after first login.");
  }
}

async function main() {
  // Retry DB connect (the replica/primary may still be starting under compose)
  for (let i = 0; i < 20; i++) {
    try { await db.init(); break; }
    catch (e) {
      console.log("DB not ready, retrying (" + (i + 1) + "/20)…");
      await new Promise(r => setTimeout(r, 2000));
      if (i === 19) { console.error("FATAL: could not initialize DB:", e.message); process.exit(1); }
    }
  }
  await seed();
  const app = buildApp();
  const port = parseInt(process.env.PORT || "8080", 10);
  app.listen(port, () => console.log("Clinilytics Wound-Care API listening on :" + port));
}

main();
