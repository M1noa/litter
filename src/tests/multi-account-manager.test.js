const MultiAccountManager = require("../../lib/utils/multi-account-manager");
const GramJSClient = require("../../lib/utils/gramjs-client");
const fs = require("fs");
const path = require("path");

const logger = require("../../lib/utils/logger"); // Mock GramJSClient
jest.mock("../../lib/utils/gramjs-client");

describe("MultiAccountManager", () => {
  let manager;
  let mockClient1, mockClient2;

  beforeEach(() => {
    mockClient1 = {
      sessionPath: "./test-account1.session",
      apiId: "123",
      apiHash: "test-hash",
      phoneNumber: "1234567890",
      connect: jest.fn(),
      getMe: jest.fn().mockResolvedValue({
        firstName: "Test",
        lastName: "User1",
        username: "testuser1",
      }),
      uploadFile: jest.fn().mockResolvedValue({
        success: true,
        fileId: "test-file-id-1",
        messageId: 12345,
        uploadTime: 1000,
      }),
      downloadFile: jest.fn().mockResolvedValue(Buffer.from("test data")),
    messageExists: jest.fn().mockResolvedValue(false),
    verifyUploadAccessible: jest.fn().mockResolvedValue({ exists: false, hasMedia: false, reason: "Not found" }),
    disconnect: jest.fn(),
  };

  mockClient2 = {
      sessionPath: "./test-account2.session",
      apiId: "456",
      apiHash: "test-hash-2",
      phoneNumber: "0987654321",
      connect: jest.fn(),
      getMe: jest.fn().mockResolvedValue({
        firstName: "Test",
        lastName: "User2",
        username: "testuser2",
      }),
      uploadFile: jest.fn().mockResolvedValue({
        success: true,
        fileId: "test-file-id-2",
        messageId: 67890,
        uploadTime: 1000,
      }),
      downloadFile: jest.fn().mockResolvedValue(Buffer.from("test data")),
    messageExists: jest.fn().mockResolvedValue(false),
    verifyUploadAccessible: jest.fn().mockResolvedValue({ exists: false, hasMedia: false, reason: "Not found" }),
    disconnect: jest.fn(),
  };

    GramJSClient.mockImplementation((options) => {
      if (options.sessionPath.includes("account1")) {
        return mockClient1;
      } else if (options.sessionPath.includes("account2")) {
        return mockClient2;
      }
      return mockClient1;
    });

    // Mock session file existence
    jest.spyOn(fs, "existsSync").mockImplementation((filePath) => {
      if (!filePath) return false;
      return filePath.includes("account1.session") || filePath.includes("account2.session");
    });

    manager = new MultiAccountManager({
      apiId: "123",
      apiHash: "test-hash",
      // Account 1
      apiId1: "123",
      apiHash1: "test-hash",
      phoneNumber1: "1234567890",
      sessionPath1: "./test-account1.session",
      // Account 2
      apiId2: "456",
      apiHash2: "test-hash-2",
      phoneNumber2: "0987654321",
      sessionPath2: "./test-account2.session",
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("Initialization", () => {
    test("should initialize with two accounts", () => {
      expect(manager.accounts.size).toBe(2);
      expect(manager.accounts.has("account1")).toBe(true);
      expect(manager.accounts.has("account2")).toBe(true);
      expect(manager.primaryAccountId).toBe("account2");
    });

    test("should set correct primary account", () => {
      expect(manager.primaryAccountId).toBe("account2");
      expect(manager.secondaryAccountId).toBe("account1");
    });
  });

  describe("Account Connection", () => {
    test("should connect both accounts successfully", async () => {
      await manager.initialize();

      expect(mockClient1.connect).toHaveBeenCalled();
      expect(mockClient2.connect).toHaveBeenCalled();
      expect(mockClient1.getMe).toHaveBeenCalled();
      expect(mockClient2.getMe).toHaveBeenCalled();
    });

    test("should throw error if account 2 session does not exist", async () => {
      jest.spyOn(fs, "existsSync").mockImplementation((filePath) => {
        return filePath.includes("account1.session");
      });

      await expect(manager.initialize()).rejects.toThrow("Account 2 setup failed");
    });
  });

  describe("Account Selection for Upload", () => {
    beforeEach(async () => {
      await manager.initialize();
    });

    test("should always select primary account for single upload", () => {
      const selected = manager.selectAccountForUpload(1);
      expect(selected).toBe("account2");
    });

    test("should distribute uploads when queue size > 1", () => {
      // Initially should select primary
      let selected = manager.selectAccountForUpload(2);
      expect(selected).toBe("account2");

      // After some uploads, should balance
      manager.accounts.get("account2").uploadCount = 10;
      selected = manager.selectAccountForUpload(2);
      expect(selected).toBe("account1");
    });

    test("should fallback to secondary if primary is disconnected", () => {
      manager.accounts.get("account2").isConnected = false;
      const selected = manager.selectAccountForUpload(2);
      expect(selected).toBe("account1");
    });
  });

  describe("File Upload", () => {
    beforeEach(async () => {
      await manager.initialize();
    });

    test("should upload file via primary account for single upload", async () => {
      const fileBuffer = Buffer.from("test file content");
      const result = await manager.uploadFile(fileBuffer, "test.txt", "text/plain");

      expect(mockClient2.uploadFile).toHaveBeenCalledWith(
        fileBuffer,
        "test.txt",
        "text/plain",
        expect.objectContaining({
          uploadedVia: "account2",
          uploadTimestamp: expect.any(Number),
        }),
      );
      expect(result.uploadedVia).toBe("account2");
    });

    test("should distribute uploads when queue has multiple items", async () => {
      // Simulate multiple uploads
      const fileBuffer = Buffer.from("test file content");

      // First upload goes to primary
      await manager.uploadFile(fileBuffer, "test1.txt", "text/plain");
      expect(mockClient2.uploadFile).toHaveBeenCalledTimes(1);

      // Add more uploads to primary
      manager.accounts.get("account2").uploadCount = 5;

      // Next upload should go to secondary for balance
      await manager.uploadFile(fileBuffer, "test2.txt", "text/plain");
      expect(mockClient1.uploadFile).toHaveBeenCalledTimes(1);
    });

    test("should fallback to other account on upload failure", async () => {
      mockClient2.uploadFile.mockRejectedValueOnce(new Error("Upload failed"));

      const fileBuffer = Buffer.from("test file content");
      const result = await manager.uploadFile(fileBuffer, "test.txt", "text/plain");

      expect(mockClient2.uploadFile).toHaveBeenCalled();
      expect(mockClient1.uploadFile).toHaveBeenCalled();
      expect(result.uploadedVia).toBe("account1");
    });
  });

  describe("File Download", () => {
    beforeEach(async () => {
      await manager.initialize();
    });

    test("should download from primary account first", async () => {
      const result = await manager.downloadFile(12345);

      expect(mockClient2.downloadFile).toHaveBeenCalledWith(12345, 0);
      expect(result.downloadedVia).toBe("account2");
    });

    test("should fallback to secondary account if primary fails", async () => {
      mockClient2.downloadFile.mockRejectedValueOnce(new Error("Download failed"));

      const result = await manager.downloadFile(12345);

      expect(mockClient2.downloadFile).toHaveBeenCalled();
      expect(mockClient1.downloadFile).toHaveBeenCalled();
      expect(result.downloadedVia).toBe("account1");
    });
  });

  describe("File Validation", () => {
    beforeEach(async () => {
      await manager.initialize();
    });

  test("should check file existence on both accounts", async () => {
    mockClient1.verifyUploadAccessible.mockResolvedValue({ exists: false, hasMedia: false, reason: "Not found" });
    mockClient2.verifyUploadAccessible.mockResolvedValue({ exists: true, hasMedia: true, reason: "none" });

    const result = await manager.validateFileExists("test-file-id");

    expect(mockClient1.verifyUploadAccessible).toHaveBeenCalledWith("test-file-id");
    expect(mockClient2.verifyUploadAccessible).toHaveBeenCalledWith("test-file-id");
    expect(result.exists).toBe(true);
    expect(result.accountId).toBe("account2");
  });

  test("should return false if file not found on any account", async () => {
    mockClient1.verifyUploadAccessible.mockResolvedValue({ exists: false, hasMedia: false, reason: "Not found" });
    mockClient2.verifyUploadAccessible.mockResolvedValue({ exists: false, hasMedia: false, reason: "Not found" });

    const result = await manager.validateFileExists("test-file-id");

    expect(result.exists).toBe(false);
    expect(result.accountId).toBe(null);
  });
  });

  describe("Account Statistics", () => {
    beforeEach(async () => {
      await manager.initialize();
    });

    test("should return statistics for all accounts", () => {
      const stats = manager.getAccountStats();

      expect(stats).toEqual({
        account1: {
          isConnected: true,
          isPrimary: false,
          uploadCount: 0,
          downloadCount: 0,
          lastUsed: null,
        },
        account2: {
          isConnected: true,
          isPrimary: true,
          uploadCount: 0,
          downloadCount: 0,
          lastUsed: null,
        },
      });
    });

    test("should track upload counts", async () => {
      const fileBuffer = Buffer.from("test file content");
      await manager.uploadFile(fileBuffer, "test.txt", "text/plain");

      const stats = manager.getAccountStats();
      expect(stats.account2.uploadCount).toBe(1);
      expect(stats.account2.lastUsed).toBeGreaterThan(0);
    });
  });

  describe("Cleanup", () => {
    beforeEach(async () => {
      await manager.initialize();
    });

    test("should disconnect all accounts on cleanup", async () => {
      await manager.cleanup();

      expect(mockClient1.disconnect).toHaveBeenCalled();
      expect(mockClient2.disconnect).toHaveBeenCalled();
    });
  });
});
