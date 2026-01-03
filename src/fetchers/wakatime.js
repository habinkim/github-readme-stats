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

    return data.data;
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

export { fetchWakatimeStats };
export default fetchWakatimeStats;
