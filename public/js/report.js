document.addEventListener("DOMContentLoaded", () => {
  setupModals();
  setupReportForm();
  updateTotalSize();
});

function setupModals() {
  const privacyBtns = document.querySelectorAll("#privacyBtn");
  const termsBtns = document.querySelectorAll("#termsBtn");
  const privacyModal = document.getElementById("privacyModal");
  const termsModal = document.getElementById("termsModal");
  const settingsModal = document.getElementById("settingsModal");
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
      hideModal(settingsModal);
    });
  });

  window.addEventListener("click", (e) => {
    if (e.target === privacyModal) hideModal(privacyModal);
    if (e.target === termsModal) hideModal(termsModal);
    if (e.target === settingsModal) hideModal(settingsModal);
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideModal(privacyModal);
      hideModal(termsModal);
      hideModal(settingsModal);
    }
  });
}

function setupReportForm() {
  const form = document.getElementById("report-form");
  const issueTypeSelect = document.getElementById("issue-type");
  const dmcaGroup = document.getElementById("dmca-group");
  const submitBtn = document.getElementById("submit-btn");
  const successMessage = document.getElementById("success-message");
  const errorMessage = document.getElementById("error-message");
  const formContainer = document.getElementById("form-container");

  if (!form) return;

  // Show/hide DMCA fields based on issue type
  if (issueTypeSelect) {
    issueTypeSelect.addEventListener("change", (e) => {
      if (e.target.value === "copyright") {
        dmcaGroup.style.display = "block";
      } else {
        dmcaGroup.style.display = "none";
      }
    });
  }

  // Form submission
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Reset error state
    errorMessage.style.display = "none";
    errorMessage.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";

    try {
      const formData = new FormData(form);
      const data = Object.fromEntries(formData.entries());

      // Parse file URLs (support comma or newline separated)
      data.file_urls = data.file_urls
        .split(/[\n,]+/)
        .map((url) => url.trim())
        .filter(Boolean);

      if (data.file_urls.length === 0) {
        throw new Error("Please provide at least one file URL");
      }

      // Send to API
      const response = await fetch("/api/report", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });

      const result = await response.json();

      if (response.ok) {
        // Success
        if (window.litter?.logger) window.litter.logger.info("api", "Report submitted successfully", { type: data.issue_type });
        formContainer.style.display = "none";
        successMessage.style.display = "block";
      } else {
        // Error
        if (window.litter?.logger) window.litter.logger.warn("api", "Report submission failed", { status: response.status, message: result.message || result.error });
        errorMessage.textContent = result.message || result.error || "Failed to submit report";
        errorMessage.style.display = "block";
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit Report";
      }
    } catch (err) {
      if (window.litter?.logger) window.litter.logger.error("network", "Report submission network error", err);
      errorMessage.textContent = "Network error: " + err.message;
      errorMessage.style.display = "block";
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Report";
    }
  });
}

function insertDMCATemplate() {
  const dmcaDetails = document.getElementById("dmca-details");
  if (!dmcaDetails) return;

  dmcaDetails.value = `I am the copyright owner (or authorized agent) of the work described below.

Copyrighted work: [Describe your copyrighted work]
Infringing material: [Describe what is infringing]
Location: [URLs are listed above]

I have a good faith belief that the use of this material is not authorized by the copyright owner, its agent, or the law.

I swear, under penalty of perjury, that the information in this notification is accurate and that I am the copyright owner or authorized to act on behalf of the copyright owner.

Contact Information:
Name: [Your full name]
Address: [Your address]
Phone: [Your phone number]
Email: [Your email address]`;
}

document.addEventListener("DOMContentLoaded", () => {
  const dmcaTemplateBtn = document.getElementById("insert-dmca-template-btn");
  if (dmcaTemplateBtn) dmcaTemplateBtn.addEventListener("click", insertDMCATemplate);
});
