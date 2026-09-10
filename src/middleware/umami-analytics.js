const umami = require("@umami/node").default || require("@umami/node");
const logger = require("../../lib/utils/logger");

// Initialize Umami client globally
if (typeof umami.init === "function") {
  umami.init({
    websiteId: "6c853f10-d9ae-4e34-937c-85c4f379b7ff",
    hostUrl: "https://analytics.minoa.cat",
  });
} else if (typeof umami.Umami === "function") {
  // Fallback for different version
  const { Umami } = require("@umami/node");
  global.umamiClient = new Umami({
    websiteId: "6c853f10-d9ae-4e34-937c-85c4f379b7ff",
    hostUrl: "https://analytics.minoa.cat",
  });
}

/**
 * Express middleware to track backend-only requests (API, files) in Umami.
 * Excludes HTML routes which are already tracked by the frontend script.
 */
const umamiAnalytics = async (req, res, next) => {
  // Only track specific backend paths to avoid double-counting with frontend
  const urlPath = req.path;
  const isApi = urlPath.startsWith("/api/");
  const isFileDirect = urlPath.startsWith("/files/");
  const isFileDownload = urlPath.startsWith("/d/");

  if (isApi || isFileDirect || isFileDownload) {
    try {
      let title = urlPath;

      // Attempt to give better titles based on route type
      if (isApi) {
        title = `API: ${urlPath}`;
      } else if (isFileDirect) {
        title = `Direct File Access: ${urlPath}`;
      } else if (isFileDownload) {
        title = `File Download: ${urlPath}`;
      }

      // Track the page view asynchronously without blocking the request
      const trackData = {
        url: req.originalUrl || req.url,
        title: title,
        hostname: req.hostname,
        referrer: req.get("Referer") || "",
        language: req.get("Accept-Language") ? req.get("Accept-Language").split(",")[0] : "",
      };

      if (typeof umami.track === "function") {
umami.track(trackData).catch((err) => {
        logger.debug("[Umami Analytics] Failed to track request:", err.message);
      });
    } else if (global.umamiClient && typeof global.umamiClient.track === "function") {
      global.umamiClient.track(trackData).catch((err) => {
        logger.debug("[Umami Analytics] Failed to track request:", err.message);
      });
    }
  } catch (err) {
    logger.error("[Umami Analytics] Setup error:", err.message);
    }
  }

  // Always continue to the next middleware
  next();
};

module.exports = umamiAnalytics;
