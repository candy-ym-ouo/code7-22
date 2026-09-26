import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { config } from "./config";

let s3Client: S3Client | undefined;

/** Lazily create the S3 client the first time a job actually needs it. */
export function getS3(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY,
        secretAccessKey: config.S3_SECRET_KEY
      }
    });
  }
  return s3Client;
}

export async function readQuarantineObject(key: string): Promise<Buffer> {
  const response = await getS3().send(new GetObjectCommand({
    Bucket: config.S3_QUARANTINE_BUCKET,
    Key: key
  }));
  if (!response.Body) throw new Error("Object body is empty");
  return Buffer.from(await response.Body.transformToByteArray());
}

export async function writeQuarantineObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await getS3().send(new PutObjectCommand({
    Bucket: config.S3_QUARANTINE_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: "private, max-age=0"
  }));
}

export async function copyToPublic(processedKey: string, publicKey: string): Promise<void> {
  await getS3().send(new CopyObjectCommand({
    Bucket: config.S3_PUBLIC_BUCKET,
    Key: publicKey,
    CopySource: `${config.S3_QUARANTINE_BUCKET}/${processedKey}`,
    MetadataDirective: "COPY"
  }));
}

export async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await getS3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  await getS3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
