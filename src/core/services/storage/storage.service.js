// core/services/storage/storage.service.js
const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const { Readable } = require("stream");
const env = require("../../../../config/index");

class StorageService {
  static instance;
  s3;
  isS3Enabled;

  constructor() {
    if (StorageService.instance) return StorageService.instance;

    this.isS3Enabled = env.CDN.CDN_TYPE === "aws" && !!env.CDN.CDN_BUCKET_NAME;

    if (this.isS3Enabled) {
      this.s3 = new AWS.S3({
        accessKeyId: env.CDN.CDN_KEY,
        secretAccessKey: env.CDN.CDN_SECRET,
        region: env.CDN.CDN_REGION,
      });
    }

    StorageService.instance = this;
  }

  // ================= UPLOAD =================
  async upload(file, folder = "uploads") {
    if (!file) throw new Error("File is required");

    const ext = path.extname(file.originalname);
    const fileName = `${uuidv4()}${ext}`;
    const key = `${folder}/${fileName}`;

    // If S3 disabled → local save
    if (!this.isS3Enabled) {
      return this.saveLocal(file, key);
    }

    // Threshold 20MB
    const LARGE_FILE_LIMIT = 20 * 1024 * 1024;

    if (file.size < LARGE_FILE_LIMIT) {
      return this.uploadBuffer(file, key);
    }

    return this.uploadStream(file, key);
  }

  // ================= BUFFER UPLOAD =================
  async uploadBuffer(file, key) {
    const res = await this.s3
      .upload({
        Bucket: env.CDN.CDN_BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
      .promise();

    return this.formatResponse(res, key);
  }

  // ================= STREAM UPLOAD =================
  async uploadStream(file, key) {
    const stream = Readable.from(file.buffer);

    const res = await this.s3
      .upload({
        Bucket: env.CDN.CDN_BUCKET_NAME,
        Key: key,
        Body: stream,
        ContentType: file.mimetype,
        ACL: "public-read",
      })
      .promise();

    return this.formatResponse(res, key);
  }

  // ================= LOCAL FALLBACK =================
  async saveLocal(file, key) {
    const basePath = path.join(process.cwd(), "uploads");
    const dir = path.join(basePath, path.dirname(key));

    await fs.promises.mkdir(dir, { recursive: true });

    const filePath = path.join(basePath, key);
    await fs.promises.writeFile(filePath, file.buffer);

    return {
      key,
      location: `${env.SERVICE_URL}/uploads/${key}`,
      local: true,
    };
  }

  // ================= DELETE =================
  async delete(key) {
    if (!key) throw new Error("File key required");

    if (!this.isS3Enabled) {
      const filePath = path.join(process.cwd(), "uploads", key);
      await fs.promises.unlink(filePath);
      return { deleted: true, local: true };
    }

    await this.s3
      .deleteObject({
        Bucket: env.CDN.CDN_BUCKET_NAME,
        Key: key,
      })
      .promise();

    return { deleted: true };
  }

  // ================= FORMAT RESPONSE =================
  formatResponse(res, key) {
    if (res.Location && !res.Location.startsWith("https")) {
      res.Location = "https://" + res.Location;
    }

    return {
      key,
      location: res.Location,
      bucket: env.CDN.CDN_BUCKET_NAME,
    };
  }
}

module.exports = new StorageService();
