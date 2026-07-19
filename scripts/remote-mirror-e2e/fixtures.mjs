import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function createRunArtifactDir(root = '.artifacts/remote-mirror-v2') {
  const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = join(process.cwd(), root, runId);
  await mkdir(dir, { recursive: true });
  return { runId, dir };
}

export async function createIsolatedProfile(label) {
  const dir = await mkdtemp(join(tmpdir(), `enso-mirror-${label}-`));
  return {
    dir,
    env: {
      ENSOAI_PROFILE: `mirror-e2e-${label}-${randomBytes(4).toString('hex')}`,
      ENSO_REMOTE_MIRROR_TEST: '1',
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function writeSummary(dir, summary) {
  const path = join(dir, 'summary.json');
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return path;
}

export async function appendMetric(dir, sample) {
  const path = join(dir, 'metrics.ndjson');
  await writeFile(path, `${JSON.stringify(sample)}\n`, { flag: 'a' });
  return path;
}

export function assertNoSecrets(text) {
  const banned = /(token|private_key|BEGIN [A-Z ]+PRIVATE KEY|password=|Authorization:)/i;
  if (banned.test(text)) {
    throw new Error('artifact contains sensitive material');
  }
}
