# Clinilytics — Wound Care

Single-file clinical monitoring web app (`index.html`). The product is branded
**Clinilytics** with **Wound Care** as the module; the UI uses the Clinilytics
light theme (white cards, charcoal text, sage-green + terracotta accents,
monospace data, lowercase `clinilytics` wordmark + black module pill).
Open `index.html` in a browser — no build step or server required.

Report delivery: *Email Report* generates a real **PDF** (jsPDF) of the weekly
wound report and either attaches it via the native share sheet (where supported)
or downloads it for manual attachment, then opens the pre-filled email draft.
Chart.js, jsPDF, and jsPDF-AutoTable load from CDN at runtime.

This app is **focused exclusively on wound & skin integrity**. The Dashboard,
Census & Facilities, Wound Care, and Reports tabs are all wound-centric; the
former Psych / Primary Services / Quality Assurance modules were removed (those
service lines are owned by other projects).

## Access

A client-side sign-in gate protects the data (username + SHA-256 password hash,
session-scoped). This is a lightweight gate suitable for a demo, not server-side
auth — anyone reading the page source can find the hash.

## What's new (call-feedback build)

- **Facility contacts & report distribution** — each facility carries a DON /
  contact name, email, and phone (Census & Facilities → *Edit Contact*). Weekly
  wound reports can be emailed to the facility via the user's mail client
  (*Email Report*), with a session distribution log. *(True automatic/scheduled
  SMTP needs a backend, which a static GitHub Pages site cannot host.)*
- **Graft / collagen / PCR tracking** — wounds record graft-in-place (+ type/date),
  collagen-in-use, and wound-care PCR (required / completed / date). Surfaced in
  the wound table, chart editor, dashboard, and reports.
- **Clinical trigger / action-plan engine** — criteria (stagnant ≥7d, slow/worsening,
  active infection, non-healing ≥30d without a graft, PCR ordered-not-done, low
  albumin, long-term pressure wound, high Braden risk) fire a recommended action.
  Each trigger stays **open until the provider logs an action plan _or_ documents a
  reason for not acting** — both are written to the wound's chart history.
- **Provider watch lists** — wounds carry an owning provider; the Active Wounds
  view and reports can be filtered/broken down by provider.
- **Enterprise → portfolio → facility reporting** — wound reports roll up by scope
  with healing rate, pressure vs non-pressure, healing status, provider breakdown,
  and **automatic education recommendations** when a facility/portfolio falls below
  the healing-rate target. A period selector (Current / Monthly / Quarterly)
  labels leadership reports.

## Wound & Skin Integrity module

The Wound tab is organized into six sub-views, built to mirror the AMA Advanced
Wound & Skin Integrity Program brainstorm:

- **Active Wounds** — every wound captured (pressure vs non-pressure), with the
  existing triggers: *stale* (no change in 7 days → re-evaluate) and *long-term*
  (pressure wound nearing/past 100 days).
- **Data Analytics** — total, new (30d), healed, healing rate, average healing
  time, Stage 2+, infected, wound-related hospitalizations; etiology / healing /
  trend charts; facility benchmarks and quarterly metrics.
- **Quality Measures (QAPI)** — the four CMS-aligned targets: pressure-ulcer
  prevalence, new / facility-acquired pressure injuries, infection rate, and RTH.
- **Skin Integrity & Braden** — whole-census watch list; Braden ≤14 hot list for
  twice-weekly oversight and pressure-prevention review.
- **Wound Rounds** — weekly rounds schedule and compliance; overdue wounds flagged.
- **Rehospitalizations** — wound-related transfers (cellulitis, osteomyelitis,
  sepsis), readmissions, and preventability tracking.

Reports (on-screen and printable) and per-facility weekly reports include the new
analytics and a wound-related rehospitalization section.

The wound chart editor captures wound origin (POA vs facility-acquired), Braden
score, debridement type, wound VAC, albumin, vascular screening, and nutrition
consult in addition to stage, measurements, healing, and infection.
