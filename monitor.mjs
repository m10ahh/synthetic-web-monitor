import fs from "fs";
import { spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";

const SLOW_REQUEST_THRESHOLD_MS = 3000;
const AUDIT_TIMEOUT_MS = 70000;
const MAX_PARALLEL_AUDITS = 2;


// =========================================================
// Validate environment variables
// =========================================================

if (!process.env.SUPABASE_URL) {
  console.error("Missing database URL.");
  process.exit(1);
}

if (!process.env.SUPABASE_KEY) {
  console.error("Missing database key.");
  process.exit(1);
}

if (!process.env.MONITOR_CONFIG) {
  console.error("Missing monitor configuration.");
  process.exit(1);
}


// =========================================================
// Read private monitor configuration
// =========================================================

let pages;

try {
  pages = JSON.parse(process.env.MONITOR_CONFIG);
} catch {
  console.error("Invalid monitor configuration.");
  process.exit(1);
}

if (!Array.isArray(pages) || pages.length === 0) {
  console.error("No pages configured.");
  process.exit(1);
}


// =========================================================
// Supabase connection
// =========================================================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  {
    auth: {
      persistSession: false
    }
  }
);


// =========================================================
// Devices
// Lighthouse default configuration = mobile
// Desktop uses the official desktop preset
// =========================================================

const devices = [
  {
    name: "mobile",
    extraArgs: []
  },
  {
    name: "desktop",
    extraArgs: ["--preset=desktop"]
  }
];


// =========================================================
// Build audit tasks
// =========================================================

const tasks = [];

for (const page of pages) {

  if (
    !Number.isInteger(page.page_id) ||
    typeof page.url !== "string"
  ) {
    console.error("Invalid page configuration.");
    process.exit(1);
  }

  for (const device of devices) {

    tasks.push({
      page_id: page.page_id,
      url: page.url,
      device: device.name,
      extraArgs: device.extraArgs
    });

  }
}


// =========================================================
// Execute Lighthouse
// URL is never printed in public logs
// =========================================================

function executeLighthouse(task, outputPath) {

  return new Promise((resolve) => {

    const args = [
      "--no-install",
      "lighthouse",
      task.url,
      "--only-categories=performance",
      "--output=json",
      `--output-path=${outputPath}`,
      "--max-wait-for-load=45000",
      "--quiet",
      "--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage",
      ...task.extraArgs
    ];

    const child = spawn(
      "npx",
      args,
      {
        stdio: ["ignore", "ignore", "ignore"]
      }
    );

    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, AUDIT_TIMEOUT_MS);

    child.on("error", () => {

      clearTimeout(timer);

      resolve({
        exitCode: null,
        timedOut: false,
        processError: true
      });

    });

    child.on("close", (code) => {

      clearTimeout(timer);

      resolve({
        exitCode: code,
        timedOut,
        processError: false
      });

    });

  });
}


// =========================================================
// Extract Lighthouse metrics
// =========================================================

function buildRecord(task, outputPath, processResult) {

  const record = {

    page_id: task.page_id,
    device: task.device,

    performance_score: null,
    lcp_ms: null,
    fcp_ms: null,
    cls: null,
    tbt_ms: null,
    speed_index_ms: null,

    total_requests: null,
    failed_requests: null,
    http_4xx: null,
    http_5xx: null,
    console_errors: null,
    slow_requests: null,
    page_size_kb: null,

    audit_status: "failed",
    error_type: null,
    lighthouse_version: null

  };


  // -------------------------------------------------------
  // Process failures
  // -------------------------------------------------------

  if (processResult.timedOut) {

    record.error_type = "AUDIT_TIMEOUT";
    return record;

  }

  if (processResult.processError) {

    record.error_type = "PROCESS_ERROR";
    return record;

  }

  if (!fs.existsSync(outputPath)) {

    record.error_type = "NO_RESULT_FILE";
    return record;

  }


  // -------------------------------------------------------
  // Read Lighthouse JSON
  // -------------------------------------------------------

  let result;

  try {

    result = JSON.parse(
      fs.readFileSync(outputPath, "utf8")
    );

  } catch {

    record.error_type = "INVALID_RESULT";
    return record;

  }


  const audits = result.audits ?? {};


  // =======================================================
  // Core performance metrics
  // =======================================================

  const score =
    result.categories?.performance?.score;

  record.performance_score =
    typeof score === "number"
      ? score * 100
      : null;


  record.lcp_ms =
    audits["largest-contentful-paint"]?.numericValue ?? null;

  record.fcp_ms =
    audits["first-contentful-paint"]?.numericValue ?? null;

  record.cls =
    audits["cumulative-layout-shift"]?.numericValue ?? null;

  record.tbt_ms =
    audits["total-blocking-time"]?.numericValue ?? null;

  record.speed_index_ms =
    audits["speed-index"]?.numericValue ?? null;


  // =======================================================
  // Network diagnostics
  // =======================================================

  const networkRequests =
    audits["network-requests"]?.details?.items ?? [];


  record.total_requests =
    networkRequests.length;


  record.http_4xx =
    networkRequests.filter((request) => {

      const status =
        Number(request.statusCode);

      return (
        status >= 400 &&
        status < 500
      );

    }).length;


  record.http_5xx =
    networkRequests.filter((request) => {

      const status =
        Number(request.statusCode);

      return (
        status >= 500 &&
        status < 600
      );

    }).length;


  record.failed_requests =
    networkRequests.filter((request) => {

      const status =
        Number(request.statusCode);

      return (
        request.finished === false ||
        (
          Number.isFinite(status) &&
          status >= 400
        )
      );

    }).length;


  // =======================================================
  // Slow requests
  // =======================================================

  record.slow_requests =
    networkRequests.filter((request) => {

      const start =
        Number(request.startTime);

      const end =
        Number(request.endTime);

      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end)
      ) {
        return false;
      }

      const durationMs =
        (end - start) * 1000;

      return (
        durationMs >=
        SLOW_REQUEST_THRESHOLD_MS
      );

    }).length;


  // =======================================================
  // Page transfer size
  // =======================================================

  const totalTransferBytes =
    networkRequests.reduce(
      (sum, request) =>
        sum +
        (
          Number(request.transferSize) || 0
        ),
      0
    );


  record.page_size_kb =
    totalTransferBytes / 1024;


  // =======================================================
  // JavaScript / console errors
  // =======================================================

  record.console_errors =
    audits["errors-in-console"]
      ?.details
      ?.items
      ?.length ?? 0;


  // =======================================================
  // Lighthouse version
  // =======================================================

  record.lighthouse_version =
    result.lighthouseVersion ?? null;


  // =======================================================
  // Audit status
  // =======================================================

  if (result.runtimeError?.code) {

    record.audit_status = "failed";

    record.error_type =
      String(result.runtimeError.code);

  } else if (processResult.exitCode === 0) {

    record.audit_status = "success";
    record.error_type = null;

  } else {

    record.audit_status = "failed";
    record.error_type = "LIGHTHOUSE_EXIT_ERROR";

  }


  return record;
}


// =========================================================
// Run individual audit
// =========================================================

async function runAudit(task, index) {

  const outputPath =
    `result-${task.page_id}-${task.device}-${Date.now()}-${index}.json`;


  const processResult =
    await executeLighthouse(
      task,
      outputPath
    );


  const record =
    buildRecord(
      task,
      outputPath,
      processResult
    );


  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }


  return record;
}


// =========================================================
// Worker pool
// Maximum 2 Lighthouse audits simultaneously
// =========================================================

const results =
  new Array(tasks.length);

let cursor = 0;


async function worker() {

  while (true) {

    const currentIndex =
      cursor++;

    if (currentIndex >= tasks.length) {
      break;
    }


    const task =
      tasks[currentIndex];


    const result =
      await runAudit(
        task,
        currentIndex
      );


    results[currentIndex] =
      result;


    // Generic public log.
    // No URL or page name is exposed.
    console.log(
      `Audit ${currentIndex + 1}/${tasks.length}: page ${task.page_id} - ${result.device} - ${result.audit_status}`
    );

  }

}


// =========================================================
// Execute workers
// =========================================================

const workers =
  Array.from(
    {
      length: Math.min(
        MAX_PARALLEL_AUDITS,
        tasks.length
      )
    },
    () => worker()
  );


await Promise.all(workers);


// =========================================================
// Insert results into Supabase
// =========================================================

const validResults =
  results.filter(Boolean);


const { error } =
  await supabase
    .from("web_performance")
    .insert(validResults);


if (error) {

  console.error(
    `Database insert failed (${error.code ?? "unknown"}).`
  );

  process.exit(1);

}


// =========================================================
// Final summary
// =========================================================

const successCount =
  validResults.filter(
    row =>
      row.audit_status === "success"
  ).length;


const failureCount =
  validResults.length - successCount;


console.log(
  `Completed ${validResults.length} audits.`
);

console.log(
  `Successful: ${successCount}. Failed: ${failureCount}.`
);

console.log(
  "Results stored successfully."
);
