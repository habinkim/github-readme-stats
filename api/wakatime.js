// @ts-check

import { renderWakatimeCard } from "../src/cards/wakatime.js";
import { renderError } from "../src/common/render.js";
import {
  fetchWakatimeStats,
  fetchAllTimeSinceToday,
} from "../src/fetchers/wakatime.js";
import { isLocaleAvailable } from "../src/translations.js";
import {
  CACHE_TTL,
  resolveCacheSeconds,
  setCacheHeaders,
  setErrorCacheHeaders,
} from "../src/common/cache.js";
import { guardAccess } from "../src/common/access.js";
import {
  MissingParamError,
  retrieveSecondaryMessage,
} from "../src/common/error.js";
import { parseArray, parseBoolean } from "../src/common/ops.js";

// @ts-ignore
export default async (req, res) => {
  const {
    username,
    title_color,
    icon_color,
    hide_border,
    card_width,
    line_height,
    text_color,
    bg_color,
    theme,
    cache_seconds,
    hide_title,
    hide_progress,
    custom_title,
    locale,
    layout,
    langs_count,
    hide,
    api_domain,
    range,
    border_radius,
    border_color,
    display_format,
    disable_animations,
  } = req.query;

  res.setHeader("Content-Type", "image/svg+xml");

  const access = guardAccess({
    res,
    id: username,
    type: "wakatime",
    colors: {
      title_color,
      text_color,
      bg_color,
      border_color,
      theme,
    },
  });
  if (!access.isPassed) {
    return access.result;
  }

  if (locale && !isLocaleAvailable(locale)) {
    return res.send(
      renderError({
        message: "Something went wrong",
        secondaryMessage: "Language not found",
        renderOptions: {
          title_color,
          text_color,
          bg_color,
          border_color,
          theme,
        },
      }),
    );
  }

  try {
    // Use WAKATIME_API_KEY from environment for authenticated requests (includes private projects)
    const api_key = process.env.WAKATIME_API_KEY;

    // Debug mode: show API key status and stats metadata
    if (req.query.debug === "true") {
      res.setHeader("Content-Type", "application/json");

      // Fetch both stats and all_time_since_today for comparison
      try {
        const [debugStats, allTimeData] = await Promise.all([
          fetchWakatimeStats({
            username,
            api_domain,
            range,
            api_key,
          }),
          fetchAllTimeSinceToday({ api_domain, api_key }),
        ]);

        return res.send(
          JSON.stringify({
            auth: {
              hasApiKey: !!api_key,
              apiKeyLength: api_key ? api_key.length : 0,
              apiKeyPrefix: api_key ? api_key.substring(0, 8) + "..." : null,
              endpoint: api_key
                ? "current (authenticated)"
                : `${username} (public)`,
            },
            all_time_since_today: allTimeData
              ? {
                  text: allTimeData.text,
                  total_seconds: allTimeData.total_seconds,
                  total_hours: Math.round(allTimeData.total_seconds / 3600),
                  daily_average: allTimeData.daily_average,
                }
              : null,
            stats: {
              username: debugStats.username,
              user_id: debugStats.user_id,
              range: debugStats.range,
              is_including_today: debugStats.is_including_today,
              human_readable_total: debugStats.human_readable_total,
              human_readable_total_including_other_language:
                debugStats.human_readable_total_including_other_language,
              total_seconds: debugStats.total_seconds,
              total_seconds_including_other_language:
                debugStats.total_seconds_including_other_language,
              is_other_usage_visible: debugStats.is_other_usage_visible,
              is_coding_activity_visible: debugStats.is_coding_activity_visible,
              languages_count: debugStats.languages?.length || 0,
              top_languages: debugStats.languages?.slice(0, 5).map((l) => ({
                name: l.name,
                hours: l.hours,
                percent: l.percent,
              })),
            },
          }),
        );
      } catch (debugErr) {
        return res.send(
          JSON.stringify({
            auth: {
              hasApiKey: !!api_key,
              apiKeyLength: api_key ? api_key.length : 0,
              apiKeyPrefix: api_key ? api_key.substring(0, 8) + "..." : null,
              endpoint: api_key
                ? "current (authenticated)"
                : `${username} (public)`,
            },
            error: debugErr.message,
          }),
        );
      }
    }

    const stats = await fetchWakatimeStats({
      username,
      api_domain,
      range,
      api_key,
    });
    const cacheSeconds = resolveCacheSeconds({
      requested: parseInt(cache_seconds, 10),
      def: CACHE_TTL.WAKATIME_CARD.DEFAULT,
      min: CACHE_TTL.WAKATIME_CARD.MIN,
      max: CACHE_TTL.WAKATIME_CARD.MAX,
    });

    setCacheHeaders(res, cacheSeconds);

    return res.send(
      renderWakatimeCard(stats, {
        custom_title,
        hide_title: parseBoolean(hide_title),
        hide_border: parseBoolean(hide_border),
        card_width: parseInt(card_width, 10),
        hide: parseArray(hide),
        line_height,
        title_color,
        icon_color,
        text_color,
        bg_color,
        theme,
        hide_progress,
        border_radius,
        border_color,
        locale: locale ? locale.toLowerCase() : null,
        layout,
        langs_count,
        display_format,
        disable_animations: parseBoolean(disable_animations),
      }),
    );
  } catch (err) {
    setErrorCacheHeaders(res);
    if (err instanceof Error) {
      return res.send(
        renderError({
          message: err.message,
          secondaryMessage: retrieveSecondaryMessage(err),
          renderOptions: {
            title_color,
            text_color,
            bg_color,
            border_color,
            theme,
            show_repo_link: !(err instanceof MissingParamError),
          },
        }),
      );
    }
    return res.send(
      renderError({
        message: "An unknown error occurred",
        renderOptions: {
          title_color,
          text_color,
          bg_color,
          border_color,
          theme,
        },
      }),
    );
  }
};
