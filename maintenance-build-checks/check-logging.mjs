import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Run against the final Linux bundle, without a Gateway, operator state, or network.
assert.equal(process.platform, "linux", "The stale-directory proof requires Linux /proc");
const required = [
  "ensureLogDirectorySync",
  "getLogger",
  "setLoggerOverride",
  "resetLogger",
  "flushLogger",
  "registerSecretValueForRedaction",
];
const modules = new Map();
const owners = new Map();
for (const file of fs.readdirSync("/app/dist")) {
  if (!file.endsWith(".js")) {
    continue;
  }
  const source = fs.readFileSync(path.join("/app/dist", file), "utf8");
  const found = required.filter((name) =>
    new RegExp(`(?:async )?function ${name}\\(`, "u").test(source),
  );
  if (found.length === 0) {
    continue;
  }
  const url = pathToFileURL(path.join("/app/dist", file)).href;
  modules.set(url, found);
  for (const name of found) {
    assert.ok(!owners.has(name), `Locate unique compiled logging owner: ${name}`);
    owners.set(name, url);
  }
}
for (const name of required) {
  assert.ok(owners.has(name), `Missing compiled logging function: ${name}`);
}

const scenario = process.argv[2];
if (!scenario) {
  for (const name of ["directories", "transport"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], {
      encoding: "utf8",
      timeout: 20_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `${name}: child terminated unexpectedly`);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    const proof = JSON.parse(result.stdout.trim());
    assert.equal(proof.scenario, name);
    assert.equal(proof.passed, true);
  }
  console.log(
    JSON.stringify({
      check: "compiled-logging",
      cases: 6,
      staleParentBounded: true,
      retainedLoggerRollover: true,
      network: "unused",
    }),
  );
} else {
  assert.ok(scenario === "directories" || scenario === "transport");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-logging-check-"));
  const originalDate = globalThis.Date;
  const writeStderr = process.stderr.write;
  let descriptor;
  try {
    // Prevent the compiled logger's config reader from consulting operator state.
    process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
    process.env.OPENCLAW_CONFIG_PATH = path.join(root, "missing-config.json");
    process.env.OPENCLAW_HOME = root;
    process.env.OPENCLAW_LOG_LEVEL = "info";
    registerHooks({
      load(url, context, next) {
        const result = next(url, context);
        const names = modules.get(url);
        return names
          ? {
              ...result,
              source: `${result.source}\nexport { ${names.map((name) => `${name} as __loggingCheck_${name}`).join(", ")} };`,
            }
          : result;
      },
    });
    const exported = {};
    for (const [url, names] of modules) {
      const module = await import(url);
      for (const name of names) {
        exported[name] = module[`__loggingCheck_${name}`];
      }
    }
    const {
      ensureLogDirectorySync,
      getLogger,
      setLoggerOverride,
      resetLogger,
      flushLogger,
      registerSecretValueForRedaction,
    } = exported;

    if (scenario === "directories") {
      const nested = path.join(root, "normal", "nested");
      ensureLogDirectorySync(nested);
      assert.equal(fs.statSync(nested).isDirectory(), true);
      ensureLogDirectorySync(nested);
      const nonDirectory = path.join(root, "ordinary-file");
      fs.writeFileSync(nonDirectory, "file");
      assert.throws(() => ensureLogDirectorySync(nonDirectory), { code: "EEXIST" });
      assert.throws(() => ensureLogDirectorySync(path.join(nonDirectory, "child")), {
        code: "ENOTDIR",
      });
      const stale = path.join(root, "stale");
      fs.mkdirSync(stale);
      descriptor = fs.openSync(stale, "r");
      fs.rmdirSync(stale);
      assert.equal(fs.statSync(`/proc/self/fd/${descriptor}`).isDirectory(), true);
      // On unfixed Node recursive mkdir this exact Linux shape can never return.
      assert.throws(() => ensureLogDirectorySync(`/proc/self/fd/${descriptor}/missing/child`), {
        code: "ENOENT",
      });
    } else {
      const secret = "logging-smoke-secret-0123456789";
      registerSecretValueForRedaction(secret);
      const regularLog = path.join(root, "regular", "openclaw.log");
      setLoggerOverride({ level: "info", file: regularLog });
      getLogger().info(`normal-record ${secret}`);
      await flushLogger();
      const normal = fs.readFileSync(regularLog, "utf8");
      assert.ok(normal.includes("normal-record"));
      assert.ok(!normal.includes(secret), "Normal records must retain secret redaction");

      const rotationLog = path.join(root, "rotation.log");
      setLoggerOverride({ level: "info", file: rotationLog, maxFileBytes: 1 });
      const rotating = getLogger();
      rotating.info("before-size-rotation");
      await flushLogger();
      rotating.info("after-size-rotation");
      await flushLogger();
      assert.ok(
        fs.readFileSync(path.join(root, "rotation.1.log"), "utf8").includes("before-size-rotation"),
      );
      assert.ok(fs.readFileSync(rotationLog, "utf8").includes("after-size-rotation"));

      let now = originalDate.parse("2026-01-01T12:00:00Z");
      globalThis.Date = class extends originalDate {
        constructor(...args) {
          super(...(args.length ? args : [now]));
        }
        static now() {
          return now;
        }
      };
      const stale = path.join(root, "rollover-parent");
      fs.mkdirSync(stale);
      descriptor = fs.openSync(stale, "r");
      const logDir = `/proc/self/fd/${descriptor}/${secret}`;
      setLoggerOverride({
        level: "info",
        file: `${logDir}/openclaw-2026-01-01.log`,
        consoleStyle: "compact",
      });
      const retained = getLogger();
      // The old API creates its directory eagerly; only remove it after acquisition.
      fs.rmdirSync(path.join(stale, secret));
      fs.rmdirSync(stale);
      now += 24 * 60 * 60 * 1000;
      const warnings = [];
      process.stderr.write = (chunk) => {
        warnings.push(String(chunk));
        return true;
      };
      retained.info("only-record-after-date-rollover");
      await flushLogger();
      await new Promise((resolve) => setImmediate(resolve));
      const dropped = warnings.filter((line) => line.includes("log file append failed"));
      assert.equal(dropped.length, 1, "The first and only lost rollover record must be reported");
      assert.ok(dropped[0].includes("record dropped"));
      assert.ok(!warnings.join("\n").includes(secret), "Failure paths must remain redacted");
      resetLogger();
    }
    console.log(JSON.stringify({ scenario, passed: true }));
  } finally {
    process.stderr.write = writeStderr;
    globalThis.Date = originalDate;
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    // root is the unique directory this process created above, never operator state.
    fs.rmSync(root, { recursive: true, force: true });
  }
}
