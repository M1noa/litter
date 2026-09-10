(function () {
  var params = new URLSearchParams(window.location.search);
  var originalUrl = params.get('url') || '';
  var initialPosition = parseInt(params.get('position'), 10) || 0;
  var initialEstimatedWait = parseInt(params.get('estimatedWait'), 10) || 0;
  var message = params.get('message') || '';

  if (!originalUrl) {
    window.location.href = '/';
    return;
  }

  var elPosition = document.getElementById('position');
  var elPositionLabel = document.getElementById('positionLabel');
  var elEstimatedWait = document.getElementById('estimatedWait');
  var elTimeInQueue = document.getElementById('timeInQueue');
  var elProgressFill = document.getElementById('progressFill');
  var elMessage = document.getElementById('message');
  var elStatusText = document.getElementById('statusText');
  var elOverlay = document.getElementById('redirectOverlay');
  var elApp = document.getElementById('app');

  var currentPosition = initialPosition;
  var bestPosition = initialPosition;
  var estimatedWait = initialEstimatedWait;
  var startTime = Date.now();
  var lastPositionChangeTime = Date.now();
  var pollIntervalMs = 3000;
  var stillWaitingThresholdMs = 60000;
  var timerInterval = null;
  var pollTimer = null;
  var hasShownStillWaiting = false;

  if (message) {
    elMessage.textContent = message;
  }

  function formatWait(seconds) {
    if (seconds <= 0) return '< 1s';
    if (seconds < 60) return seconds + 's';
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    if (m < 60) return m + 'm ' + s + 's';
    var h = Math.floor(m / 60);
    var rm = m % 60;
    return h + 'h ' + rm + 'm';
  }

  function formatElapsed(ms) {
    var totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return totalSec + 's';
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    if (m < 60) return m + 'm ' + s + 's';
    var h = Math.floor(m / 60);
    var rm = m % 60;
    return h + 'h ' + rm + 'm';
  }

  function updateDisplay() {
    elPosition.textContent = currentPosition > 0 ? '#' + currentPosition : '--';
    elEstimatedWait.textContent = estimatedWait > 0 ? formatWait(estimatedWait) : '--';

    var elapsed = Date.now() - startTime;
    elTimeInQueue.textContent = formatElapsed(elapsed);

    if (bestPosition > 0) {
      var progress = Math.max(0, Math.min(100, ((bestPosition - currentPosition) / bestPosition) * 100));
      elProgressFill.style.width = progress + '%';
    }

    if (!hasShownStillWaiting) {
      var timeSinceChange = Date.now() - lastPositionChangeTime;
      if (timeSinceChange >= stillWaitingThresholdMs && currentPosition > 0) {
        hasShownStillWaiting = true;
        elMessage.textContent = 'still waiting... your spot is held';
        elMessage.classList.add('still-waiting');
      }
    }
  }

  function redirectToOriginal() {
    elOverlay.classList.add('active');
    setTimeout(function () {
      window.location.href = originalUrl;
    }, 600);
  }

  function poll() {
    var encodedUrl = encodeURIComponent(originalUrl);
    fetch('/api/queue-status?url=' + encodedUrl)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data.ready) {
          clearInterval(timerInterval);
          clearTimeout(pollTimer);
          redirectToOriginal();
          return;
        }

        if (typeof data.position === 'number' && data.position > 0) {
          var previousPosition = currentPosition;
          currentPosition = data.position;

          if (currentPosition < bestPosition) {
            bestPosition = currentPosition;
          }

          if (currentPosition !== previousPosition) {
            lastPositionChangeTime = Date.now();
            hasShownStillWaiting = false;
            elMessage.classList.remove('still-waiting');
            if (message) {
              elMessage.textContent = message;
            } else {
              elMessage.textContent = '';
            }
          }

          if (currentPosition > previousPosition && previousPosition > 0) {
            elPositionLabel.textContent = 'queue position (moved back)';
            elPositionLabel.classList.add('position-went-up');
          } else {
            elPositionLabel.textContent = 'queue position';
            elPositionLabel.classList.remove('position-went-up');
          }
        }

        if (typeof data.estimatedWait === 'number') {
          estimatedWait = data.estimatedWait;
        }

        if (data.message) {
          elMessage.textContent = data.message;
        }

        elApp.classList.remove('error-state');
        elStatusText.textContent = 'polling for updates';
        updateDisplay();
        schedulePoll();
      })
      .catch(function () {
        elApp.classList.add('error-state');
        elStatusText.textContent = 'connection issue, retrying';
        schedulePoll();
      });
  }

  function schedulePoll() {
    pollTimer = setTimeout(poll, pollIntervalMs);
  }

  updateDisplay();
  timerInterval = setInterval(updateDisplay, 1000);
  poll();
})();
