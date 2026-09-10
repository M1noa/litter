const NSFWScanner = require("../../../lib/utils/nsfw-scanner");
const fs = require("fs");
const path = require("path");

// Mock logger
jest.mock("../../../lib/utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  success: jest.fn(),
}));

describe("NSFWScanner WebP OCR Issue", () => {
  let scanner;
  let mockDbHandler;
  let mockTelegramAdapter;
  let mockFetch;

  beforeEach(() => {
    jest.clearAllMocks();

    mockDbHandler = {
      updateScanResults: jest.fn().mockResolvedValue({ success: true }),
      storeNSFWResult: jest.fn().mockResolvedValue({ success: true }),
      markFileAsChecked: jest.fn().mockResolvedValue({ success: true }),
    };

    mockTelegramAdapter = {
      downloadFile: jest.fn(),
    };

    mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        success: true,
        prediction: [[{ class: "neutral", score: 0.9, box: [] }]],
      }),
    });

    scanner = new NSFWScanner({
      dbHandler: mockDbHandler,
      telegramAdapter: mockTelegramAdapter,
      apiUrl: "http://localhost:8080",
      fetch: mockFetch,
    });
  });

  test("scanFile should safely handle OCR failures on WebP files without crashing", async () => {
    // Setup Tesseract to throw an error (simulating the WebP decode failure)
    const Tesseract = require("tesseract.js");
    jest.spyOn(Tesseract, "recognize").mockRejectedValue(new Error("Error in pixReadMemWebP: WebP decode failed"));

    const publicId = "webp123";
    const msgId = 123;
    const fileName = "archive_1771063097134.webp";
    const mimeType = "image/webp";

    // Mock download
    mockTelegramAdapter.downloadFile.mockResolvedValue(Buffer.from("fake-webp-content"));

    // Execute - This shouldn't throw an unhandled exception
    const result = await scanner.scanFile(publicId, msgId, fileName, mimeType);

    // Verify
    expect(result.success).toBe(true);
    expect(mockDbHandler.updateScanResults).toHaveBeenCalled();

    // Tesseract should NOT have been called
    expect(Tesseract.recognize).not.toHaveBeenCalled();

	// The logger should have recorded a debug about skipping
	const logger = require("../../../lib/utils/logger");
	expect(logger.debug).toHaveBeenCalledWith(
		expect.stringContaining("Skipping OCR for archive_1771063097134.webp to avoid WebP decoding crash"),
	);
  });
});
