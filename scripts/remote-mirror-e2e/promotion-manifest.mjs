import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function hashFile(path) {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

export async function buildPromotionManifest(options = {}) {
  const artifactRoot = options.artifactRoot ?? join(process.cwd(), '.artifacts/remote-mirror-v2');
  const entries = await readdir(artifactRoot).catch(() => []);
  const runs = [];
  for (const name of entries) {
    const summaryPath = join(artifactRoot, name, 'summary.json');
    try {
      await stat(summaryPath);
      const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
      runs.push({
        runId: name,
        summaryHash: await hashFile(summaryPath),
        result: summary.result ?? summary.status ?? 'unknown',
        scope: summary.scope ?? [],
      });
    } catch {
      // skip incomplete dirs
    }
  }

  const requiredScopes = ['P12', 'P13', 'P14', 'P15'];
  const present = new Set(runs.flatMap((run) => run.scope));
  const missing = requiredScopes.filter((scope) => !present.has(scope));
  const failed = runs.filter((run) => run.result !== 'passed' && run.result !== 'blocked');
  const decision =
    missing.length === 0 && failed.length === 0 && options.forceDefaultOn === true
      ? 'promote-default-on'
      : 'blocked';

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    commit: options.commit ?? process.env.GITHUB_SHA ?? null,
    worktreeDirty: options.worktreeDirty ?? null,
    runs,
    missingScopes: missing,
    failedRuns: failed.map((run) => run.runId),
    securityReviewer: options.securityReviewer ?? 'pending',
    verifier: options.verifier ?? 'pending',
    tailnetValidated: options.tailnetValidated ?? false,
    soak8hValidated: options.soak8hValidated ?? false,
    crossPlatformValidated: options.crossPlatformValidated ?? false,
    decision,
    defaultOnAllowed: decision === 'promote-default-on',
    notes:
      decision === 'blocked'
        ? 'V2 remains default-off until all mandatory release gates have retained evidence.'
        : 'All mandatory gates present; default-on may be flipped by explicit one-line policy change.',
  };

  if (options.outPath) {
    await writeFile(options.outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = await buildPromotionManifest({
    outPath: join(process.cwd(), '.artifacts/remote-mirror-v2/promotion-manifest.json'),
  });
  console.log(JSON.stringify({ decision: manifest.decision, missing: manifest.missingScopes }, null, 2));
  process.exit(manifest.decision === 'promote-default-on' ? 0 : 2);
}
