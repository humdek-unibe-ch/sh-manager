// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Runtime-service (mysql/redis/mercure) image resolution for an update + the
 * one-way MySQL major-upgrade gate (data volume always preserved).
 */
import type { RuntimeServicePolicy } from '@shm/schemas';

export interface RuntimeServiceImages {
  mysql: string;
  redis: string;
  mercure: string;
}

/**
 * Resolve the target runtime-service images for an update. Prefer the target
 * core's `runtime` recommended images (so a release can move MySQL/Redis/Mercure
 * forward), and fall back to the instance's CURRENT images when the target core
 * declares no runtime policy (never silently reset to manager defaults).
 */
export function resolveTargetRuntimeImages(
  runtime: RuntimeServicePolicy | undefined,
  current: RuntimeServiceImages,
): RuntimeServiceImages {
  return {
    mysql: runtime?.mysql.recommendedImage ?? current.mysql,
    redis: runtime?.redis.recommendedImage ?? current.redis,
    mercure: runtime?.mercure.recommendedImage ?? current.mercure,
  };
}

/**
 * Best-effort major-version parse from a docker image reference such as
 * `mysql:8.4`, `mysql:8.4.1`, or `mysql:8.4@sha256:...`. Returns null when the
 * tag is missing or not numeric (e.g. a bare digest pin).
 */
export function imageMajor(image: string): number | null {
  const beforeDigest = image.split('@', 1)[0] ?? image;
  const colon = beforeDigest.lastIndexOf(':');
  if (colon < 0) return null;
  const tag = beforeDigest.slice(colon + 1);
  const major = Number.parseInt(tag.split('.', 1)[0] ?? '', 10);
  return Number.isFinite(major) ? major : null;
}

export interface MysqlMajorUpgradeDecision {
  isMajorUpgrade: boolean;
  requiresApproval: boolean;
  fromMajor: number | null;
  toMajor: number | null;
}

/**
 * Decide whether a MySQL image change is a major-version upgrade and whether the
 * target core's policy demands explicit operator approval. The data volume is
 * always preserved, but a major MySQL jump is effectively one-way, so a release
 * can require a deliberate opt-in (plus a verified backup).
 */
export function evaluateMysqlMajorUpgrade(
  runtime: RuntimeServicePolicy | undefined,
  currentMysqlImage: string,
  targetMysqlImage: string,
): MysqlMajorUpgradeDecision {
  const fromMajor = imageMajor(currentMysqlImage);
  const toMajor = imageMajor(targetMysqlImage);
  const isMajorUpgrade = fromMajor !== null && toMajor !== null && toMajor > fromMajor;
  const requiresApproval = isMajorUpgrade && (runtime?.mysql.majorUpgradeRequiresManualApproval ?? false);
  return { isMajorUpgrade, requiresApproval, fromMajor, toMajor };
}
