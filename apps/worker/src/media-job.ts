import type { PrivacyRegion } from "@map/shared/contracts";
import { createLogger } from "@map/shared/logging";
import { config } from "./config";
import { getPool } from "./db";
import { deleteObject, objectExists, readQuarantineObject, writeQuarantineObject, copyToPublic } from "./storage";
import { scanForMalware } from "./clamav";
import { processPrivacyImage } from "./privacy";

const logger = createLogger({ app: "worker" });

export async function processMediaJob(mediaId: string): Promise<void> {
  const result = await getPool().query<{
    id: string;
    privacy_status: string;
    quarantine_object_key: string;
    privacy_report: { manualRegions?: PrivacyRegion[] } | null;
  }>(
    `SELECT id, privacy_status, quarantine_object_key, privacy_report
     FROM media_assets WHERE id = $1 AND deleted_at IS NULL`,
    [mediaId]
  );
  const media = result.rows[0];
  if (!media) throw new Error("Media record not found");
  if (!["processing", "failed"].includes(media.privacy_status)) {
    logger.debug({ mediaId, status: media.privacy_status }, "skip media: unexpected status");
    return;
  }

  const autoPublish = Boolean(config.PRIVACY_DETECTOR_URL);
  const publicKey = `media/${mediaId}.webp`;
  const publicThumbnailKey = `media/${mediaId}.thumb.webp`;

  try {
    await getPool().query("UPDATE media_assets SET privacy_status = 'scanning', updated_at = now() WHERE id = $1", [mediaId]);
    const source = await readQuarantineObject(media.quarantine_object_key);
    await scanForMalware(source);

    await getPool().query("UPDATE media_assets SET privacy_status = 'processing', updated_at = now() WHERE id = $1", [mediaId]);
    const manualRegions = media.privacy_report?.manualRegions ?? [];
    const processed = await processPrivacyImage(source, manualRegions);

    const processedKey = `processed/${mediaId}.webp`;
    const thumbnailKey = `processed/${mediaId}.thumb.webp`;
    await writeQuarantineObject(processedKey, processed.image, "image/webp");
    await writeQuarantineObject(thumbnailKey, processed.thumbnail, "image/webp");

    if (autoPublish) {
      await copyToPublic(processedKey, publicKey);
      await copyToPublic(thumbnailKey, publicThumbnailKey);
    }

    const report = {
      manualRegions: processed.manualRegions,
      detectorRegions: processed.detectorRegions,
      detectorConfigured: autoPublish,
      originalMetadataRemoved: true,
      serverReencoded: true,
      width: processed.width,
      height: processed.height,
      sha256: processed.sha256,
      perceptualHash: processed.perceptualHash,
      completedAt: new Date().toISOString()
    };

    await getPool().query(
      `UPDATE media_assets
       SET privacy_status = $2,
           processed_object_key = $3,
           thumbnail_object_key = $4,
           public_object_key = $5,
           public_thumbnail_object_key = $12,
           width = $6,
           height = $7,
           sha256 = $8,
           perceptual_hash = $9,
           privacy_report = $10::jsonb,
           failure_code = NULL,
           processed_at = now(),
           delete_after = now() + ($11::text || ' hours')::interval,
           updated_at = now()
       WHERE id = $1`,
      [
        mediaId,
        autoPublish ? "ready" : "manual_review",
        processedKey,
        thumbnailKey,
        autoPublish ? publicKey : null,
        processed.width,
        processed.height,
        processed.sha256,
        processed.perceptualHash,
        JSON.stringify(report),
        String(config.ORIGINAL_RETENTION_HOURS),
        autoPublish ? publicThumbnailKey : null
      ]
    );

    logger.info({ mediaId, privacyStatus: autoPublish ? "ready" : "manual_review" }, "media processed");
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown media processing error";
    await getPool().query(
      `UPDATE media_assets
       SET privacy_status = 'failed', failure_code = $2,
           delete_after = now() + interval '7 days', updated_at = now()
       WHERE id = $1`,
      [mediaId, message]
    );
    if (autoPublish) {
      await Promise.allSettled([
        deleteObject(config.S3_PUBLIC_BUCKET, publicKey),
        deleteObject(config.S3_PUBLIC_BUCKET, publicThumbnailKey)
      ]);
    }
    throw error;
  }
}

export async function cleanupOriginalMedia(): Promise<void> {
  const abandoned = await getPool().query<{ id: string; quarantine_object_key: string }>(
    `SELECT id, quarantine_object_key FROM media_assets
     WHERE privacy_status = 'quarantined'
       AND created_at < now() - interval '24 hours'
       AND deleted_at IS NULL
     LIMIT 50`
  );
  for (const row of abandoned.rows) {
    try {
      if (await objectExists(config.S3_QUARANTINE_BUCKET, row.quarantine_object_key)) {
        await deleteObject(config.S3_QUARANTINE_BUCKET, row.quarantine_object_key);
      }
      await getPool().query(
        `UPDATE media_assets
         SET privacy_status = 'deleted', deleted_at = now(), updated_at = now()
         WHERE id = $1`,
        [row.id]
      );
    } catch (error) {
      logger.error({ mediaId: row.id, err: error }, "failed to clean abandoned upload");
    }
  }

  const result = await getPool().query<{ id: string; quarantine_object_key: string }>(
    `SELECT id, quarantine_object_key FROM media_assets
     WHERE delete_after IS NOT NULL AND delete_after <= now()
       AND quarantine_object_key IS NOT NULL
       AND privacy_status IN ('ready', 'manual_review', 'rejected', 'failed', 'deleted')
     LIMIT 50`
  );
  for (const row of result.rows) {
    try {
      if (await objectExists(config.S3_QUARANTINE_BUCKET, row.quarantine_object_key)) {
        await deleteObject(config.S3_QUARANTINE_BUCKET, row.quarantine_object_key);
      }
      await getPool().query("UPDATE media_assets SET delete_after = NULL, updated_at = now() WHERE id = $1", [row.id]);
    } catch (error) {
      logger.error({ mediaId: row.id, err: error }, "failed to clean original media");
    }
  }
}

export async function markStaleFeatures(): Promise<void> {
  await getPool().query(
    `UPDATE map_features
     SET needs_review_at = COALESCE(needs_review_at, now()), updated_at = now()
     WHERE status = 'published' AND freshness_expires_at <= now() AND needs_review_at IS NULL`
  );
}

export async function recoverStuckMedia(): Promise<string[]> {
  const result = await getPool().query<{ id: string }>(
    `UPDATE media_assets
     SET privacy_status = 'processing', failure_code = 'Recovered after worker timeout', updated_at = now()
     WHERE privacy_status IN ('scanning', 'processing')
       AND updated_at < now() - interval '20 minutes'
       AND deleted_at IS NULL
     RETURNING id`
  );
  return result.rows.map((row) => row.id);
}

export async function cleanupDeletedMediaObjects(): Promise<void> {
  const result = await getPool().query<{
    id: string;
    quarantine_object_key: string;
    processed_object_key: string | null;
    thumbnail_object_key: string | null;
    public_object_key: string | null;
    public_thumbnail_object_key: string | null;
  }>(
    `SELECT id, quarantine_object_key, processed_object_key, thumbnail_object_key,
            public_object_key, public_thumbnail_object_key
     FROM media_assets
     WHERE privacy_status = 'deleted'
       AND (quarantine_object_key NOT LIKE 'deleted/%'
         OR processed_object_key IS NOT NULL
         OR thumbnail_object_key IS NOT NULL
         OR public_object_key IS NOT NULL
         OR public_thumbnail_object_key IS NOT NULL)
     LIMIT 50`
  );

  for (const item of result.rows) {
    try {
      const removals: Array<Promise<void>> = [];
      if (!item.quarantine_object_key.startsWith("deleted/")) {
        removals.push(deleteObject(config.S3_QUARANTINE_BUCKET, item.quarantine_object_key));
      }
      if (item.processed_object_key) removals.push(deleteObject(config.S3_QUARANTINE_BUCKET, item.processed_object_key));
      if (item.thumbnail_object_key) removals.push(deleteObject(config.S3_QUARANTINE_BUCKET, item.thumbnail_object_key));
      if (item.public_object_key) removals.push(deleteObject(config.S3_PUBLIC_BUCKET, item.public_object_key));
      if (item.public_thumbnail_object_key) removals.push(deleteObject(config.S3_PUBLIC_BUCKET, item.public_thumbnail_object_key));
      await Promise.all(removals);

      await getPool().query(
        `UPDATE media_assets
         SET quarantine_object_key = $2,
             processed_object_key = NULL,
             thumbnail_object_key = NULL,
             public_object_key = NULL,
             public_thumbnail_object_key = NULL,
             delete_after = NULL,
             updated_at = now()
         WHERE id = $1`,
        [item.id, `deleted/${item.id}.object`]
      );
    } catch (error) {
      logger.error({ mediaId: item.id, err: error }, "failed to clean deleted media objects");
    }
  }
}

export async function markUnreferencedMediaDeleted(): Promise<void> {
  await getPool().query(
    `UPDATE media_assets ma
     SET privacy_status = 'deleted', deleted_at = now(), updated_at = now()
     WHERE ma.deleted_at IS NULL
       AND ma.created_at < now() - interval '7 days'
       AND NOT EXISTS (
         SELECT 1 FROM revision_media rm WHERE rm.media_id = ma.id
       )`
  );
}
