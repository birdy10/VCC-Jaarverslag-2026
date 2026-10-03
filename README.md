# VCC Season Facts

A single-page tool for VCC captains to pull remarkable facts and milestones from the KNCB Matchcentre for the jaarverslag.

## Update the data and rebuild

```
node scripts/fetch-data.mjs 2026   # fetch every VCC match of the season into data/season-2026.json
node scripts/build.mjs 2026        # build dist/vcc-season-facts-2026.html (+ .local.html to open in a browser)
```

Finished scorecards are cached in `cache/`, so re-running the fetch only downloads new or unfinished matches.
Add `--refresh` to download every scorecard again (picks up corrections made in the Matchcentre afterwards).

Or run `node scripts/serve.mjs 2026` and open http://localhost:5178/: the same page, with "Fetch new results" and
"Fetch everything again" buttons that run the fetch and the build, then reload. The published page can't fetch
by itself (the claude.ai viewer blocks calls to other sites), so publish it again after fetching.

Each fetch compares its result with the previous `data/season-<year>.json` and keeps a log of new results,
changed scorecards and renamed players; the page shows it under "Data updates". The fetch also checks every
scorecard for gaps (catcher/keeper/bowler not recorded, guest players without a profile, cards that don't add up,
missing fall of wicket or balls faced); the page lists them under "Matchcentre data issues".

Guest players (no Matchcentre profile) have match-local ids like -101 that the API reuses for other people in
other matches. The fetch gives each guest a stable id from club + name, or the registered player's id when the
same club has a player with exactly that name.

## Published on GitHub Pages

`.github/workflows/refresh.yml` fetches new results every night at 03:00 UTC, commits `data/` and `cache/`, rebuilds
the page and publishes it on GitHub Pages. To fetch right away: Actions → Refresh data → Run workflow (tick the box
to download every scorecard again). Changes to `src/` or `scripts/build.mjs` pushed to `main` rebuild the page without fetching.

Visitors without a GitHub account use the page's "Fetch latest results" button (under Data updates). It calls
`refresh-service/Code.gs`, a Google Apps Script web app that holds a GitHub token and starts the workflow: one fetch at
a time (a second press joins the running one), at most one every 10 minutes and 30 a day. The web app's address goes
in the repository variable `REFRESH_URL` (Settings → Secrets and variables → Actions → Variables); without it the page
links to the workflow on GitHub instead.

## Jaarverslag tables in Google Sheets / Docs

These tools stay on the local computer (not in the GitHub repository).

```
node scripts/export-tables.mjs 2024      # data/jaarverslag-2024.json: standings, team batting/bowling/fielding, special performances
node scripts/publish-to-drive.mjs 2024   # copies it (+ scripts/doc-mapping-2024.json) to Google Drive\...\jaarverslag-stats
python scripts/compare_docx.py <jaarverslag.docx> 2024   # compares an existing jaarverslag's tables with the export
```

`apps-script/Code.gs` runs in Google Apps Script: `setup()` makes a Google Docs copy of the jaarverslag, builds the stats
Sheet and fills the linked tables; `refreshSheet()` reloads new data; `updateDoc()` pushes Sheet edits into the Doc.
The Sheet's "Koppelingen" tab says which data table fills which document table (anchor heading/text + nth table after it).

## How it works

- `scripts/fetch-data.mjs` reads the ResultVault API (platform 134453, apiid 1002). Match scorecards need the
  `X-IAS-API-REQUEST` header: base64(3DES-ECB(unix seconds − 60)) keyed with the shared secret that the public
  Matchcentre site ships in its JavaScript.
- `src/stats.js` flattens matches into innings, spells, fielding and partnership rows and builds leaderboards.
  Fielding is counted from the dismissals (the API's Fielding records miss catches). Partnerships come from
  fall-of-wicket scores; stands involving a retired batter are marked approximate (~).
- `src/index.html` is the interface; the build inlines the stats engine and the data, because the published page
  can't call the API itself.
