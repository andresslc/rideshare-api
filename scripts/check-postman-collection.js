/**
 * Checks the Postman collection against the Express routes defined in the code.
 *
 *   node scripts/check-postman-collection.js
 *
 * Exits non-zero when a route exists with no request, or a request points at a
 * route that no longer exists. Run it after touching any *.routes.js file: a
 * collection that quietly drifts from the API is worse than no collection.
 *
 * The test-run folder is skipped — it deliberately calls a retired endpoint to
 * assert it is gone.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FEATURES = path.join(ROOT, "src", "feature");
const COLLECTION = path.join(
  ROOT,
  "postman",
  "RideShare-API.postman_collection.json",
);

// Folders whose requests are assertions about the API rather than a map of it.
const EXCLUDED_FOLDER_PREFIXES = ["15."];

/* ── Routes defined in code ───────────────────────────────────────────────*/

const actual = new Set();

function collectRoutes(file, mountPath) {
  const source = fs.readFileSync(file, "utf8");

  const direct =
    /router\s*\.\s*(get|post|put|patch|delete)\s*\(\s*\n?\s*["'`]([^"'`]*)["'`]/g;
  const chained =
    /router\s*\.\s*route\s*\(\s*["'`]([^"'`]*)["'`][\s\S]{0,120}?\.\s*(get|post|put|patch|delete)\s*\(/g;

  const add = (method, routePath) => {
    const joined =
      `${mountPath}${routePath === "/" ? "" : routePath}`.replace(/\/$/, "") ||
      mountPath;
    actual.add(`${method.toUpperCase()} ${joined}`);
  };

  let match;
  while ((match = direct.exec(source))) add(match[1], match[2]);
  while ((match = chained.exec(source))) add(match[2], match[1]);
}

for (const feature of fs.readdirSync(FEATURES)) {
  const dir = path.join(FEATURES, feature);
  if (!fs.statSync(dir).isDirectory()) continue;

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".routes.js")) continue;

    const full = path.join(dir, file);
    const mount = fs
      .readFileSync(full, "utf8")
      .match(/path:\s*["'`]([^"'`]+)["'`]/);

    if (mount) {
      collectRoutes(full, mount[1]);
    } else if (file === "promo-code-campaign.routes.js") {
      // Exports a bare router; admin.routes.js mounts it at /campaigns.
      collectRoutes(full, "/admin/campaigns");
    }
  }
}

/* ── Requests declared in the collection ──────────────────────────────────*/

const collection = JSON.parse(fs.readFileSync(COLLECTION, "utf8"));
const declared = new Set();

function walk(items) {
  for (const item of items) {
    if (item.item) {
      if (EXCLUDED_FOLDER_PREFIXES.some((p) => item.name.startsWith(p))) {
        continue;
      }
      walk(item.item);
      continue;
    }
    const urlPath = `/${item.request.url.path.join("/")}`.replace(/\/$/, "");
    declared.add(`${item.request.method} ${urlPath}`);
  }
}
walk(collection.item);

/* ── Compare ──────────────────────────────────────────────────────────────*/

const missing = [...actual].filter((r) => !declared.has(r)).sort();
const stale = [...declared].filter((r) => !actual.has(r)).sort();

console.log(`Routes in code:            ${actual.size}`);
console.log(`Requests in collection:    ${declared.size}`);
console.log("");

if (missing.length) {
  console.log(
    `MISSING — route exists, no request covers it (${missing.length}):`,
  );
  missing.forEach((r) => console.log(`  - ${r}`));
  console.log("");
}

if (stale.length) {
  console.log(
    `STALE — request points at a route that is gone (${stale.length}):`,
  );
  stale.forEach((r) => console.log(`  - ${r}`));
  console.log("");
}

if (!missing.length && !stale.length) {
  console.log("Every route is covered exactly once, with no strays.");
}

process.exit(missing.length || stale.length ? 1 : 0);
