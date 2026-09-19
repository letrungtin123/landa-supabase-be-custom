import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env.js';
import {
  buildFileName,
  buildLessonAuthorPrivateStoragePath,
  deleteLessonAuthorPrivateFiles,
  downloadLessonAuthorPrivateFileToTemp,
  uploadLessonAuthorPrivateFileFromPath,
} from '../../config/storage.js';
import { getGeminiClient, transcribeAudioFile } from './gemini.service.js';
import {
  claimDueLessonAuthorTranscriptionJobs,
  completeLessonAuthorTranscriptionJob,
  failLessonAuthorTranscriptionJob,
  expireLessonAuthorTranscriptionJobs,
  renewLessonAuthorTranscriptionLease,
  syncLessonAuthorTranscriptMessage,
  type LessonAuthorTranscriptionJob,
} from './lesson-author-transcription.service.js';
import {
  LESSON_AUTHOR_TRANSCRIPT_MIME_TYPE,
  normalizeTranscriptText,
} from './lesson-author-transcription.logic.js';

const execFile = promisify(execFileCallback);
const FFMPEG_TIMEOUT_MS = 30 * 60_000;
const TEMP_ARTIFACT_MAX_AGE_MS = 12 * 60 * 60_000;
let drainInFlight = false;

type MediaProbe = {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string }>;
};

function workerLocale(job: LessonAuthorTranscriptionJob): 'vi' | 'en' {
  return job.requested_locale === 'en' ? 'en' : 'vi';
}

function safeWorkerError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || 'Không thể tạo bản chép lời.');
  return raw.replace(/[\r\n]+/g, ' ').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]').slice(0, 500);
}

async function assertLease(job: LessonAuthorTranscriptionJob): Promise<void> {
  if (!job.lease_token || !(await renewLessonAuthorTranscriptionLease(job.id, job.lease_token))) {
    throw new Error('Transcription job lease bị mất.');
  }
}

async function probeVideo(filePath: string): Promise<number> {
  const { stdout } = await execFile(env.FFPROBE_PATH, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', filePath,
  ], { timeout: FFMPEG_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 });
  const probe = JSON.parse(stdout) as MediaProbe;
  const duration = Number.parseFloat(probe.format?.duration || '');
  if (!Number.isFinite(duration) || duration <= 0 || duration > env.LESSON_AUTHOR_VIDEO_MAX_DURATION_SECONDS) {
    throw new Error('Video không có thời lượng hợp lệ hoặc vượt giới hạn cho phép.');
  }
  if (!probe.streams?.some(stream => stream.codec_type === 'audio')) {
    throw new Error('Video không có audio track để tạo bản chép lời.');
  }
  return duration;
}

async function extractAudio(videoPath: string, outputPath: string): Promise<void> {
  await execFile(env.FFMPEG_PATH, [
    '-nostdin', '-y', '-i', videoPath,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', outputPath,
  ], { timeout: FFMPEG_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 });
}

/** Remove only stale crash residue; active jobs can run for several hours. */
async function cleanupStaleTempArtifacts(): Promise<void> {
  const directories = [
    env.LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR,
    path.resolve(env.LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR, 'uploads'),
  ];
  const cutoff = Date.now() - TEMP_ARTIFACT_MAX_AGE_MS;
  for (const directory of directories) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async entry => {
      if (!entry.isFile()) return;
      const filePath = path.resolve(directory, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await fs.unlink(filePath).catch(() => undefined);
    }));
  }
}

async function processJob(job: LessonAuthorTranscriptionJob): Promise<void> {
  let videoTempPath: string | null = null;
  let audioTempPath: string | null = null;
  let transcriptTempPath: string | null = null;
  let transcriptStoragePath: string | null = null;
  try {
    if (!job.lease_token || !job.source_storage_path) throw new Error('Transcript job không còn video nguồn.');
    await syncLessonAuthorTranscriptMessage(job, workerLocale(job));
    await fs.mkdir(env.LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR, { recursive: true });
    videoTempPath = await downloadLessonAuthorPrivateFileToTemp(job.source_storage_path, env.LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR);
    await assertLease(job);
    await probeVideo(videoTempPath);

    audioTempPath = path.resolve(env.LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR, `${job.id}.mp3`);
    await extractAudio(videoTempPath, audioTempPath);
    await assertLease(job);

    const transcript = normalizeTranscriptText(
      await transcribeAudioFile(audioTempPath, await getGeminiClient(job.tenant_id)),
      env.LESSON_AUTHOR_TRANSCRIPT_MAX_CHARS,
    );
    await assertLease(job);

    transcriptTempPath = path.resolve(env.LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR, `${job.id}.transcript.txt`);
    await fs.writeFile(transcriptTempPath, `${transcript}\n`, 'utf8');
    transcriptStoragePath = buildLessonAuthorPrivateStoragePath(
      job.tenant_id,
      'transcripts',
      `${job.id}-${buildFileName(job.transcript_file_name)}`,
    );
    await uploadLessonAuthorPrivateFileFromPath(transcriptStoragePath, transcriptTempPath, LESSON_AUTHOR_TRANSCRIPT_MIME_TYPE);
    await assertLease(job);

    const completed = await completeLessonAuthorTranscriptionJob({
      jobId: job.id,
      leaseToken: job.lease_token,
      transcriptStoragePath,
      transcriptLanguage: null,
      transcriptCharCount: transcript.length,
      expiresAt: new Date(Date.now() + env.LESSON_AUTHOR_TRANSCRIPT_RETENTION_HOURS * 60 * 60 * 1000),
    });
    if (!completed) {
      await deleteLessonAuthorPrivateFiles([transcriptStoragePath]).catch(() => undefined);
      return;
    }
    transcriptStoragePath = null;
    await deleteLessonAuthorPrivateFiles([job.source_storage_path]).catch(() => undefined);
    await syncLessonAuthorTranscriptMessage(completed, workerLocale(completed));
  } catch (error) {
    if (transcriptStoragePath) await deleteLessonAuthorPrivateFiles([transcriptStoragePath]).catch(() => undefined);
    if (job.lease_token) {
      const failed = await failLessonAuthorTranscriptionJob({
        jobId: job.id,
        leaseToken: job.lease_token,
        reason: safeWorkerError(error),
      });
      if (failed) await syncLessonAuthorTranscriptMessage(failed, workerLocale(failed));
    }
    console.error('[LessonAuthorTranscription] job failed', { job_id: job.id, error: safeWorkerError(error) });
  } finally {
    await Promise.all([videoTempPath, audioTempPath, transcriptTempPath]
      .filter((value): value is string => Boolean(value))
      .map(filePath => fs.unlink(filePath).catch(() => undefined)));
  }
}

async function drain(): Promise<void> {
  if (drainInFlight || !env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED) return;
  drainInFlight = true;
  try {
    await expireLessonAuthorTranscriptionJobs();
    const jobs = await claimDueLessonAuthorTranscriptionJobs();
    for (let index = 0; index < jobs.length; index += env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_CONCURRENCY) {
      await Promise.all(jobs.slice(index, index + env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_CONCURRENCY).map(processJob));
    }
  } catch (error) {
    console.error('[LessonAuthorTranscription] worker drain failed', safeWorkerError(error));
  } finally {
    drainInFlight = false;
  }
}

export async function startLessonAuthorTranscriptionWorker(): Promise<void> {
  if (!env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED) {
    console.log('[LessonAuthorTranscription] worker disabled');
    return;
  }
  await cleanupStaleTempArtifacts();
  await drain();
  setInterval(() => { void drain(); }, env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_POLL_INTERVAL_MS).unref();
  setInterval(() => { void cleanupStaleTempArtifacts(); }, 6 * 60 * 60_000).unref();
  console.log('[LessonAuthorTranscription] durable worker started');
}
