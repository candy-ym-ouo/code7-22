import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config";

const credentials = {
  accessKeyId: config.S3_ACCESS_KEY,
  secretAccessKey: config.S3_SECRET_KEY
};

let internalClient: S3Client | undefined;
let publicClient: S3Client | undefined;

/** Lazily create S3 clients the first time a request needs them. */
export function getInternalS3(): S3Client {
  if (!internalClient) {
    internalClient = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials
    });
  }
  return internalClient;
}

export function getPublicS3(): S3Client {
  if (!publicClient) {
    publicClient = new S3Client({
      endpoint: config.S3_PUBLIC_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials
    });
  }
  return publicClient;
}

export async function createPreviewUrl(key: string, expiresIn = 600): Promise<string> {
  return getSignedUrl(
    getPublicS3(),
    new GetObjectCommand({
      Bucket: config.S3_QUARANTINE_BUCKET,
      Key: key
    }),
    { expiresIn }
  );
}

export async function createUploadUrl(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    getPublicS3(),
    new PutObjectCommand({
      Bucket: config.S3_QUARANTINE_BUCKET,
      Key: key,
      ContentType: contentType
    }),
    { expiresIn: 10 * 60 }
  );
}

export async function getQuarantineMetadata(key: string) {
  return getInternalS3().send(new HeadObjectCommand({
    Bucket: config.S3_QUARANTINE_BUCKET,
    Key: key
  }));
}

export async function readQuarantineObject(key: string): Promise<Buffer> {
  const response = await getInternalS3().send(new GetObjectCommand({
    Bucket: config.S3_QUARANTINE_BUCKET,
    Key: key
  }));
  if (!response.Body) throw new Error("Object body is empty");
  return Buffer.from(await response.Body.transformToByteArray());
}

export async function publishMediaObject(processedKey: string, publicKey: string): Promise<void> {
  await getInternalS3().send(new CopyObjectCommand({
    Bucket: config.S3_PUBLIC_BUCKET,
    Key: publicKey,
    CopySource: `${config.S3_QUARANTINE_BUCKET}/${processedKey}`,
    MetadataDirective: "REPLACE",
    ContentType: "image/webp",
    CacheControl: "public, max-age=31536000, immutable"
  }));
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  await getInternalS3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export function publicMediaUrl(key: string | null | undefined): string | null {
  return key ? `${config.PUBLIC_MEDIA_BASE_URL.replace(/\/$/, "")}/${key}` : null;
}
