// @ts-check

import axios from "axios";
import { CustomError, MissingParamError } from "../common/error.js";

/**
 * Valid WakaTime range options.
 * @type {string[]}
 */
const VALID_RANGES = [
  "last_7_days",
  "last_30_days",
  "last_6_months",
  "last_year",
  "all_time",
];

/**
 * Formats seconds into a human-readable string.
 *
 * @param {number} totalSeconds Total seconds to format.
 * @returns {string} Formatted time string.
 */
const formatTime = (totalSeconds) => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours.toLocaleString()} hrs ${minutes} mins`;
};

/**
 * Gets the actual total hours from environment variable for correction calculation.
 * WakaTime API often returns ~55% of actual coding time due to aggregation issues.
 *
 * @returns {number | null} Actual total hours from PDF report, or null if not set.
 */
const getActualTotalHours = () => {
  // Support both env var names for backwards compatibility
  const actualHours =
    process.env.WAKATIME_ACTUAL_HOURS || process.env.WAKATIME_TOTAL_HOURS;
  if (actualHours) {
    const hours = parseFloat(actualHours);
    if (!isNaN(hours) && hours > 0) {
      return hours;
    }
  }
  return null;
};

/**
 * Applies correction factor to all stats data (total and per-language).
 * This fixes the WakaTime API issue where it returns only ~55% of actual time.
 *
 * @param {object} stats The stats object from WakaTime API.
 * @param {number} actualHours The actual total hours from PDF report.
 * @returns {object} Corrected stats with all values proportionally adjusted.
 */
const applyCorrection = (stats, actualHours) => {
  const apiTotalSeconds =
    stats.total_seconds_including_other_language || stats.total_seconds || 0;
  if (apiTotalSeconds <= 0) {
    return stats;
  }

  const actualTotalSeconds = actualHours * 3600;
  const correctionFactor = actualTotalSeconds / apiTotalSeconds;

  // Correct total values
  stats.total_seconds = Math.round(stats.total_seconds * correctionFactor);
  stats.total_seconds_including_other_language = Math.round(
    (stats.total_seconds_including_other_language || stats.total_seconds) *
      correctionFactor,
  );
  stats.human_readable_total = formatTime(stats.total_seconds);
  stats.human_readable_total_including_other_language = formatTime(
    stats.total_seconds_including_other_language,
  );

  // Correct each language's time
  if (stats.languages && Array.isArray(stats.languages)) {
    stats.languages = stats.languages.map((lang) => {
      const correctedSeconds = Math.round(
        (lang.total_seconds || 0) * correctionFactor,
      );
      const correctedHours = Math.floor(correctedSeconds / 3600);
      const correctedMinutes = Math.floor((correctedSeconds % 3600) / 60);
      return {
        ...lang,
        total_seconds: correctedSeconds,
        hours: correctedHours,
        minutes: correctedMinutes,
        text: `${correctedHours.toLocaleString()} hrs ${correctedMinutes} mins`,
        // percent stays the same (relative proportions unchanged)
      };
    });
  }

  // Mark as corrected for debugging
  stats.is_corrected = true;
  stats.correction_factor = correctionFactor;
  stats.actual_hours_source = "WAKATIME_ACTUAL_HOURS";

  return stats;
};

/**
 * Gets the override total hours from environment variable if set.
 * @deprecated Use getActualTotalHours() and applyCorrection() instead.
 * @returns {{total_seconds: number, text: string, is_override: boolean} | null} Override data or null.
 */
const getOverrideTotal = () => {
  const hours = getActualTotalHours();
  if (hours) {
    const totalSeconds = hours * 3600;
    return {
      total_seconds: totalSeconds,
      text: formatTime(totalSeconds),
      is_override: true,
    };
  }
  return null;
};

/**
 * Fetches the total coding time since account creation.
 * This endpoint provides accurate all-time stats unlike /stats/all_time which may be cached.
 *
 * @param {{api_domain: string, api_key: string}} props Fetcher props.
 * @returns {Promise<{total_seconds: number, text: string, daily_average: number}>} All time data.
 */
const fetchAllTimeSinceToday = async ({ api_domain, api_key }) => {
  if (!api_key) {
    return { error: "no_api_key" };
  }

  const baseUrl = api_domain ? api_domain.replace(/\/$/gi, "") : "wakatime.com";
  const encodedKey = Buffer.from(`${api_key}:`).toString("base64");

  try {
    const { data } = await axios.get(
      `https://${baseUrl}/api/v1/users/current/all_time_since_today`,
      {
        headers: {
          Authorization: `Basic ${encodedKey}`,
        },
      },
    );
    return data.data;
  } catch (err) {
    // Return error info for debugging
    return {
      error: err.message,
      status: err.response?.status,
      statusText: err.response?.statusText,
    };
  }
};

/**
 * Fetches summaries for a single date range chunk (max 365 days).
 *
 * @param {{api_domain: string, api_key: string, start: string, end: string, encodedKey: string}} props Fetcher props.
 * @returns {Promise<object>} Raw summaries data for the chunk.
 */
const fetchSummariesChunk = async ({
  api_domain,
  api_key,
  start,
  end,
  encodedKey,
}) => {
  const baseUrl = api_domain ? api_domain.replace(/\/$/gi, "") : "wakatime.com";
  const authKey = encodedKey || Buffer.from(`${api_key}:`).toString("base64");

  const { data } = await axios.get(
    `https://${baseUrl}/api/v1/users/current/summaries?start=${start}&end=${end}`,
    {
      headers: {
        Authorization: `Basic ${authKey}`,
      },
      timeout: 15000, // 15 second timeout per chunk
    },
  );
  return data.data || [];
};

/**
 * Fetches summaries for a date range and aggregates the total.
 * Automatically chunks requests into 365-day segments to avoid API limits.
 *
 * @param {{api_domain: string, api_key: string, start: string, end: string}} props Fetcher props.
 * @returns {Promise<object>} Aggregated summaries data.
 */
const fetchSummariesRange = async ({ api_domain, api_key, start, end }) => {
  if (!api_key) {
    return { error: "no_api_key" };
  }

  const encodedKey = Buffer.from(`${api_key}:`).toString("base64");

  try {
    // Generate date chunks (max 365 days each)
    const chunks = [];
    const startDate = new Date(start);
    const endDate = new Date(end);
    let currentStart = new Date(startDate);

    while (currentStart < endDate) {
      const currentEnd = new Date(currentStart);
      currentEnd.setDate(currentEnd.getDate() + 364); // 365 days max

      if (currentEnd > endDate) {
        currentEnd.setTime(endDate.getTime());
      }

      chunks.push({
        start: currentStart.toISOString().split("T")[0],
        end: currentEnd.toISOString().split("T")[0],
      });

      currentStart = new Date(currentEnd);
      currentStart.setDate(currentStart.getDate() + 1);
    }

    // Fetch chunks sequentially to avoid rate limiting
    const chunkResults = [];
    for (const chunk of chunks) {
      const result = await fetchSummariesChunk({
        api_domain,
        api_key,
        start: chunk.start,
        end: chunk.end,
        encodedKey,
      });
      chunkResults.push(result);
    }

    // Aggregate all summaries
    let totalSeconds = 0;
    let totalDays = 0;
    const languageMap = new Map();

    for (const summaries of chunkResults) {
      totalDays += summaries.length;
      for (const day of summaries) {
        totalSeconds += day.grand_total?.total_seconds || 0;

        // Aggregate languages
        for (const lang of day.languages || []) {
          const existing = languageMap.get(lang.name) || 0;
          languageMap.set(lang.name, existing + (lang.total_seconds || 0));
        }
      }
    }

    // Convert language map to sorted array
    const languages = Array.from(languageMap.entries())
      .map(([name, total_seconds]) => ({
        name,
        total_seconds,
        hours: Math.floor(total_seconds / 3600),
        minutes: Math.floor((total_seconds % 3600) / 60),
        percent: totalSeconds > 0 ? (total_seconds / totalSeconds) * 100 : 0,
      }))
      .sort((a, b) => b.total_seconds - a.total_seconds);

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    return {
      total_seconds: totalSeconds,
      text: `${hours.toLocaleString()} hrs ${minutes} mins`,
      languages,
      days_count: totalDays,
      chunks_fetched: chunks.length,
      start,
      end,
    };
  } catch (err) {
    return {
      error: err.message,
      status: err.response?.status,
      statusText: err.response?.statusText,
    };
  }
};

/**
 * WakaTime data fetcher.
 *
 * @param {{username: string, api_domain: string, range: string, api_key: string }} props Fetcher props.
 * @returns {Promise<import("./types").WakaTimeData>} WakaTime data response.
 */
const fetchWakatimeStats = async ({ username, api_domain, range, api_key }) => {
  if (!username && !api_key) {
    throw new MissingParamError(["username"]);
  }

  // Validate and default the range parameter
  const validRange = VALID_RANGES.includes(range) ? range : "last_7_days";

  const baseUrl = api_domain ? api_domain.replace(/\/$/gi, "") : "wakatime.com";

  // If API key is provided, use authenticated endpoint for full data (including private projects)
  // Otherwise, use public endpoint (excludes private projects and "Other" language)
  const userPath = api_key ? "current" : username;

  // Build request config with optional authentication
  const config = {};
  if (api_key) {
    // WakaTime API uses HTTP Basic Auth with API key as username and empty password
    // Format: Base64(api_key:) - trailing colon is required!
    const encodedKey = Buffer.from(`${api_key}:`).toString("base64");
    config.headers = {
      Authorization: `Basic ${encodedKey}`,
    };
  }

  try {
    const { data } = await axios.get(
      `https://${baseUrl}/api/v1/users/${userPath}/stats/${validRange}?is_including_today=true`,
      config,
    );

    let stats = data.data;

    // Apply correction factor for all_time range if WAKATIME_ACTUAL_HOURS env var is set
    // This corrects BOTH total AND per-language times proportionally
    if (validRange === "all_time") {
      const actualHours = getActualTotalHours();
      if (actualHours) {
        stats = applyCorrection(stats, actualHours);
      }
    }

    return stats;
  } catch (err) {
    if (err.response.status < 200 || err.response.status > 299) {
      throw new CustomError(
        `Could not resolve to a User with the login of '${username || "current"}'`,
        "WAKATIME_USER_NOT_FOUND",
      );
    }
    throw err;
  }
};

export {
  fetchWakatimeStats,
  fetchAllTimeSinceToday,
  fetchSummariesRange,
  getOverrideTotal,
  getActualTotalHours,
  applyCorrection,
};
export default fetchWakatimeStats;
