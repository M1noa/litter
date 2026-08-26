// E2EE Manager — Main thread helper for client-side encryption
// Exposes window.E2EEManager

(function() {
  "use strict";

  const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*";

  let worker = null;
  var _msgId = 0;
  var _pending = {};

  function initWorker() {
    if (worker) return worker;
    worker = new Worker("/e2ee-worker.js");
    worker.onmessage = function(e) {
      var msg = e.data;
      var id = msg._msgId;
      if (id && _pending[id]) {
        if (msg.type === "encryptProgress" || msg.type === "decryptProgress") {
          if (_pending[id].onProgress) _pending[id].onProgress(msg);
          return; // Don't resolve/reject — wait for final message
        }
        clearTimeout(_pending[id].timer);
        if (msg.type === "error") {
          _pending[id].reject(new Error(msg.error));
        } else {
          _pending[id].resolve(msg);
        }
        delete _pending[id];
      }
    };
    return worker;
  }

  function generatePassphrase(length) {
    length = length || 16;
    if (length < 9) length = 9;
    if (length > 24) length = 24;
    var rejectLimit = 256 - (256 % CHARS.length);
    var result = "";
    while (result.length < length) {
      var buf = new Uint8Array(length - result.length);
      crypto.getRandomValues(buf);
      for (var i = 0; i < buf.length; i++) {
        if (buf[i] < rejectLimit) {
          result += CHARS[buf[i] % CHARS.length];
        }
      }
    }
    return result;
  }

  function workerMessage(type, data, transferables, onProgress) {
    return new Promise(function(resolve, reject) {
      var w = initWorker();
      var id = ++_msgId;
      var payload = Object.assign({ type: type, _msgId: id }, data);
      _pending[id] = {
        resolve: resolve,
        reject: reject,
        onProgress: onProgress || null,
        timer: setTimeout(function() {
          delete _pending[id];
          reject(new Error("Worker timeout for: " + type));
        }, 300000) // 5 min timeout for large file crypto
      };
      if (transferables) {
        w.postMessage(payload, transferables);
      } else {
        w.postMessage(payload);
      }
    });
  }

  async function encryptFile(file, passphrase, onProgress) {
    if (!passphrase) passphrase = generatePassphrase();
    if (onProgress) onProgress("reading", 0);

    var buffer = await file.arrayBuffer();
    if (onProgress) onProgress("encrypting", 0);

    var result = await workerMessage("encryptFile", {
      fileData: buffer,
      passphrase: passphrase,
      fileName: file.name,
      mimeType: file.type
    }, [buffer], function(progress) {
      if (onProgress) {
        var pct = Math.round((progress.chunkIndex / progress.totalChunks) * 100);
        onProgress("encrypting", pct);
      }
    });

    var encryptedBlob = new Blob([result.encryptedData], { type: "application/octet-stream" });
    return { encryptedBlob: encryptedBlob, passphrase: passphrase };
  }


  async function decryptFile(encryptedBuffer, passphrase, onProgress) {
    if (onProgress) onProgress("deriving");
    var result = await workerMessage("decryptFile", {
      fileData: encryptedBuffer,
      passphrase: passphrase
    }, [encryptedBuffer]);

    if (onProgress) onProgress("done");

    var decryptedBlob = new Blob([result.decryptedData], { type: result.mimeType || "application/octet-stream" });
    return {
      decryptedBlob: decryptedBlob,
      fileName: result.fileName,
      mimeType: result.mimeType
    };
  }

  function buildE2EEUrl(baseUrl, passphrase) {
    if (!passphrase) return baseUrl;
    var separator = baseUrl.includes("#") ? "&" : "#";
    return baseUrl + separator + "k=" + encodeURIComponent(passphrase);
  }

  window.E2EEManager = {
    generatePassphrase: generatePassphrase,
    initWorker: initWorker,
    encryptFile: encryptFile,
    decryptFile: decryptFile,
    buildE2EEUrl: buildE2EEUrl,
    onEncryptProgress: null
  };
})();
