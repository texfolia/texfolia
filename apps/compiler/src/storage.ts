import { S3Client } from "bun";

const r2 = new S3Client({
  accessKeyId: "access-key-id",
  secretAccessKey: "secret-access-key",
  bucket: "my-bucket",
  endpoint: "https://<account-id>.r2.cloudflarestorage.com"
})
