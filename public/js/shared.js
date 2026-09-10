/* Shared JavaScript for litter.minoa.cat */
/* Theme, modals, drag-drop, and utilities */

// LitterLogger — structured, categorized, filterable console logging
class LitterLogger {
  constructor() {
    this._debugEnabled = this._readDebugFlag();
    this._levels = { debug: 0, info: 1, warn: 2, error: 3 };
    this._methods = { debug: console.debug, info: console.info, warn: console.warn, error: console.error };
  }

  _readDebugFlag() {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("debug") === "true") return true;
      if (localStorage.getItem("litter_debug") === "true") return true;
    } catch (_) { /* localStorage unavailable */ }
    return false;
  }

  _emit(level, category, ...args) {
    if (level === "debug" && !this._debugEnabled) return;
    const prefix = `[Litter:${category}]`;
    const method = this._methods[level] || console.log;
    method(prefix, ...args);
  }

  debug(category, ...args) { this._emit("debug", category, ...args); }
  info(category, ...args) { this._emit("info", category, ...args); }
  warn(category, ...args) { this._emit("warn", category, ...args); }
  error(category, ...args) { this._emit("error", category, ...args); }

  get debugEnabled() { return this._debugEnabled; }
  set debugEnabled(v) { this._debugEnabled = !!v; }
}

// Analytics tracking — Umami only
function trackEvent(eventName, properties = {}) {
	if (typeof umami !== "undefined") {
		umami.track(eventName, properties);
	}
}

// Random Theme Selection - Uniform HSL distribution
function generateRandomVisibleColor() {
  // True uniform random across HSL spectrum
  const hue = Math.floor(Math.random() * 360); // 0-360
  const saturation = 30 + Math.floor(Math.random() * 66); // 30-95%
  const lightness = 35 + Math.floor(Math.random() * 46); // 35-80%

  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function applyRandomTheme() {
  const color = generateRandomVisibleColor();
  const root = document.documentElement;

  const tempDiv = document.createElement("div");
  tempDiv.style.color = color;
  document.body.appendChild(tempDiv);
  const rgbColor = window.getComputedStyle(tempDiv).color;
  document.body.removeChild(tempDiv);

  const rgbMatch = rgbColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch;

    root.style.setProperty("--background", "#0a0a0a");
    root.style.setProperty("--text", `rgba(${r}, ${g}, ${b}, 0.92)`);
    root.style.setProperty("--text-muted", `rgba(${r}, ${g}, ${b}, 0.55)`);
    root.style.setProperty("--text-bright", `rgba(${r}, ${g}, ${b}, 0.98)`);
    root.style.setProperty("--card-bg", `rgba(${r}, ${g}, ${b}, 0.06)`);
    root.style.setProperty("--card-hover", `rgba(${r}, ${g}, ${b}, 0.1)`);
    root.style.setProperty("--border", `rgba(${r}, ${g}, ${b}, 0.15)`);
    root.style.setProperty("--hover-border", `rgba(${r}, ${g}, ${b}, 0.35)`);
    root.style.setProperty("--button-bg", `rgba(${r}, ${g}, ${b}, 0.12)`);
    root.style.setProperty("--button-hover", `rgba(${r}, ${g}, ${b}, 0.2)`);
    root.style.setProperty("--button-disabled", `rgba(${r}, ${g}, ${b}, 0.04)`);
    root.style.setProperty("--highlight-bg", `rgba(${r}, ${g}, ${b}, 0.2)`);
    root.style.setProperty("--highlight-text", `rgba(${r}, ${g}, ${b}, 0.98)`);
    root.style.setProperty("--link-color", color);
    root.style.setProperty("--link-hover", `rgba(${r}, ${g}, ${b}, 0.85)`);
    root.style.setProperty("--link-bright", color);
    root.style.setProperty("--primary-color", color);
    root.style.setProperty("--notification-success-bg", "rgba(80, 250, 123, 0.85)");
    root.style.setProperty("--notification-error-bg", "rgba(255, 85, 85, 0.85)");
    root.style.setProperty("--notification-info-bg", `rgba(${r}, ${g}, ${b}, 0.7)`);
    root.style.setProperty("--progress-bg", `rgba(${r}, ${g}, ${b}, 0.15)`);
    root.style.setProperty("--progress-fill", color);
    root.style.setProperty("--input-bg", `rgba(${r}, ${g}, ${b}, 0.08)`);
    root.style.setProperty("--input-border", `rgba(${r}, ${g}, ${b}, 0.25)`);
    root.style.setProperty("--input-focus", `rgba(${r}, ${g}, ${b}, 0.45)`);
  }
}

function initializeTheme() {
  const saved = localStorage.getItem("themeMode");
  const mode = saved || "random";

	if (mode === "random") {
		applyRandomTheme();
		document.documentElement.setAttribute("data-theme", "random");
	} else {
		document.documentElement.removeAttribute("data-theme");
	}

  localStorage.setItem("themeMode", mode);
}

// Format file size
function formatFileSize(bytes) {
  if (bytes === 0 || isNaN(bytes)) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function showNotification(message, type = "info", duration = 5000) {
  const notification = document.createElement("div");
  notification.className = `notification ${type}`;
  notification.textContent = message;

  document.body.appendChild(notification);

  // Show notification
  setTimeout(() => {
    notification.classList.add("show");
  }, 100);

  // Hide notification
  setTimeout(() => {
    notification.classList.remove("show");
    setTimeout(() => {
      document.body.removeChild(notification);
    }, 300);
	}, duration);
}

function showStatus(message, isError = false) {
  const type = isError ? "error" : "info";
  const statusElement = document.getElementById("status");
  if (statusElement) {
    statusElement.textContent = message;
    statusElement.className = `status-message status-${type}`;
    statusElement.style.display = "block";
  }
}

function showProgress(elementId, percentage) {
  const element = document.getElementById(elementId);
  if (element) {
    const progressBar = element.querySelector(".progress-bar") || element;
    progressBar.style.width = percentage + "%";
    progressBar.style.display = "block";
  }
}

// Modal Functions
function openModal(modalId) {
	const modal = document.getElementById(modalId);
	if (modal) {
		modal.classList.add("show");
		document.body.style.overflow = "hidden";
	}
}

function closeModal(modalId) {
	const modal = document.getElementById(modalId);
	if (modal) {
		modal.classList.remove("show");
		document.body.style.overflow = "auto";
	}
}

function initializeModals() {
  // Close modal when clicking outside
  document.addEventListener("click", (e) => {
    if (e.target.classList.contains("modal")) {
      e.target.classList.remove("show");
      document.body.style.overflow = "auto";
    }
  });

  // Close modal with close button
  document.addEventListener("click", (e) => {
    if (e.target.classList.contains("close-modal")) {
      const modal = e.target.closest(".modal");
      if (modal) {
        modal.classList.remove("show");
        document.body.style.overflow = "auto";
      }
    }
  });

  // Close modal with Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const openModal = document.querySelector(".modal.show");
      if (openModal) {
        openModal.classList.remove("show");
        document.body.style.overflow = "auto";
      }
    }
  });
}

// Form Validation
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function validateForm(formElement) {
  const requiredFields = formElement.querySelectorAll("[required]");
  let isValid = true;

  requiredFields.forEach((field) => {
    if (!field.value.trim()) {
      field.classList.add("error");
      isValid = false;
    } else {
      field.classList.remove("error");
    }

    // Email validation
    if (field.type === "email" && field.value && !validateEmail(field.value)) {
      field.classList.add("error");
      isValid = false;
    }
  });

  return isValid;
}

// Drag and Drop Functionality
function initializeDragAndDrop(dropZone, fileInput, onFilesSelected) {
  if (!dropZone || !fileInput) return;

  // Prevent default drag behaviors
  ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, preventDefaults, false);
    document.body.addEventListener(eventName, preventDefaults, false);
  });

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // Highlight drop zone when item is dragged over it
  ["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(eventName, highlight, false);
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, unhighlight, false);
  });

  function highlight() {
    dropZone.classList.add("drag-over");
  }

  function unhighlight() {
    dropZone.classList.remove("drag-over");
  }

  // Handle dropped files
  dropZone.addEventListener("drop", handleDrop, false);

  function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;

	if (onFilesSelected) {
		onFilesSelected(files);
	}
	}

  // Handle file input change
	fileInput.addEventListener("change", (e) => {
		if (onFilesSelected) {
			onFilesSelected(e.target.files);
		}
	});

  // Click to select files
  dropZone.addEventListener("click", () => {
    fileInput.click();
  });
}

// Rate Limiting
class RateLimiter {
  constructor(maxRequests = 10, timeWindow = 60000) {
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindow;
    this.requests = [];
  }

  canMakeRequest() {
    const now = Date.now();
    this.requests = this.requests.filter((time) => now - time < this.timeWindow);
    return this.requests.length < this.maxRequests;
  }

  makeRequest() {
    if (this.canMakeRequest()) {
      this.requests.push(Date.now());
      return true;
    }
    return false;
  }

  getTimeUntilNextRequest() {
    if (this.requests.length === 0) return 0;
    const oldestRequest = Math.min(...this.requests);
    const timeUntilExpiry = this.timeWindow - (Date.now() - oldestRequest);
    return Math.max(0, timeUntilExpiry);
  }
}

// Initialize everything when DOM is loaded
document.addEventListener("DOMContentLoaded", function () {
  // Initialize theme
  initializeTheme();

  // Initialize modals
  initializeModals();

	// Fade in body
	document.body.style.opacity = "1";
});

// Export functions for use in other scripts
window.litter = {
  logger: new LitterLogger(),
  formatFileSize,
  showNotification,
  showStatus,
  showProgress,
  openModal,
  closeModal,
  validateForm,
  validateEmail,
  initializeDragAndDrop,
  trackEvent,
  RateLimiter,
  generateRandomVisibleColor,
  applyRandomTheme,
};

// Handle URL fragments for direct modal access
if (window.location.hash) {
  const modalId = window.location.hash.substring(1);
  const modal = document.getElementById(modalId);
  if (modal && modal.classList.contains("modal")) {
    setTimeout(() => openModal(modalId), 500);
  }
}

// Update URL when modal opens/closes
document.addEventListener("click", (e) => {
  if (e.target.hasAttribute("data-modal")) {
    const modalId = e.target.getAttribute("data-modal");
    window.location.hash = modalId;
    openModal(modalId);
  }
});

// Clear hash when modal closes
const originalCloseModal = closeModal;
closeModal = function (modalId) {
  originalCloseModal(modalId);
  if (window.location.hash === "#" + modalId) {
    history.replaceState(null, null, window.location.pathname);
  }
};

// Error tracking — log to console only
window.addEventListener("error", (e) => {
	window.litter?.logger?.error("general", "Uncaught JS error", { message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno });
});

// Unhandled promise rejection tracking
window.addEventListener("unhandledrejection", (e) => {
	window.litter?.logger?.error("general", "Unhandled promise rejection", e.reason?.toString() || "Unknown");
});
