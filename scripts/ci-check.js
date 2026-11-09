// Pre-deploy gate. Fails on anything that would stop the server from booting:
// 1. Invalid JSON anywhere in the repo (e.g. a comma lost in a merge)
// 2. JavaScript syntax errors, including files not loaded at boot
// 3. App start-up: loads app.js, every *.routes.js and every *.cron.js,
//    with no DB or Redis
//
// Run locally with: npm run check
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const { generateKeyPairSync } = require("crypto");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "uploads", "coverage"]);
const failures = [];

const walk = (dir, ext, files = []) => {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(item.name)) continue;
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) walk(fullPath, ext, files);
    else if (item.name.endsWith(ext)) files.push(fullPath);
  }
  return files;
};

const rel = (file) => path.relative(ROOT, file);

// First line only: drops Node's "Require stack" list and colour codes.
const firstLine = (value) =>
  String(value?.message ?? value)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")[0];

const checkJson = () => {
  const files = walk(ROOT, ".json");
  for (const file of files) {
    try {
      JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      failures.push(`Invalid JSON in ${rel(file)}: ${error.message}`);
    }
  }
  console.log(`JSON: ${files.length} files checked`);
};

const checkJsSyntax = () => {
  const files = walk(ROOT, ".js");
  for (const file of files) {
    try {
      new vm.Script(Module.wrap(fs.readFileSync(file, "utf8")), {
        filename: file,
      });
    } catch (error) {
      failures.push(`Syntax error in ${rel(file)}: ${error.message}`);
    }
  }
  console.log(`JS syntax: ${files.length} files checked`);
};

// firebase-adminsdk.json is gitignored but required at import time, so CI
// gets a throwaway service account. A real local copy is never touched.
const ensureFirebasePlaceholder = () => {
  const file = path.join(ROOT, "firebase-adminsdk.json");
  if (fs.existsSync(file)) return () => {};

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: "service_account",
      project_id: "ci-placeholder",
      private_key_id: "ci-placeholder",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      client_email: "ci@ci-placeholder.iam.gserviceaccount.com",
      client_id: "0",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  );
  return () => fs.rmSync(file, { force: true });
};

const checkBoot = () => {
  process.env.REDIS_IS_ENABLED = "false";
  process.env.BULLMQ_ENABLED = "false";

  // routeAdder logs a failed route and carries on, so the server would boot
  // with that feature's endpoints missing. Treat that log as a failure.
  const originalError = console.error;
  console.error = (...args) => {
    if (String(args[0]).includes("Failed to load route")) {
      const [label, error] = args.map(firstLine);
      failures.push(`${label.replace(/^\W+/, "")}: ${error}`);
    }
    originalError(...args);
  };

  const removePlaceholder = ensureFirebasePlaceholder();
  try {
    require(path.join(ROOT, "app.js"));
    console.log("Boot: app.js and all routes loaded");

    // app.js only loads crons after the queue connects to Redis, and a failure
    // there is logged, not thrown. Load each cron module directly instead.
    // *.worker.js files open a Redis connection on load, so they get the
    // syntax check only.
    const crons = walk(path.join(ROOT, "src", "feature"), ".cron.js");
    for (const file of crons) {
      try {
        require(file);
      } catch (error) {
        failures.push(`Cron failed to load: ${rel(file)}: ${firstLine(error)}`);
      }
    }
    console.log(`Boot: ${crons.length} cron files loaded`);
  } catch (error) {
    failures.push(`App failed to boot: ${error.stack || error.message}`);
  } finally {
    removePlaceholder();
    console.error = originalError;
  }
};

checkJson();
checkJsSyntax();
if (failures.length === 0) checkBoot();

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s) found:\n`);
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}

console.log("\nAll checks passed");
process.exit(0);
