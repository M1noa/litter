const {
  encodeFilenameForUrl,
  buildFileUrl,
  decodeFilename,
  encodeContentDisposition,
} = require("../../lib/utils/url-encoding");

describe("URL Encoding Utilities", () => {
  describe("encodeFilenameForUrl", () => {
    it("should encode parentheses", () => {
      expect(encodeFilenameForUrl("file(1).txt")).toBe("file%281%29.txt");
    });

    it("should encode nested parentheses", () => {
      expect(encodeFilenameForUrl("file((nested)).txt")).toBe("file%28%28nested%29%29.txt");
    });

    it("should encode spaces", () => {
      expect(encodeFilenameForUrl("my file.txt")).toBe("my%20file.txt");
    });

    it("should encode brackets", () => {
      expect(encodeFilenameForUrl("file[1].txt")).toBe("file%5B1%5D.txt");
    });

    it("should handle unicode characters", () => {
      expect(encodeFilenameForUrl("文件.txt")).toBe("%E6%96%87%E4%BB%B6.txt");
    });

    it("should handle the real-world test case from the issue", () => {
      expect(encodeFilenameForUrl("Todd Beasley - Girls Want Girls (1).flac")).toBe(
        "Todd%20Beasley%20-%20Girls%20Want%20Girls%20%281%29.flac",
      );
    });

    it("should be idempotent with decode", () => {
      const original = "file(1)[test].txt";
      const encoded = encodeFilenameForUrl(original);
      const decoded = decodeFilename(encoded);
      expect(decoded).toBe(original);
    });

    it("should throw on null", () => {
      expect(() => encodeFilenameForUrl(null)).toThrow(TypeError);
    });

    it("should throw on empty string", () => {
      expect(() => encodeFilenameForUrl("")).toThrow(TypeError);
    });

    it("should throw on non-string", () => {
      expect(() => encodeFilenameForUrl(123)).toThrow(TypeError);
    });
  });

  describe("buildFileUrl", () => {
    it("should build correct URL format", () => {
      expect(buildFileUrl(12345, "test.txt")).toBe("/files/12345/test.txt");
    });

    it("should encode filename in URL", () => {
      expect(buildFileUrl(12345, "file(1).txt")).toBe("/files/12345/file%281%29.txt");
    });

    it("should accept string or number message IDs", () => {
      expect(buildFileUrl("12345", "test.txt")).toBe("/files/12345/test.txt");
      expect(buildFileUrl(12345, "test.txt")).toBe("/files/12345/test.txt");
    });

    it("should handle real-world test case", () => {
      expect(buildFileUrl(394857, "Todd Beasley - Girls Want Girls (1).flac")).toBe(
        "/files/394857/Todd%20Beasley%20-%20Girls%20Want%20Girls%20%281%29.flac",
      );
    });

    it("should throw on missing message ID", () => {
      expect(() => buildFileUrl(null, "test.txt")).toThrow(TypeError);
    });

    it("should throw on missing filename", () => {
      expect(() => buildFileUrl(12345, null)).toThrow(TypeError);
    });
  });

  describe("decodeFilename", () => {
    it("should decode parentheses", () => {
      expect(decodeFilename("file%281%29.txt")).toBe("file(1).txt");
    });

    it("should decode spaces", () => {
      expect(decodeFilename("my%20file.txt")).toBe("my file.txt");
    });

    it("should decode brackets", () => {
      expect(decodeFilename("file%5B1%5D.txt")).toBe("file[1].txt");
    });

    it("should throw on null", () => {
      expect(() => decodeFilename(null)).toThrow(TypeError);
    });

    it("should throw on empty string", () => {
      expect(() => decodeFilename("")).toThrow(TypeError);
    });
  });

  describe("encodeContentDisposition", () => {
    it("should encode basic ASCII filename", () => {
      const result = encodeContentDisposition("test.txt");
      expect(result).toBe("attachment; filename=\"test.txt\"; filename*=UTF-8''test.txt");
    });

    it("should encode filename with parentheses", () => {
      const result = encodeContentDisposition("file(1).txt");
      expect(result).toBe("attachment; filename=\"file(1).txt\"; filename*=UTF-8''file%281%29.txt");
    });

    it("should encode unicode filenames with ASCII fallback", () => {
      const result = encodeContentDisposition("文件.txt");
      expect(result).toBe("attachment; filename=\"__.txt\"; filename*=UTF-8''%E6%96%87%E4%BB%B6.txt");
    });

    it("should handle inline disposition", () => {
      const result = encodeContentDisposition("test.txt", "inline");
      expect(result).toBe("inline; filename=\"test.txt\"; filename*=UTF-8''test.txt");
    });

    it("should sanitize newlines to prevent header injection", () => {
      const result = encodeContentDisposition("test\r\nmalicious.txt");
      expect(result).toBe("attachment; filename=\"testmalicious.txt\"; filename*=UTF-8''testmalicious.txt");
    });

    it("should handle real-world test case", () => {
      const result = encodeContentDisposition("Todd Beasley - Girls Want Girls (1).flac");
      expect(result).toBe(
        "attachment; filename=\"Todd Beasley - Girls Want Girls (1).flac\"; filename*=UTF-8''Todd%20Beasley%20-%20Girls%20Want%20Girls%20%281%29.flac",
      );
    });

    it("should throw on null", () => {
      expect(() => encodeContentDisposition(null)).toThrow(TypeError);
    });

    it("should throw on empty string", () => {
      expect(() => encodeContentDisposition("")).toThrow(TypeError);
    });

    it("should throw on non-string", () => {
      expect(() => encodeContentDisposition(123)).toThrow(TypeError);
    });

    it("should escape quotes in ASCII filename to prevent injection", () => {
      const result = encodeContentDisposition('file"test".txt');
      expect(result).toBe('attachment; filename="file\\"test\\".txt"; filename*=UTF-8\'\'file%22test%22.txt');
    });

    it("should escape backslashes in ASCII filename", () => {
      const result = encodeContentDisposition("file\\test.txt");
      expect(result).toBe("attachment; filename=\"file\\\\test.txt\"; filename*=UTF-8''file%5Ctest.txt");
    });

    it("should handle combined quote and backslash", () => {
      const result = encodeContentDisposition('file\\"test".txt');
      expect(result).toContain('filename="file\\\\\\"test\\".txt"');
    });

    it("should remove all control characters", () => {
      const result = encodeContentDisposition("file\x00\x01\x1F\x7Ftest.txt");
      expect(result).toBe("attachment; filename=\"filetest.txt\"; filename*=UTF-8''filetest.txt");
    });

    it("should encode path traversal attempts", () => {
      expect(encodeContentDisposition("../../../etc/passwd")).toBe(
        "attachment; filename=\"../../../etc/passwd\"; filename*=UTF-8''..%2F..%2F..%2Fetc%2Fpasswd",
      );
      expect(encodeContentDisposition("..\\..\\windows\\system32")).toBe(
        "attachment; filename=\"..\\\\..\\\\windows\\\\system32\"; filename*=UTF-8''..%5C..%5Cwindows%5Csystem32",
      );
    });
  });

  describe("Integration tests", () => {
    it("should round-trip through encode/decode", () => {
      const testFilenames = [
        "simple.txt",
        "file(1).txt",
        "file [test].pdf",
        "user's document.docx",
        "Todd Beasley - Girls Want Girls (1).flac",
        "文件名.zip",
      ];

      testFilenames.forEach((filename) => {
        const encoded = encodeFilenameForUrl(filename);
        const decoded = decodeFilename(encoded);
        expect(decoded).toBe(filename);
      });
    });

    it("should create valid URLs that round-trip", () => {
      const filename = "file(1).txt";
      const url = buildFileUrl(12345, filename);
      const extractedFilename = url.split("/").pop();
      const decoded = decodeFilename(extractedFilename);
      expect(decoded).toBe(filename);
    });
  });
});
