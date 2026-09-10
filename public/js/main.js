document.addEventListener("DOMContentLoaded", () => {
  SettingsManager.init();
  E2EEManager.initWorker();
  setupModals();
  setupHistoryDrawer();
  updateTotalSize();
  initNotificationSystem();
  handleUrlFragments();
  checkFirstVisit();
  initMigrationBanner();
  UploadHistoryManager.updateBadge();

  // Auto-open file picker if enabled
  if (SettingsManager.settings.autoOpenFilePicker) {
    openFilePickerWithBlur();
  }
});

// Keyboard Shortcuts
document.addEventListener("keydown", (e) => {
  // Only trigger if we're not typing in an input
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") {
    return;
  }
  
  // Ctrl+O: Open file picker
  if ((e.ctrlKey || e.metaKey) && e.key === "o") {
    e.preventDefault();
    const fileInput = document.getElementById("fileInput");
    if (fileInput) fileInput.click();
  }
  
  // Ctrl+L: Copy last upload link
  if ((e.ctrlKey || e.metaKey) && e.key === "l") {
    e.preventDefault();
    const lastLink = document.querySelector(".link-input:last-of-type");
    if (lastLink) {
      lastLink.click(); // Triggers the copy event listener
    } else {
      showStatus("No recent uploads to copy");
    }
  }
  
  // Ctrl+H: Toggle history drawer
  if ((e.ctrlKey || e.metaKey) && e.key === "h") {
    e.preventDefault();
    const drawer = document.getElementById("historyDrawer");
    if (drawer) {
      if (drawer.classList.contains("active")) {
        UploadHistoryManager.closeDrawer();
      } else {
        UploadHistoryManager.openDrawer();
      }
    }
  }
});

function initMigrationBanner() {
  const banner = document.getElementById('migration-banner');
  if (banner) {
    if (localStorage.getItem('litter_banner_dismissed')) {
      banner.style.display = 'none';
    }
    const dismissBtn = banner.querySelector('.banner-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        banner.classList.add('dismissed');
        setTimeout(() => banner.style.display = 'none', 300);
        localStorage.setItem('litter_banner_dismissed', '1');
      });
    }
  }
}

function checkFirstVisit() {
  const dragBox = document.getElementById("dragDropBox");
  if (!dragBox) return; // Exit if not on the main upload page

  if (!localStorage.getItem("hasVisited")) {
    // Add the glowing class that loops
    setTimeout(() => {
      dragBox.classList.add("first-visit-glow");
    }, 800);
  }
}

function initPasteConfirmModal() {
  if (pasteConfirmModal) return;

  pasteConfirmModal = document.createElement("div");
  pasteConfirmModal.className = "modal";
  pasteConfirmModal.id = "pasteConfirmModal";

  pasteConfirmModal.innerHTML = `
    <div class="modal-content paste-modal-content">
      <h2 style="margin-bottom: 1rem; color: var(--text-bright);">Confirm Paste</h2>
      <p style="margin-bottom: 1rem; color: var(--text-muted);">You are about to upload the following content:</p>

      <div id="pastePreviewContainer" class="paste-preview-container"></div>

      <div style="display: flex; gap: 1rem; justify-content: center;">
        <button class="button" id="cancelPasteBtn" style="background: var(--card-bg);">Cancel</button>
        <button class="button button-primary" id="confirmPasteBtn">Upload Content</button>
      </div>
    </div>
  `;

  document.body.appendChild(pasteConfirmModal);

  // Event listeners for modal buttons
  document.getElementById("cancelPasteBtn").addEventListener("click", () => {
    pasteConfirmModal.classList.remove("show");
    pendingPasteFiles = [];
  });

  document.getElementById("confirmPasteBtn").addEventListener("click", () => {
    pasteConfirmModal.classList.remove("show");
    if (pendingPasteFiles.length > 0) {
      handleFiles(pendingPasteFiles);
      pendingPasteFiles = [];
    }
  });

  // Close on outside click
  pasteConfirmModal.addEventListener("click", (e) => {
    if (e.target === pasteConfirmModal) {
      pasteConfirmModal.classList.remove("show");
      pendingPasteFiles = [];
    }
  });
}

async function showPasteConfirmation(files) {
  if (!files || files.length === 0) return;

  initPasteConfirmModal();
  pendingPasteFiles = files;

  const container = document.getElementById("pastePreviewContainer");
  container.innerHTML = "";

  const file = files[0]; // Preview the first file
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  const isText =
    file.type.startsWith("text/") ||
    file.type === "application/json" ||
    file.name.endsWith(".txt") ||
    file.name.endsWith(".md") ||
    file.name.endsWith(".js") ||
    file.name.endsWith(".py") ||
    file.name.endsWith(".html");

  const titleEl = document.createElement("div");
  titleEl.style.fontWeight = "bold";
  titleEl.style.marginBottom = "0.5rem";
  titleEl.style.color = "var(--text-bright)";
  titleEl.textContent = `Filename: ${file.name} (${window.litter ? window.litter.formatFileSize(file.size) : file.size + " bytes"})`;
  container.appendChild(titleEl);

  if (isImage) {
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    img.style.maxWidth = "100%";
    img.style.maxHeight = "200px";
    img.style.borderRadius = "4px";
    img.style.display = "block";
    img.style.margin = "0 auto";
    container.appendChild(img);
  } else if (isVideo) {
    const video = document.createElement("video");
    video.src = URL.createObjectURL(file);
    video.controls = true;
    video.style.maxWidth = "100%";
    video.style.maxHeight = "200px";
    video.style.borderRadius = "4px";
    container.appendChild(video);
  } else if (isText) {
    try {
      // Create a slice of the file to prevent massive memory allocation for huge text files
      const blobSlice = file.slice(0, 1024 * 50); // Read only the first 50KB
      const text = await blobSlice.text();

      // Show first 50 lines only
      const lines = text.split("\n").slice(0, 50).join("\n");
      const pre = document.createElement("pre");
      pre.className = "paste-preview-code";

      pre.textContent = lines + (file.size > 1024 * 50 || text.split("\n").length > 50 ? "\n\n... (truncated)" : "");
      container.appendChild(pre);
    } catch (e) {
      container.innerHTML += "<p style='color: var(--text-muted);'>Text preview not available.</p>";
    }
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "paste-preview-placeholder";
    placeholder.textContent = "Binary file (No preview available)";
    container.appendChild(placeholder);
  }

  if (files.length > 1) {
    const extraInfo = document.createElement("div");
    extraInfo.style.marginTop = "0.5rem";
    extraInfo.style.fontSize = "0.85rem";
    extraInfo.style.color = "var(--primary-color)";
    extraInfo.textContent = `+ ${files.length - 1} more file(s)`;
    container.appendChild(extraInfo);
  }

  pasteConfirmModal.classList.add("show");
}

// Add paste event listener for whole document
document.addEventListener("paste", (e) => {
  if (!SettingsManager.settings.enablePaste) return;

  // Ignore if user is typing in an input field
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") {
    return;
  }

  const items = e.clipboardData?.items || [];
  const files = [];
  let pastedText = "";

  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === "file") {
      const file = items[i].getAsFile();
      if (file) {
        if (file.name === "image.png") {
          const newFile = new File([file], `pasted_image_${Date.now()}.png`, { type: file.type });
          files.push(newFile);
        } else {
          files.push(file);
        }
      }
    } else if (items[i].kind === "string" && !pastedText) {
      e.clipboardData.getData("text/plain");
    }
  }

  if (files.length > 0) {
    window.litter?.logger?.info("ui", "Pasted files detected", files.map(f => f.name));
    showPasteConfirmation(files);
    return;
  }

  pastedText = e.clipboardData.getData("text/plain") || e.clipboardData.getData("text") || "";
  if (pastedText) {
    handlePastedText(pastedText);
  }
});

function tryParseJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function tryParseYaml(text) {
  const trimmed = text.trim();
  if (!trimmed || /^---\s*$/.test(trimmed) || /^\.{3}\s*$/.test(trimmed)) return false;

  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  let score = 0;

  for (const line of lines.slice(0, 50)) {
    if (/^\s*#/.test(line)) continue;
    if (/^\s*[-*+]\s+/.test(line)) score += 1;
    if (/^\s*[A-Za-z0-9_-]+\s*:\s*/.test(line)) score += 2;
    if (/^\s{2,}[A-Za-z0-9_-]+\s*:\s*/.test(line)) score += 1;
    if (/^\s*\w+\s*:\s*\S+/.test(line)) score += 1;
  }

  return score >= 2;
}

function tryParseToml(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^\[\[?[^\]]+\]\]?/m.test(trimmed)) return true;
  return /^\s*[A-Za-z0-9_-]+\s*=\s*(".*"|'.*'|\d+|true|false|\[.*\]|\{.*\})\s*$/m.test(trimmed);
}

function detectPastedTextType(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (tryParseJson(trimmed)) return { extension: "json", type: "application/json" };
  if (tryParseYaml(trimmed)) return { extension: "yaml", type: "text/yaml" };
  if (tryParseToml(trimmed)) return { extension: "toml", type: "application/toml" };

  const detectors = [
    { extension: "html", test: value => /^<!doctype html/i.test(value) || /^<html[\s>]/i.test(value) },
    { extension: "css", test: value => /\b[a-z-]+\s*:\s*[^;]+;/.test(value) && /\{[\s\S]*\}/.test(value) },
    { extension: "js", test: value => /\b(function|const|let|var|import|export|class)\b/.test(value) || /=>/.test(value) },
    { extension: "ts", test: value => /\b(interface|type|enum|implements)\b/.test(value) || /:\s*(string|number|boolean|unknown|any)\b/.test(value) },
    { extension: "py", test: value => /\b(def|class|import|from)\b/.test(value) || /^\s*if __name__ == ['\"]__main__['\"]:/m.test(value) },
    { extension: "sh", test: value => /^\s*(?:#!\/bin\/(?:ba)?sh|echo\s+|export\s+|cd\s+)/m.test(value) },
    { extension: "md", test: value => /^\s{0,3}#\s/m.test(value) || /```/.test(value) || /^\s*[-*+]\s+/m.test(value) },
    { extension: "xml", test: value => /^<\?xml\b/i.test(value) || /^<([A-Za-z][A-Za-z0-9:_-]*)(\s|>)/.test(value) },
    { extension: "sql", test: value => /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(value) },
  ];

  for (const detector of detectors) {
    if (detector.test(trimmed)) return { extension: detector.extension, type: "text/plain" };
  }

  return { extension: "txt", type: "text/plain" };
}

function handlePastedText(text) {
  // don't upload empty text or very short snippets that are probably accidental
  if (!text || text.trim().length < 5) return;

  // try to detect if it's code to give it a proper extension
  let extension = "txt";

  if (text.startsWith("<!DOCTYPE html>") || text.startsWith("<html")) {
    extension = "html";
  } else if (text.includes("import ") && text.includes("def ")) {
    extension = "py";
  } else if (
    (text.includes("function ") || text.includes("const ") || text.includes("let ")) &&
    (text.includes("=>") || text.includes("}") || text.includes(";"))
  ) {
    extension = "js";
  } else if (text.startsWith("{") && text.endsWith("}") && text.includes('":')) {
    extension = "json";
  } else if (text.includes("```") || text.startsWith("# ")) {
    extension = "md";
  }

  const filename = `pasted_text_${Date.now()}.${extension}`;
  const file = new File([text], filename, { type: "text/plain" });
  window.litter?.logger?.info("ui", "Pasted text detected", { filename, length: text.length });
  showPasteConfirmation([file]);
}

const SettingsManager = {
  settings: {
    maxConcurrentUploads: 2,
    uploadCooldown: 0,
    maxConcurrentChunks: 3,
    chunkSizeMB: 99,
    theme: "custom",
    customColor: "#90caf9",
    enablePaste: true,
    autoOpenFilePicker: false,
    autoCopyLink: true,
    sessionOnlyHistory: false,
    e2eeEnabled: false,
    customPassphrase: false,
    customPassphraseValue: '',
    randomFilename: false,
    randomFilenameLength: 12,
    e2eeAutoDownload: true,
  },

  _debounceTimers: {},

  init() {
    const saved = localStorage.getItem("userSettings");
    if (saved) {
      try {
        this.settings = { ...this.settings, ...JSON.parse(saved) };
      } catch (e) {
        window.litter?.logger?.error("settings", "Failed to parse settings", e);
      }
    }
    window.litter?.logger?.info("settings", "Settings initialized", this.settings);
    this.applySettings();
    this.updateModalInputs();
    this.setupListeners();
  },

  applySettings() {
    if (this.settings.theme === "random") {
      window.litter?.applyRandomTheme?.();
      document.documentElement.setAttribute("data-theme", "random");
    } else if (this.settings.theme === "custom" && this.settings.customColor) {
      applyCustomColor(this.settings.customColor);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }

    MAX_CONCURRENT_UPLOADS = this.settings.maxConcurrentUploads;
    COOLDOWN_MS = this.settings.uploadCooldown;
    MAX_CONCURRENT_CHUNKS = this.settings.maxConcurrentChunks;
    CHUNK_SIZE = this.settings.chunkSizeMB * 1024 * 1024;
  },

  updateModalInputs() {
    const inputs = {
      maxConcurrentUploads: document.getElementById("maxConcurrentUploads"),
      uploadCooldown: document.getElementById("uploadCooldown"),
      maxConcurrentChunks: document.getElementById("maxConcurrentChunks"),
      chunkSizeMB: document.getElementById("chunkSizeMB"),
      themeSelect: document.getElementById("themeSelect"),
      primaryColorPicker: document.getElementById("primaryColorPicker"),
      enablePaste: document.getElementById("enablePaste"),
      autoOpenFilePicker: document.getElementById("autoOpenFilePicker"),
      autoCopyLink: document.getElementById("autoCopyLink"),
      sessionOnlyHistory: document.getElementById("sessionOnlyHistory"),
      e2eeEnabled: document.getElementById("e2eeEnabled"),
      customPassphrase: document.getElementById("customPassphrase"),
      customPassphraseValue: document.getElementById("customPassphraseValue"),
      randomFilename: document.getElementById("randomFilename"),
      randomFilenameLength: document.getElementById("randomFilenameLength"),
    };

    if (inputs.maxConcurrentUploads) inputs.maxConcurrentUploads.value = this.settings.maxConcurrentUploads;
    if (inputs.uploadCooldown) inputs.uploadCooldown.value = this.settings.uploadCooldown;
    if (inputs.maxConcurrentChunks) inputs.maxConcurrentChunks.value = this.settings.maxConcurrentChunks;
    if (inputs.chunkSizeMB) inputs.chunkSizeMB.value = this.settings.chunkSizeMB;
    if (inputs.themeSelect) inputs.themeSelect.value = this.settings.theme;
    if (inputs.primaryColorPicker) inputs.primaryColorPicker.value = this.settings.customColor || "#90caf9";
    if (inputs.enablePaste) inputs.enablePaste.checked = this.settings.enablePaste;
    if (inputs.autoOpenFilePicker) inputs.autoOpenFilePicker.checked = this.settings.autoOpenFilePicker;
    if (inputs.autoCopyLink) inputs.autoCopyLink.checked = this.settings.autoCopyLink;
    if (inputs.sessionOnlyHistory) inputs.sessionOnlyHistory.checked = this.settings.sessionOnlyHistory;
    if (inputs.e2eeEnabled) inputs.e2eeEnabled.checked = this.settings.e2eeEnabled;
    if (inputs.customPassphrase) inputs.customPassphrase.checked = this.settings.customPassphrase;
    if (inputs.customPassphraseValue) inputs.customPassphraseValue.value = this.settings.customPassphraseValue || '';
    if (inputs.randomFilename) inputs.randomFilename.checked = this.settings.randomFilename;
    if (inputs.randomFilenameLength) inputs.randomFilenameLength.value = this.settings.randomFilenameLength || 12;
    if (inputs.e2eeAutoDownload) inputs.e2eeAutoDownload.checked = this.settings.e2eeAutoDownload !== false;

    this._updateE2eeVisibility();
    this._updateColorPickerVisibility();
  },

  setupListeners() {
    const footerSize = document.getElementById("totalSizeFooter");
    if (footerSize) {
      footerSize.addEventListener("click", () => openSettingsDrawer());
    }

    const closeSettingsBtn = document.getElementById("closeSettingsDrawer");
    if (closeSettingsBtn) {
      closeSettingsBtn.addEventListener("click", () => closeSettingsDrawer());
    }

    const exitSettingsBtn = document.getElementById("exitSettingsBtn");
    if (exitSettingsBtn) {
      exitSettingsBtn.addEventListener("click", () => closeSettingsDrawer());
    }

    const settingsOverlay = document.getElementById("settingsDrawerOverlay");
    if (settingsOverlay) {
      settingsOverlay.addEventListener("click", () => closeSettingsDrawer());
    }

    // Auto-save: immediate for toggles/selects, debounced for text/number inputs
    const toggleIds = ["enablePaste", "autoOpenFilePicker", "autoCopyLink", "sessionOnlyHistory", "e2eeEnabled", "customPassphrase", "randomFilename", "e2eeAutoDownload"];
    for (const id of toggleIds) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("change", () => {
          this._updateE2eeVisibility();
          this.save();
        });
      }
    }

    const selectIds = ["themeSelect"];
    for (const id of selectIds) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("change", () => {
          this._updateColorPickerVisibility();
          this.save();
        });
      }
    }

    const colorPicker = document.getElementById("primaryColorPicker");
    if (colorPicker) {
      colorPicker.addEventListener("input", (e) => {
        applyCustomColor(e.target.value);
        this._debouncedSave("primaryColorPicker", 300);
      });
    }

    const debouncedInputIds = ["maxConcurrentUploads", "uploadCooldown", "maxConcurrentChunks", "chunkSizeMB", "randomFilenameLength", "customPassphraseValue"];
    for (const id of debouncedInputIds) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("input", () => this._debouncedSave(id, 300));
      }
    }
  },

  _debouncedSave(key, delayMs) {
    if (this._debounceTimers[key]) clearTimeout(this._debounceTimers[key]);
    this._debounceTimers[key] = setTimeout(() => {
      this._debounceTimers[key] = null;
      this.save();
    }, delayMs);
  },

  _updateE2eeVisibility() {
    const e2eeOn = document.getElementById("e2eeEnabled")?.checked || false;
    const customOn = document.getElementById("customPassphrase")?.checked || false;
    const randomOn = document.getElementById("randomFilename")?.checked || false;

    const customGroup = document.getElementById("customPassphraseGroup");
    const customValueGroup = document.getElementById("customPassphraseValueGroup");
    const randomGroup = document.getElementById("randomFilenameLengthGroup");

    if (customGroup) customGroup.style.display = e2eeOn ? "" : "none";
    if (customValueGroup) customValueGroup.style.display = (e2eeOn && customOn) ? "" : "none";
    if (randomGroup) randomGroup.style.display = (e2eeOn && randomOn) ? "" : "none";
  },

  _updateColorPickerVisibility() {
    const theme = document.getElementById("themeSelect")?.value || "custom";
    const colorPickerGroup = document.getElementById("colorPickerGroup");
    if (colorPickerGroup) colorPickerGroup.style.display = (theme === "custom") ? "" : "none";
  },

  save() {
    const getVal = (id, min, max) => {
      const el = document.getElementById(id);
      if (!el) return min;
      let val = parseInt(el.value);
      if (isNaN(val)) val = min;
      return Math.min(Math.max(val, min), max);
    };

    const getChecked = (id) => document.getElementById(id)?.checked || false;

    this.settings = {
      maxConcurrentUploads: getVal("maxConcurrentUploads", 1, 10),
      uploadCooldown: getVal("uploadCooldown", 0, 10000),
      maxConcurrentChunks: getVal("maxConcurrentChunks", 1, 10),
      chunkSizeMB: getVal("chunkSizeMB", 1, 99),
      theme: document.getElementById("themeSelect")?.value || this.settings.theme,
      customColor: document.getElementById("primaryColorPicker")?.value || this.settings.customColor,
      enablePaste: getChecked("enablePaste"),
      autoOpenFilePicker: getChecked("autoOpenFilePicker"),
      autoCopyLink: document.getElementById("autoCopyLink")?.checked !== false,
      sessionOnlyHistory: getChecked("sessionOnlyHistory"),
      e2eeEnabled: getChecked("e2eeEnabled"),
      customPassphrase: getChecked("customPassphrase"),
      customPassphraseValue: document.getElementById("customPassphraseValue")?.value || '',
      randomFilename: getChecked("randomFilename"),
      randomFilenameLength: getVal("randomFilenameLength", 6, 32),
      e2eeAutoDownload: getChecked("e2eeAutoDownload"),
    };

    localStorage.setItem("userSettings", JSON.stringify(this.settings));
    this.applySettings();
    window.litter?.logger?.info("settings", "Settings saved", this.settings);
  },
};

window.addEventListener("beforeunload", (e) => {
  if (activeUploads > 0 || uploadQueue.length > 0) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function setupModals() {
  const privacyBtns = document.querySelectorAll("#privacyBtn");
  const termsBtns = document.querySelectorAll("#termsBtn");
  const privacyModal = document.getElementById("privacyModal");
  const termsModal = document.getElementById("termsModal");
  const closeButtons = document.querySelectorAll(".close-modal");

  function showModal(modal) {
    if (modal) modal.classList.add("show");
  }

  function hideModal(modal) {
    if (modal) modal.classList.remove("show");
  }

  privacyBtns.forEach((btn) => btn.addEventListener("click", () => showModal(privacyModal)));
  termsBtns.forEach((btn) => btn.addEventListener("click", () => showModal(termsModal)));

  closeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      hideModal(privacyModal);
      hideModal(termsModal);
      hideModal(document.getElementById("gif2webpModal"));
    });
  });

  window.addEventListener("click", (e) => {
    if (e.target === privacyModal) hideModal(privacyModal);
    if (e.target === termsModal) hideModal(termsModal);
    if (e.target === document.getElementById("gif2webpModal")) hideModal(document.getElementById("gif2webpModal"));
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideModal(privacyModal);
      hideModal(termsModal);
      hideModal(document.getElementById("gif2webpModal"));
      closeSettingsDrawer();
      closeImageModal();
    }
  });
}

// Settings Drawer functions
function openSettingsDrawer() {
	const drawer = document.getElementById("settingsDrawer");
	const overlay = document.getElementById("settingsDrawerOverlay");
	if (drawer) drawer.classList.add("active");
	if (overlay) overlay.classList.add("active");
	document.body.style.overflow = "hidden";
}

function closeSettingsDrawer() {
	const drawer = document.getElementById("settingsDrawer");
	const overlay = document.getElementById("settingsDrawerOverlay");
	if (drawer) drawer.classList.remove("active");
	if (overlay) overlay.classList.remove("active");
	document.body.style.overflow = "";
}

function applyCustomColor(hexColor) {
  const root = document.documentElement;
  const tempDiv = document.createElement("div");
  tempDiv.style.color = hexColor;
  document.body.appendChild(tempDiv);
  const rgbColor = window.getComputedStyle(tempDiv).color;
  document.body.removeChild(tempDiv);

  const rgbMatch = rgbColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!rgbMatch) return;
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
  root.style.setProperty("--link-color", hexColor);
  root.style.setProperty("--link-hover", `rgba(${r}, ${g}, ${b}, 0.85)`);
  root.style.setProperty("--link-bright", hexColor);
  root.style.setProperty("--primary-color", hexColor);
  root.style.setProperty("--notification-success-bg", "rgba(80, 250, 123, 0.85)");
  root.style.setProperty("--notification-error-bg", "rgba(255, 85, 85, 0.85)");
  root.style.setProperty("--notification-info-bg", `rgba(${r}, ${g}, ${b}, 0.7)`);
  root.style.setProperty("--progress-bg", `rgba(${r}, ${g}, ${b}, 0.15)`);
  root.style.setProperty("--progress-fill", hexColor);
  root.style.setProperty("--input-bg", `rgba(${r}, ${g}, ${b}, 0.08)`);
  root.style.setProperty("--input-border", `rgba(${r}, ${g}, ${b}, 0.25)`);
  root.style.setProperty("--input-focus", `rgba(${r}, ${g}, ${b}, 0.45)`);

  const colorPicker = document.getElementById("primaryColorPicker");
  if (colorPicker) colorPicker.value = hexColor;

  document.documentElement.removeAttribute("data-theme");
  localStorage.setItem("themeMode", "custom");
}

const dragDropBox = document.getElementById("dragDropBox");
const fileInput = document.getElementById("fileInput");
const fileList = document.getElementById("fileList");
const status = document.getElementById("status");
let uploadQueue = [];
let activeUploads = 0;
let uploadSpeeds = new Map(); // Track individual upload speeds
let fileUploads = new Map(); // Track active upload states (XHRs, chunks)
let globalSpeedInterval = null;

function updateGlobalSpeed() {
  const totalSpeedMbps = Array.from(uploadSpeeds.values()).reduce((a, b) => a + b, 0);
  const footerSize = document.getElementById("totalSizeFooter");
  if (footerSize) {
    const storageText = footerSize.getAttribute("data-storage") || footerSize.textContent;
    if (!footerSize.getAttribute("data-storage")) {
      footerSize.setAttribute("data-storage", storageText);
    }

    if (totalSpeedMbps > 0) {
      footerSize.textContent = `${storageText} | Speed: ${totalSpeedMbps.toFixed(2)} Mbps`;
    } else {
      footerSize.textContent = storageText;
    }
  }
}

function startGlobalSpeedTracker() {
  if (globalSpeedInterval) return;
  globalSpeedInterval = setInterval(updateGlobalSpeed, 1000);
}

function stopGlobalSpeedTracker() {
  if (globalSpeedInterval) {
    clearInterval(globalSpeedInterval);
    globalSpeedInterval = null;
    const footerSize = document.getElementById("totalSizeFooter");
    if (footerSize && footerSize.getAttribute("data-storage")) {
      footerSize.textContent = footerSize.getAttribute("data-storage");
    }
  }
}

let MAX_CONCURRENT_UPLOADS = 2;
let COOLDOWN_MS = 0;
let MAX_CONCURRENT_CHUNKS = 3;
let CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks

// Network resilience state
let isNetworkDown = false;
let networkRetryCount = 0;
const MAX_NETWORK_RETRIES = 10;

dragDropBox.addEventListener("click", () => fileInput.click());

dragDropBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

// Full-page drag-and-drop
const dragOverlay = document.createElement("div");
  dragOverlay.className = "full-page-drag-overlay";
  document.body.appendChild(dragOverlay);

let dragCounter = 0;

document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (e.dataTransfer.types.includes("Files")) {
    dragCounter++;
    dragOverlay.classList.add("active");
  }
});

document.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) {
    dragOverlay.classList.remove("active");
  }
});

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragCounter = 0;
  dragOverlay.classList.remove("active");
  
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    // Only handle if we're on a page with the dragDropBox
    if (document.getElementById("dragDropBox")) {
      window.litter?.logger?.info("ui", "Files dropped", Array.from(e.dataTransfer.files).map(f => f.name));
      handleFiles(e.dataTransfer.files);
    }
  }
});

// Keep original box events for visual feedback
dragDropBox.addEventListener("dragover", (e) => {
  e.preventDefault();
  dragDropBox.classList.add("drag-over");
});

dragDropBox.addEventListener("dragleave", () => {
  dragDropBox.classList.remove("drag-over");
});

dragDropBox.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDropBox.classList.remove("drag-over");
});

fileInput.addEventListener("change", () => handleFiles(fileInput.files));

// Remove the glowing effect once a file is dropped or selected
function handleFiles(files) {
  if (!files?.length) return;

  window.litter?.logger?.info("upload", "Files selected", Array.from(files).map(f => `${f.name} (${window.litter.formatFileSize(f.size)})`));

  const dragDropBox = document.getElementById("dragDropBox");
  if (dragDropBox) {
    // Remove the glow and save visit state
    dragDropBox.classList.remove("first-visit-glow");
    localStorage.setItem("hasVisited", "true");

    // Trigger pulse animation on drag box
    dragDropBox.classList.remove("files-added");
    void dragDropBox.offsetWidth; // Trigger reflow
    dragDropBox.classList.add("files-added");
  }

  const maxSize = (window.__LITTER_CONFIG__?.maxFileSizeBytes) || (80 * 1024 * 1024 * 1024);
  const maxSizeGB = (window.__LITTER_CONFIG__?.maxFileSizeGB) || 80;
  Array.from(files).forEach((file) => {
    if (file.size > maxSize) {
      window.litter?.logger?.warn("upload", "File exceeds size limit", file.name, window.litter.formatFileSize(file.size));
      showStatus(`${file.name} exceeds ${maxSizeGB}GB limit`, true);
      return;
    }

const fileItem = createFileItem(file);
        fileList.insertBefore(fileItem, fileList.firstChild);
        // Show fileList when it has items
        if (fileList.style.display === 'none') {
            fileList.style.display = '';
        }
        addToUploadQueue(file, fileItem);
  });
}

function createFileItem(file) {
  const item = document.createElement("li");
  item.className = "file-item";

  // Header row with Name and Percentage
  const fileInfo = document.createElement("div");
  fileInfo.className = "file-info-header";

  // Left side contains preview and file info
  const fileInfoLeft = document.createElement("div");
  fileInfoLeft.className = "file-info-left";

  // Add preview thumbnail if the file can be displayed
  if (file.type.startsWith("image/")) {
    const preview = document.createElement("img");
    preview.className = "file-preview";
    preview.src = URL.createObjectURL(file);
    preview.alt = file.name;
    preview.addEventListener("click", () => openImageModal(preview.src));
    fileInfoLeft.appendChild(preview);
  }

  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = file.name;
  name.style.marginBottom = "0";

  fileInfoLeft.appendChild(name);
  fileInfo.appendChild(fileInfoLeft);

  const statusText = document.createElement("span");
  statusText.className = "status-text";
  statusText.textContent = "0%";
  statusText.style.fontWeight = "bold";
  statusText.style.color = "var(--primary-color)";

  const controls = document.createElement("div");
  controls.className = "file-controls";
  controls.style.display = "flex";
  controls.style.gap = "0.5rem";
  controls.style.alignItems = "center";

const pauseBtn = document.createElement("button");
 pauseBtn.className = "control-btn pause-btn";
 pauseBtn.innerHTML = "Pause";
 pauseBtn.setAttribute("aria-label", "Pause upload");
 pauseBtn.style.display = "none"; // Only show for chunked uploads
  pauseBtn.style.padding = "2px 8px";
  pauseBtn.style.fontSize = "0.75rem";
  pauseBtn.style.background = "var(--button-bg)";
  pauseBtn.style.border = "1px solid var(--border)";
  pauseBtn.style.borderRadius = "4px";
  pauseBtn.style.color = "var(--text)";
  pauseBtn.style.cursor = "pointer";

  controls.appendChild(pauseBtn);
  controls.appendChild(statusText);

  fileInfo.appendChild(fileInfoLeft);
  fileInfo.appendChild(controls);

  // Stats row
  const stats = document.createElement("div");
  stats.className = "file-stats";
  stats.style.marginBottom = "0.5rem";
  stats.innerHTML = `
                <span>Size: ${window.litter.formatFileSize(file.size)}</span>
                <span>Status: Queued</span>
            `;

  // Create flip container for progress/link transition
  const flipContainer = document.createElement("div");
  flipContainer.className = "flip-container";

  const flipper = document.createElement("div");
  flipper.className = "flipper";

  // Front face - progress bar
  const flipFront = document.createElement("div");
  flipFront.className = "flip-front";

  const progressWrapper = document.createElement("div");
  progressWrapper.className = "upload-progress-wrapper";

  const progressBar = document.createElement("div");
  progressBar.className = "upload-progress-bar";

  progressWrapper.appendChild(progressBar);
  flipFront.appendChild(progressWrapper);

  // Back face - link input (initially hidden)
  const flipBack = document.createElement("div");
  flipBack.className = "flip-back";
  flipBack.style.display = "none";

  flipper.appendChild(flipFront);
  flipper.appendChild(flipBack);
  flipContainer.appendChild(flipper);

  item.appendChild(fileInfo);
  item.appendChild(stats);
  item.appendChild(flipContainer);

  return item;
}

// Image modal functionality
let imageModal = null;
let modalImage = null;
let isZoomed = false;
let isDragging = false;
let currentX = 0;
let currentY = 0;
let initialX = 0;
let initialY = 0;
let xOffset = 0;
let yOffset = 0;

function initImageModal() {
  imageModal = document.createElement("div");
  imageModal.className = "image-modal";

  modalImage = document.createElement("img");

  const closeButton = document.createElement("div");
  closeButton.className = "image-modal-close";
  closeButton.innerHTML = "×";

  imageModal.appendChild(modalImage);
  imageModal.appendChild(closeButton);
  document.body.appendChild(imageModal);

  // Close modal on background click
  imageModal.addEventListener("click", (e) => {
    if (e.target === imageModal) {
      closeImageModal();
    }
  });

  // Close modal on close button click
  closeButton.addEventListener("click", closeImageModal);

  // Zoom functionality
  modalImage.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!isZoomed) {
      // Calculate zoom origin based on click position
      const rect = modalImage.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const xPercent = (x / rect.width) * 100;
      const yPercent = (y / rect.height) * 100;

      modalImage.style.transformOrigin = `${xPercent}% ${yPercent}%`;
      modalImage.style.transform = "translate(-50%, -50%) scale(2)";
      modalImage.classList.add("zoomed");
      isZoomed = true;
    } else {
      modalImage.style.transform = "translate(-50%, -50%) scale(1)";
      modalImage.classList.remove("zoomed");
      isZoomed = false;
    }
  });

  // Drag functionality for zoomed image
  modalImage.addEventListener("mousedown", dragStart);
  document.addEventListener("mousemove", drag);
  document.addEventListener("mouseup", dragEnd);
}

function openImageModal(src) {
  if (!imageModal) initImageModal();
  modalImage.src = src;
  imageModal.classList.add("show");
  // Reset zoom state
  modalImage.style.transform = "translate(-50%, -50%) scale(1)";
  modalImage.classList.remove("zoomed");
  isZoomed = false;
  xOffset = 0;
  yOffset = 0;
}

function closeImageModal() {
  imageModal.classList.remove("show");
}

function dragStart(e) {
  if (!isZoomed) return;

  initialX = e.clientX - xOffset;
  initialY = e.clientY - yOffset;

  if (e.target === modalImage) {
    isDragging = true;
  }
}

function drag(e) {
  if (isDragging) {
    e.preventDefault();
    currentX = e.clientX - initialX;
    currentY = e.clientY - initialY;

    xOffset = currentX;
    yOffset = currentY;

    modalImage.style.transform = `translate(calc(-50% + ${currentX}px), calc(-50% + ${currentY}px)) scale(2)`;
  }
}

function dragEnd(e) {
  initialX = currentX;
  initialY = currentY;
  isDragging = false;
}

function showStatus(message, isError = false) {
  status.textContent = message;
  status.style.color = isError ? "#ff6b6b" : "var(--text-bright)";
  status.classList.add("show");
  setTimeout(() => status.classList.remove("show"), 3000);
}

function showToast(msg) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = "toast show";
  setTimeout(() => {
    toast.className = toast.className.replace("show", "");
  }, 3000);
}

function handleUploadSuccess(file, fileItem, fullUrl, apiPath, deleteSecret = null) {
  window.litter?.logger?.info("upload", "Upload complete", `${file.name} -> ${apiPath}`);

  // If E2EE was used for this upload, transform URL and append passphrase
  if (file._e2eePassphrase && fullUrl) {
    // Transform /files/:id/:filename to /files/e2ee/:id/:filename
    fullUrl = fullUrl.replace(/^\/files\/([^\/]+)\//, '/files/e2ee/' + '$1/');
    fullUrl = E2EEManager.buildE2EEUrl(fullUrl, file._e2eePassphrase);
  }

  const stats = fileItem.querySelector(".file-stats");
  const statusText = fileItem.querySelector(".status-text");
  const progressBar = fileItem.querySelector(".upload-progress-bar");

  showStatus(`Uploaded ${file.name} Successfully!`);
  fileItem.classList.add("success");

  // Save to history
  const apiPathParts = apiPath.split("/").filter(Boolean);
  const historyPublicId = apiPathParts[1];

  saveToHistory(
    historyPublicId,
    file.name,
    file.size,
    fullUrl,
    deleteSecret,
    file.type
  );

  // Auto-copy to clipboard if enabled
  if (SettingsManager.settings.autoCopyLink) {
    try {
      navigator.clipboard.writeText(fullUrl).then(() => {
        showToast("Copied!");
      });
    } catch (err) {
      const input = document.createElement("input");
      input.value = fullUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      showToast("Copied!");
    }
  }

  // Ensure progress bar shows 100% before disappearing
  if (progressBar) progressBar.style.width = "100%";
  if (statusText) statusText.textContent = "100%";

  // Show link input after brief delay with flip animation
  setTimeout(() => {
    // Find flip container and elements
    const flipContainer = fileItem.querySelector(".flip-container");
    const flipBack = fileItem.querySelector(".flip-back");

    // Update status text to Done
    if (statusText) {
      statusText.textContent = "Done";
      statusText.style.color = "var(--text-bright)";
    }

    // Create link input for back face
    const linkInput = document.createElement("input");
    linkInput.type = "text";
    linkInput.className = "link-input";
    linkInput.value = fullUrl;
    linkInput.readOnly = true;
    linkInput.title = "Click to copy link";
    linkInput.style.width = "100%";
    linkInput.style.padding = "8px 12px";
    linkInput.style.border = "1px solid var(--border)";
    linkInput.style.borderRadius = "6px";
    linkInput.style.background = "var(--button-bg)";
    linkInput.style.color = "var(--text)";
    linkInput.style.fontSize = "0.9rem";

    // Add click to copy functionality
    linkInput.addEventListener("click", async function () {
      this.select();

      try {
        await navigator.clipboard.writeText(fullUrl);
        showStatus("Link copied to clipboard!");
      } catch (err) {
        document.execCommand("copy");
        showStatus("Link copied to clipboard!");
      }
    });

    // Add link input to back face
    flipBack.innerHTML = "";
    flipBack.appendChild(linkInput);

// Add archive and delete buttons if deleteSecret exists
  if (deleteSecret) {
    // Archive dropdown button
    const archiveBtn = document.createElement("button");
    archiveBtn.className = "button archive-btn";
    archiveBtn.textContent = "Archive";
    archiveBtn.style.marginLeft = "8px";
    archiveBtn.style.padding = "4px 12px";
    archiveBtn.style.fontSize = "0.85rem";

    archiveBtn.addEventListener("click", (e) => {
      const rect = e.target.getBoundingClientRect();
      const apiPathParts = apiPath.split("/").filter(Boolean);
      const publicId = apiPathParts[1];
      UploadHistoryManager.showArchiveDropdown(publicId, fullUrl, rect);
    });

    flipBack.appendChild(archiveBtn);

    // Delete button with modal confirmation
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "button button-danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.style.marginLeft = "8px";
    deleteBtn.style.padding = "4px 12px";
    deleteBtn.style.fontSize = "0.85rem";

    deleteBtn.addEventListener("click", async () => {
      const apiPathParts = apiPath.split("/").filter(Boolean);
      const publicId = apiPathParts[1];
      const filename = apiPathParts.slice(2).join("/");

      UploadHistoryManager.showConfirmModal(
        "delete file?",
        "are you sure you want to delete this file? this action cannot be undone.",
        async () => {
          deleteBtn.disabled = true;
          deleteBtn.textContent = "Deleting...";

          try {
            if (apiPathParts[0] !== "files" || !publicId || !filename) {
              throw new Error("Invalid file path");
            }

            const response = await fetch(
              `/files/${publicId}/${encodeURIComponent(filename)}`,
              {
                method: "DELETE",
                headers: {
                  "X-Delete-Secret": deleteSecret,
                },
              }
            );

            if (response.ok) {
              showStatus("File deleted successfully");
              fileItem.remove();
              if (typeof UploadHistoryManager !== "undefined") {
                UploadHistoryManager.removeItem(publicId);
              }
            } else {
              const data = await response.json();
              showStatus(data.message || "Failed to delete file");
              deleteBtn.disabled = false;
              deleteBtn.textContent = "Delete";
            }
          } catch (err) {
            showStatus("Delete failed: " + err.message);
            deleteBtn.disabled = false;
            deleteBtn.textContent = "Delete";
          }
        }
      );
    });

    flipBack.appendChild(deleteBtn);
  }

    flipBack.style.display = "flex";
    flipBack.style.alignItems = "center";

    // Trigger flip animation
    flipContainer.classList.add("flipped");

    // Update preview to remote URL if it's an image
    const preview = fileItem.querySelector(".file-preview");
    if (preview && file.type.startsWith("image/")) {
      // Create new image to preload remote version
      const remoteImg = new Image();
      remoteImg.onload = () => {
        // Switch to remote URL once loaded
        preview.src = fullUrl;
        // Update modal click handler to use remote URL
        preview.onclick = () => openImageModal(fullUrl);
      };
      remoteImg.src = fullUrl;
    }
  }, 500);

  // update file name to be clickable link
  fileItem.querySelector(".file-name").innerHTML =
    `<a href="${fullUrl}" target="_blank" style="text-decoration: underline;">${file.name}</a>`;
  stats.innerHTML = `
                      <span>Size: ${window.litter.formatFileSize(file.size)}</span>
                      <span>Status: Complete</span>
                  `;
}

async function calculateFileHash(file) {
  // Optimization: Only hash files <= 500MB
  if (file.size > 500 * 1024 * 1024) {
    window.litter?.logger?.debug("upload", "File too large for client-side hashing, skipping", file.name, window.litter.formatFileSize(file.size));
    return null;
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    return hashHex;
  } catch (e) {
    window.litter?.logger?.error("upload", "Hash calculation failed", e);
    return null;
  }
}

function setupXhrListeners(xhr, file, fileItem, stats, cleanup, uploadId) {
  const statusText = fileItem.querySelector(".status-text");
  const progressBar = fileItem.querySelector(".upload-progress-bar");
  const fallbackStats = fileItem.querySelector(".file-stats");
  const statsElement = stats || fallbackStats;

  let lastLoaded = 0;
  let lastTime = Date.now();
  let uploadSpeed = 0;
  const SMOOTHING_FACTOR = 0.1;

  const speedUpdateInterval = setInterval(() => {
    const currentTime = Date.now();
    const timeElapsed = (currentTime - lastTime) / 1000;

    if (timeElapsed > 0) {
      const currentLoaded = xhr.upload ? xhr.upload.loaded || 0 : 0;
      const loadedSinceLast = currentLoaded - lastLoaded;

      if (loadedSinceLast > 0) {
        const instantSpeed = (loadedSinceLast * 8) / (timeElapsed * 1000000); // mbps
        if (uploadSpeed === 0) {
          uploadSpeed = instantSpeed;
        } else {
          uploadSpeed = instantSpeed * SMOOTHING_FACTOR + uploadSpeed * (1 - SMOOTHING_FACTOR);
        }
        // Update global tracker
        uploadSpeeds.set(uploadId || xhr, uploadSpeed);
        startGlobalSpeedTracker();
      } else {
        uploadSpeeds.set(uploadId || xhr, 0);
      }
      lastLoaded = currentLoaded;
      lastTime = currentTime;
    }
  }, 500);

  cleanup.intervals.push(speedUpdateInterval);

  xhr.upload.addEventListener("progress", (e) => {
    if (e.lengthComputable && statsElement && stats) {
      const uploadedSize = window.litter.formatFileSize(e.loaded);
      const totalSize = window.litter.formatFileSize(e.total);
      const speedText = uploadSpeed > 0 ? `${uploadSpeed.toFixed(2)} Mbps` : "0.00 Mbps";
      const clientPercent = Math.round((e.loaded / e.total) * 100);
      const displayPercent = Math.round(clientPercent * 0.8);

      statsElement.innerHTML = `
                            <span>Size: ${totalSize}</span>
                            <span>Uploaded: ${uploadedSize}</span>
                            <span>Speed: ${speedText.padStart(10, " ")}</span>
                        `;

      if (progressBar) progressBar.style.width = `${displayPercent}%`;
      if (statusText) statusText.textContent = `${displayPercent}%`;
    }
  });

  xhr.upload.addEventListener("loadend", () => {
    clearInterval(speedUpdateInterval);
    uploadSpeeds.delete(uploadId || xhr);
    if (uploadSpeeds.size === 0) stopGlobalSpeedTracker();

    // For standard uploads, show processing on loadend
    // For chunked, we handle this manually in finalizeUpload instead to prevent premature 'processing' message
    if (stats && statsElement) {
      statsElement.innerHTML = `
                        <span>Size: ${window.litter.formatFileSize(file.size)}</span>
                        <span>Status: Server Processing...</span>
                    `;
      if (statusText) statusText.textContent = "Processing...";
      if (progressBar) progressBar.style.width = "100%";
    }
  });
}

// Network resilience helpers
const waitForNetwork = async () => {
  if (!navigator.onLine) {
    window.litter?.logger?.info("network", "Network offline, waiting for connectivity");
    const fileItem = document.querySelector(".uploading");
    if (fileItem) {
      const stats = fileItem.querySelector(".file-stats");
      if (stats) {
        const sizeSpan = stats.querySelector("span:first-child");
        stats.innerHTML = `${sizeSpan ? sizeSpan.outerHTML : ""}<span style="color: #ffa500;">Waiting for network...</span>`;
      }
    }
  }
  while (!navigator.onLine) {
    await new Promise(r => setTimeout(r, 2000));
  }
  // Network is back online — probe the server
  let probeSuccess = false;
  for (let i = 0; i < MAX_NETWORK_RETRIES; i++) {
    try {
      await fetch("/api/status", { method: "HEAD", cache: "no-store" });
      probeSuccess = true;
      isNetworkDown = false;
      networkRetryCount = 0;
      break;
    } catch (e) {
      window.litter?.logger?.warn("network", `Network probe failed (${i + 1}/${MAX_NETWORK_RETRIES})`, e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  if (!probeSuccess) {
    isNetworkDown = false; // Give up waiting, let retries continue
    networkRetryCount = 0;
  }
};

const isNetworkFailure = (error) => {
  const msg = error.message || "";
  const netErrors = [
    "net::ERR_NETWORK_IO_SUSPENDED",
    "net::ERR_NETWORK_CHANGED",
    "net::ERR_HTTP2_PROTOCOL_ERROR",
    "networkerror",
    "Failed to fetch",
    "Network request failed",
    "Network error",
  ];
  const netStatuses = [524, 502, 503, 504];
  return netErrors.some(e => msg.includes(e)) || netStatuses.includes(error.status);
};

async function uploadStandard(file, fileItem, url) {
  window.litter?.logger?.debug("upload", "Starting standard upload", { file: file.name, size: window.litter.formatFileSize(file.size), url });
  const stats = fileItem.querySelector(".file-stats");
  const isExternal = url.startsWith("http") && !url.includes(window.location.hostname);
  const pauseBtn = fileItem.querySelector(".pause-btn");

  let retryCount = 0;
  const MAX_RETRIES = 2;
  let isPaused = false;
  let currentXhr = null;

  if (pauseBtn) {
    pauseBtn.style.display = "block";
    pauseBtn.innerHTML = "Abort";
 pauseBtn.setAttribute("aria-label", "Abort upload");
    pauseBtn.onclick = () => {
      if (currentXhr) {
        currentXhr.abort();
        showStatus(`Upload aborted for ${file.name}`);
        fileItem.classList.add("failed");
        if (stats) {
          stats.innerHTML = `
            <span>Size: ${window.litter.formatFileSize(file.size)}</span>
            <span style="color: #ff6b6b">Status: Aborted</span>
          `;
        }
        pauseBtn.style.display = "none";
      }
    };
  }

 const attempt = async (targetUrl) => {
 const xhr = new XMLHttpRequest();
 currentXhr = xhr;
 const formData = new FormData();

      if (file._e2eeEnabled) {
        if (stats) {
          stats.innerHTML = `
            <span>Size: ${window.litter.formatFileSize(file.size)}</span>
            <span>Status: Preparing encryption...</span>
          `;
        }
        const encrypted = await E2EEManager.encryptFile(file, file._e2eePassphrase, function(stage, pct) {
          if (stats) {
            if (stage === "reading") {
              stats.innerHTML = `
                <span>Size: ${window.litter.formatFileSize(file.size)}</span>
                <span>Status: Reading file (${window.litter.formatFileSize(file.size)})...</span>
              `;
            } else if (stage === "encrypting") {
              stats.innerHTML = `
                <span>Size: ${window.litter.formatFileSize(file.size)}</span>
                <span>Status: Encrypting (PBKDF2 + AES-256-GCM)... ${pct}%</span>
              `;
            }
          }
        });
        if (stats) {
          stats.innerHTML = `
            <span>Size: ${window.litter.formatFileSize(file.size)} → ${window.litter.formatFileSize(encrypted.encryptedBlob.size)}</span>
            <span>Status: Encrypted, uploading...</span>
          `;
        }
 const encryptedFile = new File([encrypted.encryptedBlob], file.name, { type: "application/octet-stream" });
 formData.append("file", encryptedFile);
 xhr.open("POST", targetUrl);
 xhr.setRequestHeader("X-E2EE", "true");
 if (file._randomFilename) {
 xhr.setRequestHeader("X-Random-Filename", String(file._randomFilenameLength || 12));
 }
 } else {
 formData.append("file", file);
 xhr.open("POST", targetUrl);
 }

 return new Promise((resolve, reject) => {

      const cleanup = { intervals: [], timeouts: [] };
      const clearAll = () => {
        cleanup.intervals.forEach(clearInterval);
        cleanup.timeouts.forEach(clearTimeout);
      };

      setupXhrListeners(xhr, file, fileItem, stats, cleanup);

      xhr.addEventListener("load", () => {
        clearAll();
        if (pauseBtn) pauseBtn.style.display = "none";

if (xhr.status === 200) {
                        try {
          const data = JSON.parse(xhr.responseText);
          let fullUrl = data.url;
          let apiPath = data.url;
          // Handle relative URL from server
          if (!data.url.startsWith('http')) {
            fullUrl = window.location.origin + data.url;
          }
          apiPath = new URL(fullUrl).pathname;
          if (data.deduplicated && data.alreadyExisted) {
            showStatus(`${file.name} already uploaded`);
          } else if (data.deduplicated) {
            showStatus(`Linked to existing file as ${file.name}`);
          }
          handleUploadSuccess(file, fileItem, fullUrl, apiPath, data.deleteSecret);
                            resolve(apiPath);
                        } catch (e) {
            // Fallback for older plaintext response
            const apiPath = xhr.responseText;
            const fullUrl = `${window.location.origin}${apiPath}`;
            handleUploadSuccess(file, fileItem, fullUrl, apiPath);
            resolve(apiPath);
          }
        } else if (xhr.status === 429) {
          // Try to parse error response for wait time
          let errorData = null;
          try {
            errorData = JSON.parse(xhr.responseText);
          } catch (e) {
            // Ignore parse errors
          }
          
        // If we have a global rate limit with wait time, don't retry
        if (errorData && errorData.waitSeconds && errorData.retryAfter) {
          window.litter?.logger?.warn("api", "Global rate limit hit", { retryAfter: errorData.retryAfter, message: errorData.message });
          stats.innerHTML = `
              <span>Size: ${window.litter.formatFileSize(file.size)}</span>
              <span style="color: #ff6b6b">Global rate limit: Try again in ${errorData.retryAfter}</span>
            `;
            showStatus(`${errorData.message || 'Rate limited. Please try again later.'}`);
            reject(new Error(errorData.message || 'Rate limited'));
      } else if (retryCount < MAX_RETRIES) {
          // Regular rate limit, retry with backoff
          retryCount++;
          const delay = Math.pow(2, retryCount) * 1000;
          window.litter?.logger?.warn("api", "Rate limited, retrying", { file: file.name, retryCount, delay: `${delay / 1000}s` });
            stats.innerHTML = `
              <span>Size: ${window.litter.formatFileSize(file.size)}</span>
              <span style="color: #ffa500">Rate limited. Retrying in ${
                delay / 1000
              }s... (${retryCount}/${MAX_RETRIES})</span>
            `;
            showStatus(`Server busy. Retrying ${file.name} in ${delay / 1000} seconds...`);
            setTimeout(() => {
              attempt(targetUrl).then(resolve).catch(reject);
            }, delay);
          } else {
            reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`));
          }
        } else {
          reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`));
        }
      });

    xhr.addEventListener("error", () => {
      clearAll();
      if (pauseBtn) pauseBtn.style.display = "none";
      const err = new Error(`Network error: ${xhr.statusText || "upload failed"}`);
      err.status = xhr.status;
      window.litter?.logger?.error("network", "XHR network error", { file: file.name, status: xhr.status });
      if (isNetworkFailure(err)) {
    isNetworkDown = true;
    showStatus("Network interrupted — waiting for connection...", false);
  }
  reject(err);
});

      xhr.addEventListener("abort", () => {
        clearAll();
        reject(new Error("aborted"));
      });

      xhr.send(formData);
    });
  };

  return attempt(url);
}

function addToUploadQueue(file, fileItem) {
  window.litter?.logger?.debug("upload", "Queued for upload", file.name);
  uploadQueue.push({ file, fileItem });
  startNextUpload();
}

function startNextUpload() {
  // Check if we can start another upload
  if (activeUploads >= MAX_CONCURRENT_UPLOADS || uploadQueue.length === 0) {
    return;
  }

  const { file, fileItem } = uploadQueue.shift();
  activeUploads++;

  uploadFile(file, fileItem).finally(() => {
    activeUploads--;
    // Wait for cooldown before starting next upload
    setTimeout(startNextUpload, COOLDOWN_MS);
  });
}

async function uploadFile(file, fileItem) {
  // E2EE: set passphrase on the file object for later use
  if (SettingsManager.settings.e2eeEnabled) {
    if (SettingsManager.settings.customPassphrase && SettingsManager.settings.customPassphraseValue) {
      const pw = SettingsManager.settings.customPassphraseValue;
      if (pw.length >= 9 && pw.length <= 24) {
        file._e2eePassphrase = pw;
      } else {
        showStatus("E2EE (beta) passphrase must be 9-24 characters", true);
        file._e2eePassphrase = E2EEManager.generatePassphrase();
      }
    } else {
      file._e2eePassphrase = E2EEManager.generatePassphrase();
    }
    file._e2eeEnabled = true;
    file._randomFilename = SettingsManager.settings.randomFilename || false;
    file._randomFilenameLength = SettingsManager.settings.randomFilenameLength || 12;
  }

  const CHUNK_THRESHOLD = 95 * 1024 * 1024; // 95MB

  if (file._e2eeEnabled && file.size > CHUNK_THRESHOLD && !file._e2eeUploadFile) {
    const stats = fileItem.querySelector(".file-stats");
    if (stats) {
      stats.innerHTML = `<span>Size: ${window.litter.formatFileSize(file.size)}</span><span>Status: Encrypting before chunked upload...</span>`;
    }
    const encrypted = await E2EEManager.encryptFile(file, file._e2eePassphrase, function(stage, pct) {
      if (!stats) return;
      if (stage === "reading") {
        stats.innerHTML = `<span>Size: ${window.litter.formatFileSize(file.size)}</span><span>Status: Reading file (${window.litter.formatFileSize(file.size)})...</span>`;
        return;
      }
      if (stage === "encrypting") {
        stats.innerHTML = `<span>Size: ${window.litter.formatFileSize(file.size)}</span><span>Status: Encrypting (PBKDF2 + AES-256-GCM)... ${pct}%</span>`;
      }
    });
    // Chunk the single LTR blob so the server's concatenated file remains decryptable.
    file._e2eeUploadFile = new File([encrypted.encryptedBlob], file.name, { type: "application/octet-stream" });
  }

  if ((file._e2eeUploadFile || file).size > CHUNK_THRESHOLD) {
    window.litter?.logger?.info("upload", "Large file, using chunked upload", { file: file.name, size: window.litter.formatFileSize(file.size) });
    try {
      showStatus(`Large file detected (${window.litter.formatFileSize(file.size)}). Using chunked upload...`);
      return await uploadFileChunked(file, fileItem);
    } catch (e) {
      window.litter?.logger?.warn("upload", "Chunked upload failed, falling back to standard", { file: file.name, error: e.message });
      // If network failure, wait for network before trying standard upload
      if (isNetworkFailure(e)) {
        showStatus("Network interrupted — waiting for connection...", false);
        await waitForNetwork();
        showStatus("Network restored — trying standard upload...", false);
      }
      try {
        showStatus("Chunked upload failed. Trying standard upload...");
        return await uploadStandard(file, fileItem, "/api/upload");
      } catch (e2) {
        const stats = fileItem.querySelector(".file-stats");
        if (stats) {
          stats.innerHTML = `
            <span>Size: ${window.litter.formatFileSize(file.size)}</span>
            <span style="color: #ff6b6b">Error: All upload methods failed</span>
          `;
        }
        showStatus(`Failed to upload ${file.name}`, true);
        return { error: true, message: "All upload methods failed" };
      }
    }
  } else {
    try {
      return await uploadStandard(file, fileItem, "/api/upload");
} catch (e) {
    // Detect network failures — wait and retry once before giving up
    if (isNetworkFailure(e)) {
      showStatus("Network interrupted — waiting for connection...", false);
      await waitForNetwork();
      showStatus("Network restored — retrying standard upload...", false);
      try {
        return await uploadStandard(file, fileItem, "/api/upload");
      } catch (e2) {
        e = e2; // Fall through with new error
      }
    }

    const stats = fileItem.querySelector(".file-stats");
    if (stats) {
      stats.innerHTML = `
        <span>Size: ${window.litter.formatFileSize(file.size)}</span>
        <span style="color: #ff6b6b">Error: ${e.message}</span>
        <button class="control-btn retry-btn" style="margin-left: 10px; background: #f44336; color: white; border: none; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer;">Retry</button>
      `;

      const retryBtn = stats.querySelector(".retry-btn");
      if (retryBtn) {
        retryBtn.addEventListener("click", () => {
          fileItem.classList.remove("failed");
          fileItem.style.opacity = "1";

          // reset UI
          const progressBar = fileItem.querySelector(".upload-progress-bar");
          const statusText = fileItem.querySelector(".status-text");
          if (progressBar) progressBar.style.width = "0%";
          if (statusText) statusText.textContent = "0%";

          stats.innerHTML = `
            <span>Size: ${window.litter.formatFileSize(file.size)}</span>
            <span>Status: Retrying...</span>
          `;

          // Add back to queue
          addToUploadQueue(file, fileItem);
        });
      }
    }
    showStatus(`Failed to upload ${file.name}`, true);
    return { error: true, message: e.message };
  }
}
}
async function uploadFileChunked(file, fileItem) {
  const stats = fileItem.querySelector(".file-stats");
  const statusText = fileItem.querySelector(".status-text");
  const progressBar = fileItem.querySelector(".upload-progress-bar");
  const pauseBtn = fileItem.querySelector(".pause-btn");

  let uploadId = null;
  let partsCount = 0;
  let serverChunkSize = CHUNK_SIZE;
  let highestChunkCompleted = -1;
  const uploadedChunks = new Set();
  const activeXhrs = new Set();
  const chunkBytesUploaded = new Map();
  let isPaused = false;
  let resumePromise = null;
  let resumeResolve = null;
  let uploadQueue_chunks = [];
  const uploadSource = file._e2eeUploadFile || file;

  return new Promise((resolve, reject) => {
    const finalizeUpload = async () => {
      window.litter?.logger?.info("upload", "Finalizing chunked upload", { file: file.name, chunks: uploadedChunks.size, partsCount });
      if (pauseBtn) pauseBtn.style.display = "none";
      if (statusText) statusText.textContent = "Processing...";
      if (stats) {
        stats.innerHTML = `<span>Size: ${window.litter.formatFileSize(file.size)}</span><span>Status: Finalizing...</span>`;
      }

      const completeResponse = await fetch(`/api/upload/chunk/${uploadId}/complete`, {
        method: "POST",
      });

      if (!completeResponse.ok) {
        const err = await completeResponse.json();
        
        // Check for global rate limit with wait time
        if (completeResponse.status === 429 && err.waitSeconds && err.retryAfter) {
          if (stats) {
            stats.innerHTML = `
              <span>Size: ${window.litter.formatFileSize(file.size)}</span>
              <span style="color: #ff6b6b">Global rate limit: Try again in ${err.retryAfter}</span>
            `;
          }
          showStatus(`${err.message || 'Rate limited. Please try again later.'}`);
          throw new Error(err.message || "Rate limited");
        }
        
        throw new Error(err.error || "Failed to complete chunked upload");
      }

const responseText = await completeResponse.text();
        let apiPath, fullUrl, deleteSecret = null;
        try {
            const data = JSON.parse(responseText);
            // Handle relative URL from server
            fullUrl = data.url;
            if (!data.url.startsWith('http')) {
                fullUrl = window.location.origin + data.url;
            }
            apiPath = new URL(fullUrl).pathname;
            deleteSecret = data.deleteSecret;
        } catch (e) {
            // Fallback for older plaintext response
            apiPath = responseText;
            fullUrl = `${window.location.origin}${apiPath}`;
        }

      handleUploadSuccess(file, fileItem, fullUrl, apiPath, deleteSecret);
      updateTotalSize();
      resolve(apiPath);
    };

    const uploadChunk = async (chunkIndex) => {
      const start = chunkIndex * serverChunkSize;
      const end = Math.min(start + serverChunkSize, uploadSource.size);
      const chunk = uploadSource.slice(start, end);

      const formData = new FormData();
      formData.append("file", chunk);

      return new Promise((resolveChunk, rejectChunk) => {
        const xhr = new XMLHttpRequest();
        activeXhrs.add(xhr);
        xhr._chunkIndex = chunkIndex;
        xhr.open("POST", `/api/upload/chunk/${uploadId}/${chunkIndex}`);

        const cleanup = { intervals: [], timeouts: [] };

        // Pass null for stats to avoid conflicting updates with setupXhrListeners
        setupXhrListeners(xhr, file, fileItem, null, cleanup, `${uploadId}-${chunkIndex}`);

		xhr.upload.addEventListener("progress", (e) => {
			if (e.lengthComputable) {
				// Track per-chunk bytes to prevent progress oscillation
				chunkBytesUploaded.set(chunkIndex, e.loaded);
				const completedBytes = uploadedChunks.size * serverChunkSize;
				let activeBytes = 0;
				for (const bytes of chunkBytesUploaded.values()) {
					activeBytes += bytes;
				}
				const totalBytesUploaded = completedBytes + activeBytes;
				const overallPercent = Math.round((totalBytesUploaded / uploadSource.size) * 80);

				if (progressBar) progressBar.style.width = `${overallPercent}%`;
				if (statusText) statusText.textContent = `${overallPercent}%`;

				// Calculate lowest active chunk
				const activeChunks = Array.from(activeXhrs)
					.map((x) => x._chunkIndex)
					.filter((i) => i !== undefined);
				const lowestChunk = activeChunks.length > 0 ? Math.min(...activeChunks) : chunkIndex;

				if (stats && chunkIndex === lowestChunk) {
					stats.innerHTML = `
					<span>Size: ${window.litter.formatFileSize(file.size)}</span>
					<span>Part: ${lowestChunk + 1}/${partsCount}</span>
					<span>Status: Uploading...</span>
				`;
				}
			}
		});

		xhr.onload = () => {
			activeXhrs.delete(xhr);
			cleanup.intervals.forEach(clearInterval);
			if (xhr.status === 200) {
				uploadedChunks.add(chunkIndex);
				chunkBytesUploaded.delete(chunkIndex);
				highestChunkCompleted = Math.max(highestChunkCompleted, chunkIndex);
            resolveChunk();
          } else {
            rejectChunk(new Error(`Part ${chunkIndex} failed: ${xhr.statusText}`));
          }
        };
xhr.onerror = () => {
  activeXhrs.delete(xhr);
  cleanup.intervals.forEach(clearInterval);
  const err = new Error(`Part ${chunkIndex} network error`);
  err.status = xhr.status;
  if (isNetworkFailure(err)) {
    isNetworkDown = true;
  }
  rejectChunk(err);
};
        xhr.onabort = () => {
          activeXhrs.delete(xhr);
          cleanup.intervals.forEach(clearInterval);
          rejectChunk(new Error("aborted"));
        };
        xhr.send(formData);
      });
    };

const retryUploadChunk = async (chunkIndex, maxRetries = 3) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await uploadChunk(chunkIndex);
    } catch (error) {
      if (error.message === "aborted") throw error;
      // Check if this is a network failure — wait for network before continuing retries
      if (isNetworkFailure(error)) {
        showStatus("Network interrupted — waiting for connection...", false);
        await waitForNetwork();
        showStatus("Network restored — continuing upload...", false);
        // Don't count this as a retry attempt — network errors don't consume retry budget
        continue;
      }
      if (attempt === maxRetries) throw error;
      const delay = Math.pow(2, attempt) * 1000;
      window.litter?.logger?.warn("upload", `Part ${chunkIndex} failed, retrying`, { delay: `${delay}ms`, attempt });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
};

    const uploadWorker = async () => {
      while (uploadQueue_chunks.length > 0) {
        if (isPaused) {
          if (!resumePromise) {
            resumePromise = new Promise((res) => {
              resumeResolve = res;
            });
          }
          await resumePromise;
        }

        const chunkIndex = uploadQueue_chunks.shift();
        if (chunkIndex === undefined) break;

        try {
          await retryUploadChunk(chunkIndex);
        } catch (err) {
          if (err.message === "aborted") {
            uploadQueue_chunks.unshift(chunkIndex);
            return;
          }
          throw err;
        }
      }
    };

    const startChunkUploadLoop = async () => {
      const workers = [];
      const numWorkers = Math.min(MAX_CONCURRENT_CHUNKS, partsCount);

      for (let i = 0; i < numWorkers; i++) {
        workers.push(uploadWorker());
      }
      await Promise.all(workers);

      if (!isPaused && uploadedChunks.size === partsCount) {
        await finalizeUpload();
      }
    };

    const run = async () => {
      let initRetries = 0;
      const MAX_INIT_RETRIES = 3;

      while (!uploadId && initRetries < MAX_INIT_RETRIES) {
        try {
			if (stats && !file._e2eeEnabled) {
					stats.innerHTML = `<span>Size: ${window.litter.formatFileSize(file.size)}</span><span>Status: Calculating hash...</span>`;
				}
				// E2EE files skip client-side hash: server hashes the encrypted data on assembly
				const fileHash = file._e2eeEnabled ? null : await calculateFileHash(file);

          showStatus(
            `Initializing upload for ${file.name}...${initRetries > 0 ? ` (Retry ${initRetries}/${MAX_INIT_RETRIES})` : ""}`,
          );
          if (stats) {
            stats.innerHTML = `<span>Size: ${window.litter.formatFileSize(file.size)}</span><span>Status: Initializing...</span>`;
          }

        const initResponse = await fetch("/api/upload/chunk/init", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(file._e2eeEnabled ? { "X-E2EE": "true" } : {}),
            ...(file._e2eeEnabled && file._randomFilename ? { "X-Random-Filename": String(file._randomFilenameLength || 12) } : {}),
          },
          body: JSON.stringify({
              filename: uploadSource.name,
              fileSize: uploadSource.size,
              mimeType: uploadSource.type || file.type,
              totalChunks: Math.ceil(uploadSource.size / CHUNK_SIZE),
              fileHash: fileHash,
            }),
          });

          if (!initResponse.ok) {
            const err = await initResponse.json();
            throw new Error(err.error || "Failed to initialize upload");
          }

        const initData = await initResponse.json();
        if (initData.fileExists) {
          if (pauseBtn) pauseBtn.style.display = "none";
          const fullUrl = `${window.location.origin}${initData.url}`;
          if (initData.alreadyExisted) {
            showStatus(`${file.name} already uploaded`);
          } else {
            showStatus(`Linked to existing file as ${file.name}`);
          }
          handleUploadSuccess(file, fileItem, fullUrl, initData.url, initData.deleteSecret);
          return resolve(initData.url);
        }


    uploadId = initData.uploadId;
    partsCount = initData.partsCount;
    serverChunkSize = initData.chunkSize;
    uploadQueue_chunks = Array.from({ length: partsCount }, (_, i) => i);
    window.litter?.logger?.info("upload", "Chunked upload initialized", { file: file.name, uploadId, partsCount, chunkSize: window.litter.formatFileSize(serverChunkSize) });
        } catch (err) {
          initRetries++;
      if (initRetries >= MAX_INIT_RETRIES) {
        window.litter?.logger?.error("upload", "Upload init failed after max retries", { file: file.name, retries: initRetries, error: err.message });
            if (pauseBtn) pauseBtn.style.display = "none";

            if (stats) {
              stats.innerHTML = `
                <span>Size: ${window.litter.formatFileSize(file.size)}</span>
                <span style="color: #ff6b6b">Error: Initialization failed after ${MAX_INIT_RETRIES} attempts</span>
              `;
            }
            showStatus(`Failed to initialize upload for ${file.name}`, true);
            fileItem.classList.add("failed");

            return reject(err);
          }
          // Delay before retry
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, initRetries)));
        }
      }

      if (uploadId) {
        try {
          await startChunkUploadLoop();
      } catch (err) {
        window.litter?.logger?.error("upload", "Chunk upload loop failed", { file: file.name, error: err.message });
          if (pauseBtn) pauseBtn.style.display = "none";
          
          if (stats) {
            stats.innerHTML = `
              <span>Size: ${window.litter.formatFileSize(file.size)}</span>
              <span style="color: #ff6b6b">Error: ${err.message}</span>
              <button class="control-btn retry-btn" style="margin-left: 10px; background: #f44336; color: white; border: none; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer;">Retry</button>
            `;
            
            const retryBtn = stats.querySelector(".retry-btn");
            if (retryBtn) {
              retryBtn.addEventListener("click", () => {
                fileItem.classList.remove("failed");
                fileItem.style.opacity = "1";
                
                // reset UI
                const progressBar = fileItem.querySelector(".upload-progress-bar");
                const statusText = fileItem.querySelector(".status-text");
                if (progressBar) progressBar.style.width = "0%";
                if (statusText) statusText.textContent = "0%";
                
                stats.innerHTML = `
                  <span>Size: ${window.litter.formatFileSize(file.size)}</span>
                  <span>Status: Retrying...</span>
                `;
                
                // Add back to queue
                addToUploadQueue(file, fileItem);
              });
            }
          }
          reject(err);
        }
      }
    };

    if (pauseBtn) {
      pauseBtn.style.display = "block";
      pauseBtn.onclick = () => {
        if (!isPaused) {
          isPaused = true;
          pauseBtn.innerHTML = "Resume";
 pauseBtn.setAttribute("aria-label", "Resume upload");
          activeXhrs.forEach((xhr) => xhr.abort());
          activeXhrs.clear();
          if (stats) {
            const currentStats = stats.innerHTML;
            stats.innerHTML = currentStats.replace("Uploading...", "Paused");
          }
        } else {
 isPaused = false;
 pauseBtn.innerHTML = "Pause";
 pauseBtn.setAttribute("aria-label", "Pause upload");
          if (statusText) statusText.textContent = "Resuming...";
          resumePromise = null;
          if (resumeResolve) resumeResolve();
        }
      };
    }

    run();
  });
}

async function updateTotalSize() {
  // fetch actual storage size from database
  const footerSize = document.getElementById("totalSizeFooter");

  try {
    const response = await fetch("/api/size");
    const data = await response.json();
    const formattedSize = window.litter.formatFileSize(data.totalSize);

    if (footerSize) {
      footerSize.setAttribute("data-storage", formattedSize);
      // only update text directly if no active uploads (to avoid flickering with speed display)
      if (uploadSpeeds.size === 0) {
        footerSize.textContent = formattedSize;
      }
    }
    } catch (error) {
      window.litter?.logger?.error("api", "Failed to fetch storage size", error);
    if (footerSize) footerSize.textContent = "error";
  }
}

// Wayback Machine archiving function removed

// gif to webp notification system
// notification system removed per user request

function initNotificationSystem() {}

function showNotification() {}

function dismissNotification() {}

function showGif2WebpDetails() {}

// Archive Manager - handles all archive provider requests
const ArchiveManager = {
  providers: {
    wayback: {
      name: "Internet Archive",
      async archive(targetUrl, publicId, onStateChange) {
        const viewUrl = `https://web.archive.org/web/${encodeURIComponent(targetUrl)}`;
        const saveUrl = `https://web.archive.org/save/${encodeURIComponent(targetUrl)}`;

        onStateChange("saving");
        try {
          // Try save API first
          const response = await fetch(saveUrl, { method: "GET", mode: "no-cors" });
          // Due to no-cors, we can't read response, so open view URL
          window.open(viewUrl, "_blank");
          onStateChange("saved");
          return { ok: true, provider: "wayback", savedUrl: viewUrl, viewUrl };
        } catch (err) {
          // Fallback: open save page directly
          window.open(saveUrl, "_blank");
          onStateChange("saved");
          return { ok: true, provider: "wayback", savedUrl: viewUrl, viewUrl, fallbackOpened: true };
        }
      },
      getSavedUrl(targetUrl) {
        return `https://web.archive.org/web/${encodeURIComponent(targetUrl)}`;
      }
    },
    archiveToday: {
      name: "archive.today",
      async archive(targetUrl, publicId, onStateChange) {
        const submitUrl = `https://archive.is/submit/?url=${encodeURIComponent(targetUrl)}`;
        onStateChange("saving");
        window.open(submitUrl, "_blank");
        onStateChange("saved");
        return { ok: true, provider: "archiveToday", submitUrl };
      }
    },
    kiroku: {
      name: "Kiroku",
      async archive(targetUrl, publicId, onStateChange) {
        onStateChange("saving");
        try {
          const response = await fetch("https://kiroku.today/api/archive", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: targetUrl, is_private: false })
          });
          const data = await response.json();
          if (data.hash) {
            const savedUrl = `https://kiroku.today/en/a/${data.hash}`;
            window.open(savedUrl, "_blank");
            onStateChange("saved");
            return { ok: true, provider: "kiroku", savedUrl, hash: data.hash };
          }
          throw new Error(data.error || "No hash returned");
        } catch (err) {
          onStateChange("failed");
          return { ok: false, provider: "kiroku", error: err.message };
        }
      }
    },
    ghost: {
      name: "Ghost Archive",
      async archive(targetUrl, publicId, onStateChange) {
        onStateChange("saving");
        const requestUrl = "https://ghostarchive.org/archive2";
        try {
          const formData = new FormData();
          formData.append("archive", targetUrl);
          const response = await fetch(requestUrl, {
            method: "POST",
            body: formData,
            redirect: "follow"
          });
          // Ghost Archive returns 302 redirect, try to get final URL
          const savedUrl = response.url || `https://ghostarchive.org/archives/${encodeURIComponent(targetUrl)}`;
          window.open(savedUrl, "_blank");
          onStateChange("saved");
          return { ok: true, provider: "ghost", savedUrl };
        } catch (err) {
          // Fallback: open request URL
          window.open(`https://ghostarchive.org/archives/${encodeURIComponent(targetUrl)}`, "_blank");
          onStateChange("saved");
          return { ok: true, provider: "ghost", fallbackOpened: true };
        }
      }
    },
    megalodon: {
      name: "Megalodon",
      async archive(targetUrl, publicId, onStateChange) {
        const submitUrl = `https://megalodon.jp/?url=${encodeURIComponent(targetUrl)}`;
        onStateChange("saving");
        window.open(submitUrl, "_blank");
        onStateChange("saved");
        return { ok: true, provider: "megalodon", submitUrl };
      }
    }
  },

  async archiveWith(providerKey, targetUrl, publicId, onStateChange) {
    const provider = this.providers[providerKey];
    if (!provider) return { ok: false, error: "Unknown provider" };
    return provider.archive(targetUrl, publicId, onStateChange);
  },

  getProviderNames() {
    return Object.keys(this.providers);
  }
};

function parseCanonicalFileIdentityFromLink(link) {
  if (!link || typeof link !== "string") return null;

  let url;
  try {
    url = new URL(link, window.location.origin);
  } catch (err) {
    return null;
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts.length < 3 || pathParts[0] !== "files") return null;

  const publicId = pathParts[1];
  const encodedFilename = pathParts.slice(2).join("/");
  if (!publicId || !encodedFilename) return null;

  let filename;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch (err) {
    filename = encodedFilename;
  }

  return { publicId, filename };
}

// Upload History Manager
const UploadHistoryManager = {
  MAX_ITEMS: 650,
  VISIBLE_ITEMS: 60,
  selectedItems: new Set(),

  getHistory() {
    const storage = SettingsManager.settings.sessionOnlyHistory ? sessionStorage : localStorage;
    const data = storage.getItem("uploadHistory");
    if (!data) return [];

    let history;
    try {
      history = JSON.parse(data);
    } catch (err) {
      return [];
    }

    if (!Array.isArray(history)) return [];

    let needsSave = false;
    for (const item of history) {
      if (!item.link) continue;

      const parsed = parseCanonicalFileIdentityFromLink(item.link);
      if (!parsed) continue;

      const publicIdMismatch = item.publicId !== parsed.publicId;
      const filenameMismatch = item.filename !== parsed.filename;

      if (publicIdMismatch || filenameMismatch) {
        item.publicId = parsed.publicId;
        item.filename = parsed.filename;
        needsSave = true;
      }
    }

    if (needsSave) {
      storage.setItem("uploadHistory", JSON.stringify(history));
    }

    return history;
  },

  saveHistory(history) {
    // Limit to MAX_ITEMS
    while (history.length > this.MAX_ITEMS) {
      history.pop(); // Remove oldest
    }

    if (SettingsManager.settings.sessionOnlyHistory) {
      sessionStorage.setItem("uploadHistory", JSON.stringify(history));
    } else {
      localStorage.setItem("uploadHistory", JSON.stringify(history));
    }
    this.updateBadge();
  },

  addItem(item) {
    const history = this.getHistory();
    history.unshift(item); // Add to beginning
    this.saveHistory(history);
  },

  updateItem(publicId, updater) {
    const history = this.getHistory();
    const index = history.findIndex(item => item.publicId === publicId);
    if (index === -1) return false;
    history[index] = { ...history[index], ...updater(history[index]) };
    this.saveHistory(history);
    return true;
  },

  setArchiveState(publicId, provider, partialState) {
    return this.updateItem(publicId, (item) => {
      const archives = item.archives || {};
      return {
        archives: {
          ...archives,
          [provider]: {
            ...(archives[provider] || {}),
            ...partialState,
            lastAttemptAt: new Date().toISOString()
          }
        }
      };
    });
  },

  getArchiveState(publicId, provider) {
    const history = this.getHistory();
    const item = history.find(i => i.publicId === publicId);
    if (!item || !item.archives) return null;
    return item.archives[provider] || null;
  },

  removeItem(publicId) {
    const history = this.getHistory().filter(item => item.publicId !== publicId);
    this.saveHistory(history);
  },

  removeItems(publicIds) {
    const idSet = new Set(publicIds);
    const history = this.getHistory().filter(item => !idSet.has(item.publicId));
    this.saveHistory(history);
  },

  clear() {
    if (SettingsManager.settings.sessionOnlyHistory) {
      sessionStorage.removeItem("uploadHistory");
    } else {
      localStorage.removeItem("uploadHistory");
    }
    this.updateBadge();
  },

  updateBadge() {
    // Badge removed per user request
  },

  getFileTypeIcon(mimeType) {
    if (mimeType.startsWith("image/")) return "🖼️";
    if (mimeType.startsWith("video/")) return "🎬";
    if (mimeType.startsWith("audio/")) return "🎵";
    if (mimeType.includes("pdf")) return "📄";
    if (mimeType.includes("word") || mimeType.includes("document")) return "📝";
    if (mimeType.includes("excel") || mimeType.includes("spreadsheet")) return "📊";
    if (mimeType.includes("zip") || mimeType.includes("archive") || mimeType.includes("rar")) return "📦";
    return "📁";
  },

  formatRelativeTime(date) {
    const now = new Date();
    const diff = now - new Date(date);
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return "just now";
  },

  getArchiveStatusBadge(archives, provider) {
    if (!archives || !archives[provider]) return "";
    const state = archives[provider];
    if (state.status === "saving") return `<span class="archive-status saving">saving...</span>`;
    if (state.status === "saved" && state.savedUrl) return `<a href="${state.savedUrl}" target="_blank" class="archive-status saved">view</a>`;
    if (state.status === "failed") return `<span class="archive-status failed" title="${state.error || "failed"}">failed</span>`;
    return "";
  },

  renderDrawer(search = "", sortBy = "date-desc", filterType = "all") {
    const container = document.getElementById("historyList");
    if (!container) return;

    let history = this.getHistory();

    // Filter by search
    if (search) {
      const searchLower = search.toLowerCase();
      history = history.filter(item => item.filename.toLowerCase().includes(searchLower));
    }

    // Filter by type
    if (filterType !== "all") {
      history = history.filter(item => {
        const type = item.type || "";
        switch (filterType) {
          case "image": return type.startsWith("image/");
          case "video": return type.startsWith("video/");
          case "audio": return type.startsWith("audio/");
          case "document": return type.includes("pdf") || type.includes("word") || type.includes("document");
          case "archive": return type.includes("zip") || type.includes("archive") || type.includes("rar");
          default: return true;
        }
      });
    }

    // Sort
    history.sort((a, b) => {
      switch (sortBy) {
        case "date-asc": return new Date(a.uploadDate) - new Date(b.uploadDate);
        case "date-desc": return new Date(b.uploadDate) - new Date(a.uploadDate);
        case "size-asc": return a.filesize - b.filesize;
        case "size-desc": return b.filesize - a.filesize;
        case "name-asc": return a.filename.localeCompare(b.filename);
        case "name-desc": return b.filename.localeCompare(a.filename);
        default: return 0;
      }
    });

    if (history.length === 0) {
      container.innerHTML = '<div class="history-empty">no upload history yet</div>';
      this.updateBulkActionBar();
      return;
    }

    // Virtual scrolling - only render first VISIBLE_ITEMS
    const visible = history.slice(0, this.VISIBLE_ITEMS);

    container.innerHTML = visible.map(item => {
      const isImage = item.type?.startsWith("image/");
      const preview = isImage
        ? `<div class="history-preview"><img src="${item.link}" alt="${item.filename}" onerror="this.parentElement.innerHTML='${this.getFileTypeIcon(item.type)}'"></div>`
        : `<div class="history-preview">${this.getFileTypeIcon(item.type)}</div>`;

      // Archive links display
      const archiveLinks = this.renderArchiveLinks(item);

      const isSelected = this.selectedItems.has(item.publicId);

      return `
<div class="history-item${isSelected ? " selected" : ""}" data-public-id="${item.publicId}">
  <input type="checkbox" class="history-checkbox" data-public-id="${item.publicId}"${isSelected ? " checked" : ""}>
  ${preview}
  <div class="history-info">
    <div class="history-name" title="${item.filename}">${item.filename}</div>
    <div class="history-meta">${window.litter.formatFileSize(item.filesize)} • ${this.formatRelativeTime(item.uploadDate)}</div>
    ${archiveLinks}
  </div>
  <div class="history-actions">
    <button class="copy-link-btn" data-link="${item.link}">copy</button>
    <button class="archive-dropdown-btn" data-public-id="${item.publicId}" data-link="${item.link}">archive</button>
    <button class="delete-btn" data-public-id="${item.publicId}" data-secret="${item.deleteSecret || ''}" data-filename="${item.filename}">delete</button>
  </div>
</div>
`;
    }).join("");

    // Add event listeners
    container.querySelectorAll(".copy-link-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const link = e.target.dataset.link;
        try {
          await navigator.clipboard.writeText(link);
          showStatus("Link copied to clipboard!");
        } catch (err) {
          showStatus("Failed to copy link");
        }
      });
    });

container.querySelectorAll(".delete-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                const publicId = e.target.dataset.publicId;
                const secret = e.target.dataset.secret;
                const filename = e.target.dataset.filename;
                this.showDeleteConfirm(publicId, filename, secret);
            });
        });

    container.querySelectorAll(".archive-dropdown-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const rect = e.target.getBoundingClientRect();
        const publicId = e.target.dataset.publicId;
        const link = e.target.dataset.link;
        this.showArchiveDropdown(publicId, link, rect);
      });
    });

    container.querySelectorAll(".history-checkbox").forEach(cb => {
      cb.addEventListener("change", (e) => {
        const publicId = e.target.dataset.publicId;
        if (e.target.checked) {
          this.selectedItems.add(publicId);
        } else {
          this.selectedItems.delete(publicId);
        }
        e.target.closest(".history-item").classList.toggle("selected", e.target.checked);
        this.updateBulkActionBar();
      });
    });

    this.updateBulkActionBar();
  },

  renderArchiveLinks(item) {
    if (!item.archives) return "";
    const links = [];
    const providerLabels = { wayback: "IA", archiveToday: "AT", kiroku: "KI", ghost: "GH", megalodon: "ME" };
    for (const [provider, state] of Object.entries(item.archives)) {
      if (state.status === "saved" && state.savedUrl) {
        links.push(`<a href="${state.savedUrl}" target="_blank" class="archive-link" title="${ArchiveManager.providers[provider]?.name || provider}">${providerLabels[provider] || provider}</a>`);
      }
    }
    return links.length > 0 ? `<div class="archive-links">${links.join("")}</div>` : "";
  },

  showArchiveDropdown(publicId, targetUrl, anchorRect) {
    // Remove existing dropdown
    const existing = document.querySelector(".archive-dropdown-menu");
    if (existing) existing.remove();

    const dropdown = document.createElement("div");
    dropdown.className = "archive-dropdown-menu";

    const providerLabels = {
      wayback: "Internet Archive",
      archiveToday: "archive.today",
      kiroku: "Kiroku",
      ghost: "Ghost Archive",
      megalodon: "Megalodon"
    };

    dropdown.innerHTML = ArchiveManager.getProviderNames().map(provider => {
      const state = this.getArchiveState(publicId, provider);
      let statusClass = "";
      let statusText = "";
      if (state) {
        if (state.status === "saving") { statusClass = "saving"; statusText = " (saving...)"; }
        else if (state.status === "saved") { statusClass = "saved"; statusText = " (saved)"; }
        else if (state.status === "failed") { statusClass = "failed"; statusText = " (retry)"; }
      }
      return `<button class="archive-provider-btn ${statusClass}" data-provider="${provider}" data-url="${targetUrl}" data-public-id="${publicId}">
        ${providerLabels[provider]}${statusText}
      </button>`;
    }).join("");

    // Position dropdown
    dropdown.style.top = `${anchorRect.bottom + 4}px`;
    dropdown.style.right = `${window.innerWidth - anchorRect.right}px`;

    document.body.appendChild(dropdown);

    // Handle clicks
    dropdown.querySelectorAll(".archive-provider-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const provider = e.target.dataset.provider;
        const url = e.target.dataset.url;
        const pid = e.target.dataset.publicId;

        // Add progress border for Kiroku
        if (provider === "kiroku") {
          btn.classList.add("progress-border");
        }

        const result = await ArchiveManager.archiveWith(provider, url, pid, (status) => {
          this.setArchiveState(pid, provider, { status });
          this.renderDrawer();
        });

        if (provider === "kiroku") {
          btn.classList.remove("progress-border");
        }

        if (result.ok) {
          if (result.savedUrl) {
            this.setArchiveState(pid, provider, { status: "saved", savedUrl: result.savedUrl });
          } else {
            this.setArchiveState(pid, provider, { status: "saved" });
          }
          showStatus(`Archived with ${providerLabels[provider]}`);
        } else {
          this.setArchiveState(pid, provider, { status: "failed", error: result.error });
          showStatus(`Archive failed: ${result.error}`, true);
        }
        this.renderDrawer();
        dropdown.remove();
      });
    });

    // Close on click outside
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target)) {
        dropdown.remove();
        document.removeEventListener("click", closeHandler);
      }
    };
    setTimeout(() => document.addEventListener("click", closeHandler), 0);
  },

  updateBulkActionBar() {
    let actionBar = document.getElementById("bulkActionBar");
    const drawerControls = document.querySelector(".drawer-controls");

    if (this.selectedItems.size === 0) {
      if (actionBar) actionBar.remove();
      return;
    }

    if (!actionBar) {
      actionBar = document.createElement("div");
      actionBar.id = "bulkActionBar";
      actionBar.className = "bulk-action-bar";
      drawerControls?.appendChild(actionBar);
    }

    actionBar.innerHTML = `
      <span class="bulk-count">${this.selectedItems.size} selected</span>
      <button class="button bulk-btn" id="bulkLocalDelete">remove local</button>
      <button class="button button-danger bulk-btn" id="bulkServerDelete">delete server</button>
      <button class="button bulk-btn" id="bulkClear">clear selection</button>
    `;

    document.getElementById("bulkLocalDelete")?.addEventListener("click", () => this.showBulkLocalDeleteConfirm());
    document.getElementById("bulkServerDelete")?.addEventListener("click", () => this.showBulkServerDeleteConfirm());
    document.getElementById("bulkClear")?.addEventListener("click", () => {
      this.selectedItems.clear();
      this.renderDrawer();
    });
  },

  showBulkLocalDeleteConfirm() {
    const count = this.selectedItems.size;
    if (count === 0) return;

    this.showConfirmModal(
      "Remove from History",
      `Remove ${count} item${count > 1 ? "s" : ""} from local history? Files will remain on the server.`,
      () => {
        this.removeItems(Array.from(this.selectedItems));
        this.selectedItems.clear();
        this.renderDrawer();
        showStatus(`Removed ${count} item${count > 1 ? "s" : ""} from history`);
      }
    );
  },

  showBulkServerDeleteConfirm() {
    const count = this.selectedItems.size;
    if (count === 0) return;

    this.showConfirmModal(
      "Delete from Server",
      `Permanently delete ${count} file${count > 1 ? "s" : ""} from the server? This cannot be undone.`,
      async () => {
        const history = this.getHistory();
        const selectedItems = history.filter(item => this.selectedItems.has(item.publicId));

        let successCount = 0;
        let failedCount = 0;
        let skippedCount = 0;

        for (const item of selectedItems) {
          if (!item.deleteSecret) {
            skippedCount++;
            continue;
          }

          let resolvedPublicId = item.publicId;
          let resolvedFilename = item.filename;

          if (item.link) {
            const parsed = parseCanonicalFileIdentityFromLink(item.link);
            if (parsed) {
              resolvedPublicId = parsed.publicId;
              resolvedFilename = parsed.filename;
            }
          }

          const doDelete = async (pubId, fname, isRetry = false) => {
            const response = await fetch(`/files/${pubId}/${encodeURIComponent(fname)}`, {
              method: "DELETE",
              headers: {
                "X-Delete-Secret": item.deleteSecret,
              },
            });

            if (response.ok) {
              return { ok: true };
            }

            if (response.status === 404 && !isRetry && item.link) {
              const parsed = parseCanonicalFileIdentityFromLink(item.link);
              if (parsed && (parsed.publicId !== pubId || parsed.filename !== fname)) {
                return { ok: false, shouldRetry: true };
              }
            }

            return { ok: false };
          };

          try {
            let result = await doDelete(resolvedPublicId, resolvedFilename, false);

            if (!result.ok && result.shouldRetry) {
              const parsed = parseCanonicalFileIdentityFromLink(item.link);
              if (parsed) {
                result = await doDelete(parsed.publicId, parsed.filename, true);
              }
            }

            if (result.ok) {
              this.removeItem(item.publicId);
              this.selectedItems.delete(item.publicId);
              successCount++;
            } else {
              failedCount++;
            }
          } catch (err) {
            failedCount++;
          }
        }

        this.renderDrawer();

        const messages = [];
        if (successCount > 0) messages.push(`${successCount} deleted`);
        if (failedCount > 0) messages.push(`${failedCount} failed`);
        if (skippedCount > 0) messages.push(`${skippedCount} skipped (no delete link)`);
        showStatus(messages.join(", "));
      }
    );
  },

  showConfirmModal(title, message, onConfirm) {
    const modal = document.getElementById("deleteConfirmModal");
    if (!modal) return;

    const titleEl = modal.querySelector("h2");
    const msgEl = modal.querySelector("p");
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;

    const confirmBtn = document.getElementById("confirmDeleteBtn");
    const cancelBtn = document.getElementById("cancelDeleteBtn");

    const cleanup = () => {
      modal.classList.remove("show");
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
    };

    cancelBtn.onclick = cleanup;
    confirmBtn.onclick = () => {
      cleanup();
      onConfirm();
    };

    modal.classList.add("show");
  },

  showDeleteConfirm(publicId, filename, secret) {
    const modal = document.getElementById("deleteConfirmModal");
    if (!modal) return;

    const confirmBtn = document.getElementById("confirmDeleteBtn");
    const cancelBtn = document.getElementById("cancelDeleteBtn");

    // Reset modal text
    const titleEl = modal.querySelector("h2");
    const msgEl = modal.querySelector("p");
    if (titleEl) titleEl.textContent = "delete file?";
    if (msgEl) msgEl.textContent = "are you sure you want to delete this file? this action cannot be undone.";

    function cleanup() {
      modal.classList.remove("show");
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
    }

    cancelBtn.onclick = cleanup;

    confirmBtn.onclick = async () => {
      if (!secret) {
        this.removeItem(publicId);
        this.renderDrawer();
        cleanup();
        showStatus("Removed from history");
        return;
      }

      const history = this.getHistory();
      const historyItem = history.find(h => h.publicId === publicId);

      let resolvedPublicId = publicId;
      let resolvedFilename = filename;

      if (historyItem?.link) {
        const parsed = parseCanonicalFileIdentityFromLink(historyItem.link);
        if (parsed) {
          resolvedPublicId = parsed.publicId;
          resolvedFilename = parsed.filename;
        }
      }

      let attemptedPublicId = resolvedPublicId;
      let attemptedFilename = resolvedFilename;

      const doDelete = async (pubId, fname, isRetry = false) => {
          const response = await fetch(`/files/${pubId}/${encodeURIComponent(fname)}`, {
            method: "DELETE",
            headers: {
              "X-Delete-Secret": secret,
            },
          });

        const data = await response.json();

        if (response.ok) {
          return { ok: true };
        }

        if (response.status === 404 && !isRetry && historyItem?.link) {
          const parsed = parseCanonicalFileIdentityFromLink(historyItem.link);
          if (parsed && (parsed.publicId !== pubId || parsed.filename !== fname)) {
            return { ok: false, shouldRetry: true };
          }
        }

        return { ok: false, message: data.message || "Failed to delete file" };
      };

      try {
        let result = await doDelete(attemptedPublicId, attemptedFilename, false);

        if (!result.ok && result.shouldRetry) {
          const parsed = parseCanonicalFileIdentityFromLink(historyItem.link);
          if (parsed) {
            result = await doDelete(parsed.publicId, parsed.filename, true);
          }
        }

        if (result.ok) {
          this.removeItem(publicId);
          this.renderDrawer();
          cleanup();
          showStatus("File deleted successfully");
        } else {
          showStatus(result.message || "Failed to delete file");
        }
      } catch (err) {
        showStatus("Delete failed: " + err.message);
      }
    };

    modal.classList.add("show");
  },

  openDrawer() {
    const drawer = document.getElementById("historyDrawer");
    const overlay = document.getElementById("historyDrawerOverlay");
    if (drawer && overlay) {
      drawer.classList.add("active");
      overlay.classList.add("active");
      document.body.style.overflow = "hidden";
      this.renderDrawer();
    }
  },

  closeDrawer() {
    const drawer = document.getElementById("historyDrawer");
    const overlay = document.getElementById("historyDrawerOverlay");
    if (drawer && overlay) {
      drawer.classList.remove("active");
      overlay.classList.remove("active");
      document.body.style.overflow = "";
    }
  },
};

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove("show");
  }
}

// handle url fragments for direct access to modals
function handleUrlFragments() {
  const hash = window.location.hash.substring(1);

  switch (hash) {
    case "privacy":
      const privacyModal = document.getElementById("privacyModal");
      if (privacyModal) privacyModal.classList.add("show");
      break;
    case "tos":
      const termsModal = document.getElementById("termsModal");
      if (termsModal) termsModal.classList.add("show");
      break;
  }
}

// listen for hash changes
window.addEventListener("hashchange", handleUrlFragments);

// Setup History Drawer
function setupHistoryDrawer() {
  const historyBtn = document.getElementById("historyBtn");
  const closeBtn = document.getElementById("closeHistoryDrawer");
  const overlay = document.getElementById("historyDrawerOverlay");
  const searchInput = document.getElementById("historySearch");
  const sortSelect = document.getElementById("historySort");
  const filterSelect = document.getElementById("historyFilter");
  
  if (historyBtn) {
    historyBtn.addEventListener("click", () => UploadHistoryManager.openDrawer());
  }
  
  if (closeBtn) {
    closeBtn.addEventListener("click", () => UploadHistoryManager.closeDrawer());
  }
  
  if (overlay) {
    overlay.addEventListener("click", () => UploadHistoryManager.closeDrawer());
  }
  
  // Search, sort, filter
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      const search = e.target.value;
      const sort = document.getElementById("historySort")?.value || "date-desc";
      const filter = document.getElementById("historyFilter")?.value || "all";
      UploadHistoryManager.renderDrawer(search, sort, filter);
    });
  }
  
  if (sortSelect) {
    sortSelect.addEventListener("change", (e) => {
      const search = document.getElementById("historySearch")?.value || "";
      const filter = document.getElementById("historyFilter")?.value || "all";
      UploadHistoryManager.renderDrawer(search, e.target.value, filter);
    });
  }
  
  if (filterSelect) {
    filterSelect.addEventListener("change", (e) => {
      const search = document.getElementById("historySearch")?.value || "";
      const sort = document.getElementById("historySort")?.value || "date-desc";
      UploadHistoryManager.renderDrawer(search, sort, e.target.value);
    });
  }
  
  // Close on escape
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      UploadHistoryManager.closeDrawer();
    }
    if (e.key === "h" && e.ctrlKey) {
      e.preventDefault();
      UploadHistoryManager.openDrawer();
    }
  });
}

// Auto-open file picker
function openFilePickerWithBlur() {
	const fileInput = document.getElementById("fileInput");
	if (!fileInput) return;

	// Trigger file picker
	fileInput.click();
}

// Handle upload success - save to history
function saveToHistory(publicId, filename, filesize, link, deleteSecret, type) {
  UploadHistoryManager.addItem({
    publicId,
    filename,
    filesize,
    uploadDate: new Date().toISOString(),
    link,
    deleteSecret,
    type,
    archives: {},
  });
}

async function calculateFileHash(file) {
  // Optimization: Only hash files <= 500MB
  if (file.size > 500 * 1024 * 1024) {
    window.litter?.logger?.debug("upload", "File too large for client-side hashing, skipping", file.name, window.litter.formatFileSize(file.size));
    return null;
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    return hashHex;
  } catch (e) {
    window.litter?.logger?.error("upload", "Hash calculation failed", e);
    return null;
  }
}

function setupXhrListeners(xhr, file, fileItem, stats, cleanup, uploadId) {
  const statusText = fileItem.querySelector(".status-text");
  const progressBar = fileItem.querySelector(".upload-progress-bar");
  const fallbackStats = fileItem.querySelector(".file-stats");
  const statsElement = stats || fallbackStats;

  let lastLoaded = 0;
  let lastTime = Date.now();
  let uploadSpeed = 0;
  const SMOOTHING_FACTOR = 0.1;

  const speedUpdateInterval = setInterval(() => {
    const currentTime = Date.now();
    const timeElapsed = (currentTime - lastTime) / 1000;

    if (timeElapsed > 0) {
      const currentLoaded = xhr.upload ? xhr.upload.loaded || 0 : 0;
      const loadedSinceLast = currentLoaded - lastLoaded;

      if (loadedSinceLast > 0) {
        const instantSpeed = (loadedSinceLast * 8) / (timeElapsed * 1000000); // mbps
        if (uploadSpeed === 0) {
          uploadSpeed = instantSpeed;
        } else {
          uploadSpeed = instantSpeed * SMOOTHING_FACTOR + uploadSpeed * (1 - SMOOTHING_FACTOR);
        }
        // Update global tracker
        uploadSpeeds.set(uploadId || xhr, uploadSpeed);
        startGlobalSpeedTracker();
      } else {
        uploadSpeeds.set(uploadId || xhr, 0);
      }
      lastLoaded = currentLoaded;
      lastTime = currentTime;
    }
  }, 500);

  cleanup.intervals.push(speedUpdateInterval);

  xhr.upload.addEventListener("progress", (e) => {
    if (e.lengthComputable && statsElement && stats) {
      const uploadedSize = window.litter.formatFileSize(e.loaded);
      const totalSize = window.litter.formatFileSize(e.total);
      const speedText = uploadSpeed > 0 ? `${uploadSpeed.toFixed(2)} Mbps` : "0.00 Mbps";
      const clientPercent = Math.round((e.loaded / e.total) * 100);
      const displayPercent = Math.round(clientPercent * 0.8);

      statsElement.innerHTML = `
                            <span>Size: ${totalSize}</span>
                            <span>Uploaded: ${uploadedSize}</span>
                            <span>Speed: ${speedText.padStart(10, " ")}</span>
                        `;

      if (progressBar) progressBar.style.width = `${displayPercent}%`;
      if (statusText) statusText.textContent = `${displayPercent}%`;
    }
  });

  xhr.upload.addEventListener("loadend", () => {
    clearInterval(speedUpdateInterval);
    uploadSpeeds.delete(uploadId || xhr);
    if (uploadSpeeds.size === 0) stopGlobalSpeedTracker();

    // For standard uploads, show processing on loadend
    // For chunked, we handle this manually in finalizeUpload instead to prevent premature 'processing' message
    if (stats && statsElement) {
      statsElement.innerHTML = `
                        <span>Size: ${window.litter.formatFileSize(file.size)}</span>
                        <span>Status: Server Processing...</span>
                    `;
      if (statusText) statusText.textContent = "Processing...";
      if (progressBar) progressBar.style.width = "100%";
    }
  });
}
