const targetLangSelect = document.getElementById('target-lang');
const customLangInput = document.getElementById('custom-lang');
const inputText = document.getElementById('input-text');
const outputArea = document.getElementById('output-area');
const errorBanner = document.getElementById('error-banner');
const copyBtn = document.getElementById('copy-btn');
const pasteBtn = document.getElementById('paste-btn');

const ttftEl = document.getElementById('ttft');
const totalTimeEl = document.getElementById('total-time');
const tpsEl = document.getElementById('tps');
const inputStatsEl = document.getElementById('input-stats');
const outputStatsEl = document.getElementById('output-stats');
const warningBanner = document.getElementById('warning-banner');

const rateLimitWindow = 60 * 1000;
const maxRequestsPerWindow = 20;
let requestTimestamps = [];
let debounceTimer = null;
const DEBOUNCE_DELAY = 600;

function checkRateLimit() {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(timestamp => now - timestamp < rateLimitWindow);

  if (requestTimestamps.length >= maxRequestsPerWindow) {
    const oldestRequest = requestTimestamps[0];
    const timeUntilReset = Math.ceil((rateLimitWindow - (now - oldestRequest)) / 1000);
    showError(`Rate limit exceeded. Try again in ${timeUntilReset}s.`);
    return false;
  }

  requestTimestamps.push(now);
  return true;
}

targetLangSelect.addEventListener('change', () => {
  if (targetLangSelect.value === 'custom') {
    customLangInput.classList.add('show');
    targetLangSelect.style.display = 'none';
  }
});

customLangInput.addEventListener('blur', () => {
  if (!customLangInput.value.trim()) {
    customLangInput.classList.remove('show');
    targetLangSelect.style.display = 'block';
    targetLangSelect.value = 'English';
  }
});

inputText.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const text = inputText.value.trim();
  if (text.length === 0) {
    outputArea.textContent = 'Translation will appear here...';
    outputArea.classList.add('empty');
    return;
  }
  debounceTimer = setTimeout(performTranslation, DEBOUNCE_DELAY);
});

inputText.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    clearTimeout(debounceTimer);
    performTranslation();
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    const text = outputArea.innerText;
    if (text && text !== 'Translation will appear here...' && text !== 'Translation failed. Please try again.') {
      await navigator.clipboard.writeText(text);
      const origHTML = copyBtn.innerHTML;
      copyBtn.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied';
      setTimeout(() => {
        copyBtn.innerHTML = origHTML;
      }, 2000);
      if (window.litter && window.litter.showNotification) {
        window.litter.showNotification('Copied to clipboard', 'success');
      }
    }
} catch (err) {
      if (window.litter?.logger) window.litter.logger.error('ui', 'Failed to copy text', err);
      else console.error('Failed to copy text: ', err);
      if (window.litter && window.litter.showNotification) {
      window.litter.showNotification('Failed to copy', 'error');
    }
  }
});

pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      inputText.value = text;
      const origHTML = pasteBtn.innerHTML;
      pasteBtn.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Pasted';
      setTimeout(() => {
        pasteBtn.innerHTML = origHTML;
      }, 2000);
    }
} catch (err) {
      if (window.litter?.logger) window.litter.logger.error('ui', 'Failed to read clipboard', err);
      else console.error('Failed to read clipboard: ', err);
      if (window.litter && window.litter.showNotification) {
      window.litter.showNotification('Clipboard permission denied', 'error');
    }
  }
});

function createAnimatedToken(text) {
  const parts = text.split(/(\s+)/);
  const fragment = document.createDocumentFragment();

  parts.forEach(part => {
    if (part.length > 0) {
      const span = document.createElement('span');
      span.className = 'token-char';
      span.textContent = part;
      fragment.appendChild(span);
    }
  });
  return fragment;
}

let currentAbortController = null;

async function performTranslation() {
  const text = inputText.value.trim();
  if (!text) {
    return;
  }

  if (!checkRateLimit()) {
    if (window.litter?.logger) window.litter.logger.warn('api', 'Translation rate limited');
    return;
  }

  const targetLang = targetLangSelect.value === 'custom' ? customLangInput.value.trim() : targetLangSelect.value;

  const actualTargetLang = targetLang || text;

  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();

  outputArea.textContent = '';
  outputArea.classList.remove('empty');
  hideError();
  hideWarning();
  resetStats();

  const inputCharCount = text.length;
  const inputWordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  inputStatsEl.innerHTML = `${inputCharCount}<span class="stat-unit">c</span> / ${inputWordCount}<span class="stat-unit">w</span>`;

  const startTime = performance.now();
  let firstTokenTime = null;
  let tokenCount = 0;
  let translationText = '';
  let metaReceived = false;
  let metaBuffer = '';
  let hasWarning = false;

  let previousText = '';

  try {
    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        target_lang: actualTargetLang,
        stream: true,
      }),
      signal: currentAbortController.signal,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Translation failed' }));
      if (window.litter?.logger) window.litter.logger.error('api', 'Translation request failed', { status: response.status, error: errorData.error });
      throw new Error(errorData.error || 'Translation failed');
    }

    const warningHeader = response.headers.get('X-Warning');
    if (warningHeader && warningHeader === 'POTENTIAL_INJECTION_DETECTED') {
      hasWarning = true;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      if (firstTokenTime === null && chunk.length > 0) {
        firstTokenTime = performance.now();
        const ttft = Math.round(firstTokenTime - startTime);
        ttftEl.innerHTML = `${ttft}<span class="stat-unit">ms</span>`;
      }

      const metaIndex = buffer.indexOf('|||META|||');
      if (metaIndex !== -1 && !metaReceived) {
        translationText = buffer.substring(0, metaIndex);
        metaBuffer = buffer.substring(metaIndex + 11);
        metaReceived = true;

        const newText = translationText.substring(previousText.length);
        if (newText.length > 0) {
          outputArea.appendChild(createAnimatedToken(newText));
          previousText = translationText;
        }
      } else if (!metaReceived) {
        translationText = buffer;

        const newText = translationText.substring(previousText.length);
        if (newText.length > 0) {
          outputArea.appendChild(createAnimatedToken(newText));
          previousText = translationText;
        }
        tokenCount++;

        outputArea.scrollTop = outputArea.scrollHeight;
      } else {
        metaBuffer = buffer.substring(buffer.indexOf('|||META|||') + 11);
      }
    }

    if (hasWarning) {
      showWarning();
    }

    const endTime = performance.now();
    const totalTime = Math.round(endTime - startTime);
    const tps = firstTokenTime ? Math.round((tokenCount / (endTime - firstTokenTime)) * 1000) : 0;

    totalTimeEl.innerHTML = `${totalTime}<span class="stat-unit">ms</span>`;
    tpsEl.textContent = tps;

    const outputCharCount = translationText.length;
    const outputWordCount = translationText.split(/\s+/).filter(w => w.length > 0).length;
    outputStatsEl.innerHTML = `${outputCharCount}<span class="stat-unit">c</span> / ${outputWordCount}<span class="stat-unit">w</span>`;
  if (window.litter?.logger) window.litter.logger.info('api', 'Translation complete', { totalTime: `${totalTime}ms`, tokens: tokenCount, tps });
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }
    showError(error.message);
    outputArea.classList.add('empty');
    outputArea.textContent = 'Translation failed. Please try again.';
  }
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.add('show');
}

function hideError() {
  errorBanner.classList.remove('show');
}

function showWarning() {
  warningBanner.classList.add('show');
}

function hideWarning() {
  warningBanner.classList.remove('show');
}

function resetStats() {
  ttftEl.innerHTML = '-<span class="stat-unit">ms</span>';
  totalTimeEl.innerHTML = '-<span class="stat-unit">ms</span>';
  tpsEl.textContent = '-';
  inputStatsEl.textContent = '-';
  outputStatsEl.textContent = '-';
}
