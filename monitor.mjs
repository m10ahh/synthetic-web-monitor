import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

// ============================================================
// Configuration
// ============================================================

const SLOW_REQUEST_THRESHOLD_MS = 3000;
const AUDIT_TIMEOUT_MS = 70000;
const MAX_PARALLEL_AUDITS = 2;

const CYCLE_MEASURED_AT = new Date().toISOString();

const {
  SUPABASE_URL,
  SUPABASE_KEY,
  MONITOR_CONFIG
} = process.env;

if (!SUPABASE_URL || !SUPABASE_KEY || !MONITOR_CONFIG) {
  throw new Error("Missing required environment variables.");
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

// ============================================================
// Monitor configuration
// ============================================================

let parsedConfig;

try {
  parsedConfig = JSON.parse(MONITOR_CONFIG);
} catch {
  throw new Error("MONITOR_CONFIG is not valid JSON.");
}

const pages = Array.isArray(parsedConfig)
  ? parsedConfig
  : parsedConfig.pages;

if (!Array.isArray(pages) || pages.length === 0) {
  throw new Error("MONITOR_CONFIG does not contain pages.");
}

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

// ============================================================
// Helpers
// ============================================================

function round(value, decimals = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function getPath(url) {
  try {
    const parsedUrl = new URL(url);

    return `${parsedUrl.pathname}${parsedUrl.search}`;
  } catch {
    return null;
  }
}

function getRequestDurationMs(request) {
  if (
    typeof request.startTime === "number" &&
    typeof request.endTime === "number"
  ) {
    return request.endTime - request.startTime;
  }

  return null;
}

function getErrorType(error) {
  const text = String(
    error?.message ||
    error?.stderr ||
    error ||
    ""
  ).toLowerCase();

  if (
    text.includes("timed out") ||
    text.includes("timeout") ||
    error?.killed === true
  ) {
    return "AUDIT_TIMEOUT";
  }

  return "AUDIT_ERROR";
}

// ============================================================
// Lighthouse audit
// ============================================================

async function runAudit(task) {
  const fileName =
    `lighthouse-${task.page_id}-${task.device}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.json`;

  const outputPath = path.join(os.tmpdir(), fileName);

  try {
    const lighthouseArgs = [
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

    await execFileAsync(
      "npx",
      lighthouseArgs,
      {
        timeout: AUDIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
      }
    );

    const rawReport = await fs.readFile(outputPath, "utf8");
    const lhr = JSON.parse(rawReport);

    // --------------------------------------------------------
    // URL / redirect validation
    // --------------------------------------------------------

    const requestedUrl = lhr.requestedUrl || task.url;
    const finalUrl = lhr.finalUrl || requestedUrl;

    const requestedHost = getHost(requestedUrl);
    const finalHost = getHost(finalUrl);

    // NEW: final route reached by Lighthouse
    const finalPath = getPath(finalUrl);

    const wasRedirected =
      requestedHost &&
      finalHost
        ? requestedHost !== finalHost
        : null;

    // --------------------------------------------------------
    // Main metrics
    // --------------------------------------------------------

    const performanceScore =
      typeof lhr.categories?.performance?.score === "number"
        ? Math.round(lhr.categories.performance.score * 100)
        : null;

    const metrics =
      lhr.audits?.["metrics"]?.details?.items?.[0] || {};

    const pageLoadTimeMs =
      typeof metrics.observedLoad === "number"
        ? round(metrics.observedLoad, 2)
        : null;

    const lcpMs = round(
      lhr.audits?.["largest-contentful-paint"]?.numericValue,
      2
    );

    const fcpMs = round(
      lhr.audits?.["first-contentful-paint"]?.numericValue,
      2
    );

    const cls = round(
      lhr.audits?.["cumulative-layout-shift"]?.numericValue,
      4
    );

    const tbtMs = round(
      lhr.audits?.["total-blocking-time"]?.numericValue,
      2
    );

    const speedIndexMs = round(
      lhr.audits?.["speed-index"]?.numericValue,
      2
    );

    // --------------------------------------------------------
    // Network requests
    // --------------------------------------------------------

    const networkRequests =
      lhr.audits?.["network-requests"]?.details?.items || [];

    const totalRequests = networkRequests.length;

    const http4xx = networkRequests.filter(
      (request) =>
        Number(request.statusCode) >= 400 &&
        Number(request.statusCode) < 500
    ).length;

    const http5xx = networkRequests.filter(
      (request) =>
        Number(request.statusCode) >= 500 &&
        Number(request.statusCode) < 600
    ).length;

    const failedRequests = networkRequests.filter((request) => {
      const statusCode = Number(request.statusCode);

      return (
        request.finished === false ||
        statusCode >= 400
      );
    }).length;

    const slowRequests = networkRequests.filter((request) => {
      const durationMs = getRequestDurationMs(request);

      return (
        durationMs !== null &&
        durationMs >= SLOW_REQUEST_THRESHOLD_MS
      );
    }).length;

    const totalTransferSize = networkRequests.reduce(
      (sum, request) => {
        const size = Number(request.transferSize);
        return sum + (Number.isFinite(size) ? size : 0);
      },
      0
    );

    const pageSizeKb = round(totalTransferSize / 1024, 2);

    // --------------------------------------------------------
    // Console errors
    // --------------------------------------------------------

    const consoleErrorItems =
      lhr.audits?.["errors-in-console"]?.details?.items || [];

    const consoleErrors = consoleErrorItems.length;

    // --------------------------------------------------------
    // Result
    // --------------------------------------------------------

    return {
      measured_at: CYCLE_MEASURED_AT,
      page_id: task.page_id,
      device: task.device,

      page_load_time_ms: pageLoadTimeMs,
      performance_score: performanceScore,

      lcp_ms: lcpMs,
      fcp_ms: fcpMs,
      cls,
      tbt_ms: tbtMs,
      speed_index_ms: speedIndexMs,

      total_requests: totalRequests,
      failed_requests: failedRequests,
      http_4xx: http4xx,
      http_5xx: http5xx,
      console_errors: consoleErrors,
      slow_requests: slowRequests,
      page_size_kb: pageSizeKb,

      lighthouse_version: lhr.lighthouseVersion || null,

      // URL validation
      requested_host: requestedHost,
      final_host: finalHost,
      final_path: finalPath,
      was_redirected: wasRedirected,

      audit_status: "success",
      error_type: null
    };
  } catch (error) {
    return {
      measured_at: CYCLE_MEASURED_AT,
      page_id: task.page_id,
      device: task.device,

      page_load_time_ms: null,
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

      lighthouse_version: null,

      requested_host: getHost(task.url),
      final_host: null,
      final_path: null,
      was_redirected: null,

      audit_status: "failed",
      error_type: getErrorType(error)
    };
  } finally {
    try {
      await fs.unlink(outputPath);
    } catch {
      // Ignore cleanup errors.
    }
  }
}

// ============================================================
// Parallel execution
// ============================================================

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex++;

      if (currentIndex >= tasks.length) {
        break;
      }

      const task = tasks[currentIndex];
      const result = await runAudit(task);

      results[currentIndex] = result;

      console.log(
        `page ${task.page_id} - ${task.device} - ${result.audit_status}`
      );
    }
  }

  const workers = Array.from(
    {
      length: Math.min(limit, tasks.length)
    },
    () => worker()
  );

  await Promise.all(workers);

  return results;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const tasks = [];

  for (const page of pages) {
    if (!page.page_id || !page.url) {
      continue;
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

  if (tasks.length === 0) {
    throw new Error("No valid monitoring tasks were found.");
  }

  console.log(`Starting ${tasks.length} audits.`);

  const results = await runWithConcurrency(
    tasks,
    MAX_PARALLEL_AUDITS
  );

  const { error } = await supabase
    .from("web_performance")
    .insert(results);

  if (error) {
    throw error;
  }

  const successful = results.filter(
    (result) => result.audit_status === "success"
  ).length;

  const failed = results.length - successful;

  console.log(
    `Completed: ${successful} success, ${failed} failed.`
  );
}

main().catch((error) => {
  console.error("Monitoring cycle failed.");
  process.exit(1);
});
