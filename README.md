# Care Connect — Wound & Skin Integrity Monitoring

Single-file clinical monitoring web app (`index.html`) for AMA SNF Provider Services.
Open `index.html` in a browser — no build step or server required.

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
