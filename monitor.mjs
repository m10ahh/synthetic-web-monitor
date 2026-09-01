import fs from "fs";
import { spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";


// =========================================================
// Configuration
// =========================================================

const SLOW_REQUEST_THRESHOLD_MS = 3000;
const AUDIT_TIMEOUT_MS = 70000;
const MAX_PARALLEL_AUDITS = 2;


// =========================================================
// Measurement cycle timestamp
//
// This is the REAL time when the monitoring cycle begins.
//
// Example:
// Scheduled: 20:15
// GitHub actually starts audits: 20:16:24
// measured_at: 20:16:24
//
// All 14 audits from the same cycle share this timestamp.
// =========================================================

const CYCLE_MEASURED_AT =
  new Date().toISOString();


// =========================================================
// Utility functions
// =========================================================

function roundNumber(value, decimals = 2) {

  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return null;
  }

  const factor =
    10 ** decimals;

  return (
    Math.round(
      Number(value) * factor
    ) / factor
  );
}


// =========================================================
// Validate environment variables
// =========================================================

if (!process.env.SUPABASE_URL) {

  console.error(
    "Missing database URL."
  );

  process.exit(1);
}


if (!process.env.SUPABASE_KEY) {

  console.error(
    "Missing database key."
  );

  process.exit(1);
}


if (!process.env.MONITOR_CONFIG) {

  console.error(
    "Missing monitor configuration."
  );

  process.exit(1);
}


// =========================================================
// Read private page configuration
// =========================================================

let pages;


try {

  pages =
    JSON.parse(
      process.env.MONITOR_CONFIG
    );

} catch {

  console.error(
    "Invalid monitor configuration."
  );

  process.exit(1);
}


if (
  !Array.isArray(pages) ||
  pages.length === 0
) {

  console.error(
    "No pages configured."
  );

  process.exit(1);
}


// =========================================================
// Supabase connection
// =========================================================

const supabase =
  createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
    {
      auth: {
        persistSession: false
      }
    }
  );


// =========================================================
// Device configurations
//
// Lighthouse default configuration = Mobile
// Desktop uses Lighthouse desktop preset
// =========================================================

const devices = [

  {
    name: "mobile",
    extraArgs: []
  },

  {
    name: "desktop",
    extraArgs: [
      "--preset=desktop"
    ]
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

    console.error(
      "Invalid page configuration."
    );

    process.exit(1);
  }


  for (const device of devices) {

    tasks.push({

      page_id:
        page.page_id,

      url:
        page.url,

      device:
        device.name,

      extraArgs:
        device.extraArgs

    });

  }

}


// =========================================================
// Execute Lighthouse
//
// URLs are intentionally not printed in public logs.
// =========================================================

function executeLighthouse(
  task,
  outputPath
) {

  return new Promise(
    (resolve) => {

      const args = [

        "--no-install",

        "lighthouse",

        task.url,

        "--only-categories=performance,best-practices",

        "--output=json",

        `--output-path=${outputPath}`,

        "--max-wait-for-load=45000",

        "--quiet",

        "--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage",

        ...task.extraArgs

      ];


      const child =
        spawn(
          "npx",
          args,
          {
            stdio: [
              "ignore",
              "ignore",
              "ignore"
            ]
          }
        );


      let timedOut = false;


      const timer =
        setTimeout(
          () => {

            timedOut = true;

            child.kill(
              "SIGKILL"
            );

          },
          AUDIT_TIMEOUT_MS
        );


      child.on(
        "error",
        () => {

          clearTimeout(timer);

          resolve({

            exitCode: null,

            timedOut: false,

            processError: true

          });

        }
      );


      child.on(
        "close",
        (code) => {

          clearTimeout(timer);

          resolve({

            exitCode: code,

            timedOut,

            processError: false

          });

        }
      );

    }
  );

}


// =========================================================
// Build database record
// =========================================================

function buildRecord(
  task,
  outputPath,
  processResult
) {

  const record = {

    measured_at:
      CYCLE_MEASURED_AT,

    page_id:
      task.page_id,

    device:
      task.device,

    performance_score:
      null,

    lcp_ms:
      null,

    fcp_ms:
      null,

    cls:
      null,

    tbt_ms:
      null,

    speed_index_ms:
      null,

    total_requests:
      null,

    failed_requests:
      null,

    http_4xx:
      null,

    http_5xx:
      null,

    console_errors:
      null,

    slow_requests:
      null,

    page_size_kb:
      null,

    audit_status:
      "failed",

    error_type:
      null,

    lighthouse_version:
      null

  };


  // =======================================================
  // Process-level failures
  // =======================================================

  if (processResult.timedOut) {

    record.error_type =
      "AUDIT_TIMEOUT";

    return record;
  }


  if (processResult.processError) {

    record.error_type =
      "PROCESS_ERROR";

    return record;
  }


  if (!fs.existsSync(outputPath)) {

    record.error_type =
      "NO_RESULT_FILE";

    return record;
  }


  // =======================================================
  // Read Lighthouse JSON
  // =======================================================

  let result;


  try {

    result =
      JSON.parse(
        fs.readFileSync(
          outputPath,
          "utf8"
        )
      );

  } catch {

    record.error_type =
      "INVALID_RESULT";

    return record;
  }


  const audits =
    result.audits ?? {};


// =========================================================
// Performance Score
// =========================================================

  const performanceScore =
    result.categories
      ?.performance
      ?.score;


  record.performance_score =
    typeof performanceScore === "number"
      ? roundNumber(
          performanceScore * 100,
          0
        )
      : null;


// =========================================================
// Largest Contentful Paint
// =========================================================

  record.lcp_ms =
    roundNumber(
      audits[
        "largest-contentful-paint"
      ]?.numericValue,
      2
    );


// =========================================================
// First Contentful Paint
// =========================================================

  record.fcp_ms =
    roundNumber(
      audits[
        "first-contentful-paint"
      ]?.numericValue,
      2
    );


// =========================================================
// Cumulative Layout Shift
// =========================================================

  record.cls =
    roundNumber(
      audits[
        "cumulative-layout-shift"
      ]?.numericValue,
      4
    );


// =========================================================
// Total Blocking Time
// =========================================================

  record.tbt_ms =
    roundNumber(
      audits[
        "total-blocking-time"
      ]?.numericValue,
      2
    );


// =========================================================
// Speed Index
// =========================================================

  record.speed_index_ms =
    roundNumber(
      audits[
        "speed-index"
      ]?.numericValue,
      2
    );


// =========================================================
// Network requests
// =========================================================

  const networkRequests =
    audits[
      "network-requests"
    ]?.details?.items ?? [];


  record.total_requests =
    networkRequests.length;


// =========================================================
// HTTP 4xx
// =========================================================

  record.http_4xx =
    networkRequests.filter(
      (request) => {

        const status =
          Number(
            request.statusCode
          );

        return (
          status >= 400 &&
          status < 500
        );

      }
    ).length;


// =========================================================
// HTTP 5xx
// =========================================================

  record.http_5xx =
    networkRequests.filter(
      (request) => {

        const status =
          Number(
            request.statusCode
          );

        return (
          status >= 500 &&
          status < 600
        );

      }
    ).length;


// =========================================================
// Failed requests
//
// Includes:
// - unfinished requests
// - HTTP >= 400
// - negative status codes / no valid HTTP response
// =========================================================

  record.failed_requests =
    networkRequests.filter(
      (request) => {

        const status =
          Number(
            request.statusCode
          );


        return (

          request.finished === false ||

          (
            Number.isFinite(status) &&
            status >= 400
          ) ||

          (
            Number.isFinite(status) &&
            status < 0
          )

        );

      }
    ).length;


// =========================================================
// Slow requests
//
// Lighthouse network-requests exposes:
// networkRequestTime = request start in ms
// networkEndTime     = request end in ms
//
// Slow = request duration >= 3 seconds.
// =========================================================

  record.slow_requests =
    networkRequests.filter(
      (request) => {

        const start =
          Number(
            request.networkRequestTime
          );


        const end =
          Number(
            request.networkEndTime
          );


        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end)
        ) {

          return false;
        }


        const durationMs =
          end - start;


        return (
          durationMs >=
          SLOW_REQUEST_THRESHOLD_MS
        );

      }
    ).length;


// =========================================================
// Total transferred page size
// =========================================================

  const totalTransferBytes =
    networkRequests.reduce(
      (
        total,
        request
      ) => {

        return (
          total +
          (
            Number(
              request.transferSize
            ) || 0
          )
        );

      },
      0
    );


  record.page_size_kb =
    roundNumber(
      totalTransferBytes / 1024,
      2
    );


// =========================================================
// Browser console errors
// =========================================================

  const consoleErrorItems =
    audits[
      "errors-in-console"
    ]?.details?.items;


  record.console_errors =
    Array.isArray(
      consoleErrorItems
    )
      ? consoleErrorItems.length
      : 0;


// =========================================================
// Lighthouse version
// =========================================================

  record.lighthouse_version =
    result.lighthouseVersion ??
    null;


// =========================================================
// Final audit status
// =========================================================

  if (
    result.runtimeError?.code
  ) {

    record.audit_status =
      "failed";


    record.error_type =
      String(
        result.runtimeError.code
      );

  }

  else if (
    processResult.exitCode === 0
  ) {

    record.audit_status =
      "success";


    record.error_type =
      null;

  }

  else {

    record.audit_status =
      "failed";


    record.error_type =
      "LIGHTHOUSE_EXIT_ERROR";

  }


  return record;

}


// =========================================================
// Run individual audit
// =========================================================

async function runAudit(
  task,
  index
) {

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

    fs.unlinkSync(
      outputPath
    );

  }


  return record;

}


// =========================================================
// Worker pool
//
// Maximum 2 Lighthouse audits simultaneously.
// =========================================================

const results =
  new Array(
    tasks.length
  );


let cursor = 0;


async function worker() {

  while (true) {

    const currentIndex =
      cursor++;


    if (
      currentIndex >=
      tasks.length
    ) {

      break;
    }


    const task =
      tasks[
        currentIndex
      ];


    const result =
      await runAudit(
        task,
        currentIndex
      );


    results[
      currentIndex
    ] =
      result;


    // Public log contains no URL.
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
      length:
        Math.min(
          MAX_PARALLEL_AUDITS,
          tasks.length
        )
    },

    () => worker()

  );


await Promise.all(
  workers
);


// =========================================================
// Insert complete monitoring cycle into Supabase
// =========================================================

const validResults =
  results.filter(
    Boolean
  );


const { error } =
  await supabase
    .from(
      "web_performance"
    )
    .insert(
      validResults
    );


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
    (row) =>
      row.audit_status ===
      "success"
  ).length;


const failureCount =
  validResults.length -
  successCount;


console.log(
  `Completed ${validResults.length} audits.`
);


console.log(
  `Successful: ${successCount}. Failed: ${failureCount}.`
);


console.log(
  `Measurement cycle started at: ${CYCLE_MEASURED_AT}`
);


console.log(
  "Results stored successfully."
);
