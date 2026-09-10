const { Readable } = require("stream");

// Mock modules first
jest.mock("../../../lib/utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  success: jest.fn(),
}));

// ponytail: inline mock instead of requiring a deleted module
const mockDbHandler = {
  updateNsfwScan: jest.fn().mockResolvedValue({ success: true }),
  updateScanResults: jest.fn().mockResolvedValue({ success: true }),
  storeNSFWResult: jest.fn().mockResolvedValue({ success: true }),
  markFileAsChecked: jest.fn().mockResolvedValue({ success: true }),
  getFilesForNsfwScan: jest.fn().mockResolvedValue([]),
};

jest.mock("node-fetch", () => {
  const mockFetch = jest.fn();
  // Ensure both CommonJS require and ESM import work
  mockFetch.default = mockFetch;
  return mockFetch;
});

jest.mock("fs", () => ({
  promises: {
    unlink: jest.fn().mockResolvedValue(),
    readdir: jest.fn().mockResolvedValue([]),
    rmdir: jest.fn().mockResolvedValue(),
    rm: jest.fn().mockResolvedValue(), // Added rm
    mkdir: jest.fn().mockResolvedValue(),
    access: jest.fn().mockResolvedValue(),
    stat: jest.fn().mockResolvedValue({ isDirectory: () => false }),
    writeFile: jest.fn().mockResolvedValue(), // Added writeFile
    readFile: jest.fn().mockResolvedValue(Buffer.from("fake-content")), // Added readFile
  },
  createReadStream: jest.fn(),
  existsSync: jest.fn().mockReturnValue(true),
}));

jest.mock("tesseract.js", () => ({
  recognize: jest.fn().mockResolvedValue({
    data: { text: "mocked ocr text" },
  }),
}));

jest.mock("fluent-ffmpeg", () => {
  const mockChain = {
    on: jest.fn().mockReturnThis(),
    screenshots: jest.fn().mockImplementation(function (options) {
      // Trigger 'end' event to simulate completion
      // We need to use setImmediate or setTimeout to ensure asynchronous behavior
      // matching how the real ffmpeg works (and allowing the promise to pend)
      const endHandler = this.on.mock.calls.find((call) => call[0] === "end");
      if (endHandler && endHandler[1]) {
        setTimeout(() => endHandler[1](), 10);
      }
      return this;
    }),
  };

  const ffmpegMock = jest.fn(() => mockChain);

  ffmpegMock.ffprobe = jest.fn((path, callback) => {
    callback(null, { format: { duration: 100, size: 50 * 1024 * 1024 } }); // 100s, 50MB
  });

  return ffmpegMock;
});

// Import the module under test AFTER mocks
const NSFWScanner = require("../../../lib/utils/nsfw-scanner");

const mockTelegramAdapter = {
  downloadFile: jest.fn(),
  getMessage: jest.fn(),
  editMessage: jest.fn(),
};

describe("NSFWScanner Video Support", () => {
  let scanner;

  beforeEach(() => {
    jest.clearAllMocks();
    scanner = new NSFWScanner({
      dbHandler: mockDbHandler,
      telegramAdapter: mockTelegramAdapter,
      apiUrl: "http://localhost:8080",
      fetch: require("node-fetch"),
    });
  });

  afterEach(() => {
    delete process.env.NUDENET_API_URL;
  });

  test("queueForScan should accept video files", async () => {
    // Spy on processQueue and prevent it from running to keep item in queue
    jest.spyOn(scanner, "processQueue").mockImplementation(async () => {});

    const fileData = {
      publicId: "vid123",
      telegramFileId: "tg123",
      telegramMessageId: 123,
      originalName: "test.mp4",
      mimeType: "video/mp4",
    };

    await scanner.queueForScan(fileData);

    // Should be added to queue
    expect(scanner.scanQueue.length).toBe(1);
    expect(scanner.scanQueue[0].publicId).toBe("vid123");
    // Verify processQueue was triggered
    expect(scanner.processQueue).toHaveBeenCalled();
  });

  test("scanFile should handle video files by extracting frames", async () => {
    // Setup
    const publicId = "vid123";
    const msgId = 123;
    const fileName = "test.mp4";
    const mimeType = "video/mp4";

    // Mock download
    mockTelegramAdapter.downloadFile.mockResolvedValue(Buffer.from("fake-video-content"));

    // Mock fetch for frame scanning
    const fetch = require("node-fetch");
    // We need to verify if the code is actually calling this mock
    fetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          prediction: [[{ class: "neutral", score: 0.9, box: [] }]],
        }),
      }),
    );

    // Mock fs.promises.readdir to return some frames
    require("fs").promises.readdir.mockResolvedValue(["frame-1.jpg", "frame-2.jpg"]);
    // Mock createReadStream to return a readable stream
    require("fs").createReadStream.mockReturnValue(Readable.from(["fake-image-data"]));

    // Mock processClassifications to return something valid
    jest.spyOn(scanner, "processClassifications").mockReturnValue({
      detections: [{ class: "neutral", score: 0.9 }],
      highRiskTags: [],
      allTags: ["neutral"],
    });

    // Execute
    const result = await scanner.scanFile(publicId, msgId, fileName, mimeType);

    if (!result.success) {
      console.error("Scan failed result:", JSON.stringify(result, null, 2));
      const logger = require("../../../lib/utils/logger");
      console.error("Logger error calls:", JSON.stringify(logger.error.mock.calls));
      console.error("Logger warn calls:", JSON.stringify(logger.warn.mock.calls));
      console.error("Logger info calls:", JSON.stringify(logger.info.mock.calls));
    }

    // Verify
    expect(result.success).toBe(true);
    // Should have called ffmpeg (we mocked the module)
    const ffmpeg = require("fluent-ffmpeg");
    expect(ffmpeg).toHaveBeenCalled();

    // Should have scanned frames
    expect(fetch).toHaveBeenCalled();
  });
});
