"use strict";
/**
 * Dragon Wind Transfer Engine
 *
 * High-speed parallel chunked upload engine.
 * Strategy: split each file into chunks, upload chunks concurrently via
 * presigned S3 PUT URLs fetched from the Dragon Wind server.
 * Mirrors how MASV and Aspera achieve WAN saturation.
 *
 *   File → N chunks → parallel presigned PUT → S3 multipart → complete
 *
 * Key knobs:
 *   workers  — max concurrent chunk uploads across all active jobs (default 6)
 *   chunkMb  — chunk size in MB (default 16 MB — tunes for WAN RTT)
 */

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const https  = require("https");
const http   = require("http");

const MIN_PART_SIZE = 5 * 1024 * 1024;  // S3 minimum 5 MB per part

class TransferEngine {
  constructor({ workers = 6, chunkMb = 16, onProgress, onComplete, onError }) {
    this.workers    = workers;
    this.chunkSize  = chunkMb * 1024 * 1024;
    this.onProgress = onProgress || (() => {});
    this.onComplete = onComplete || (() => {});
    this.onError    = onError    || (() => {});

    this.queue      = new Map();   // jobId → job
    this.active     = new Set();   // jobIds currently transferring
    this._stopped   = false;
    this._running   = 0;           // total concurrent chunk uploads
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async enqueue({ file, prefix, dwClient }) {
    const jobId    = crypto.randomBytes(8).toString("hex");
    const filename = path.basename(file);
    const stat     = fs.statSync(file);
    const size     = stat.size;
    const chunkSize = Math.max(this.chunkSize, MIN_PART_SIZE);
    const totalChunks = Math.ceil(size / chunkSize);

    const job = {
      id:           jobId,
      name:         filename,
      file,
      prefix:       prefix || "",
      size,
      chunkSize,
      totalChunks,
      status:       "queued",   // queued | uploading | done | error | cancelled
      uploadedBytes: 0,
      speedBps:     0,
      percent:      0,
      eta:          null,
      error:        null,
      startedAt:    null,
      // internals
      _cancel:      false,
      _dwClient:    dwClient,
      _uploadId:    null,
      _parts:       [],
      _speedSamples: [],
    };

    this.queue.set(jobId, job);
    this._tick();
    return this._publicJob(job);
  }

  cancel(jobId) {
    const job = this.queue.get(jobId);
    if (!job) return;
    job._cancel = true;
    job.status  = "cancelled";
    this.active.delete(jobId);
    this._tick();
  }

  async retry(jobId, dwClient) {
    const job = this.queue.get(jobId);
    if (!job) return { success: false, error: "Job not found" };
    job._cancel        = false;
    job.status         = "queued";
    job.uploadedBytes  = 0;
    job.speedBps       = 0;
    job.percent        = 0;
    job.error          = null;
    job._uploadId      = null;
    job._parts         = [];
    job._speedSamples  = [];
    job._dwClient      = dwClient;
    this._tick();
    return { success: true };
  }

  getQueue() {
    return Array.from(this.queue.values()).map(j => this._publicJob(j));
  }

  getStats() {
    const jobs = Array.from(this.queue.values());
    const totalBps = jobs.filter(j => j.status === "uploading")
                         .reduce((s, j) => s + (j.speedBps || 0), 0);
    return {
      active:   jobs.filter(j => j.status === "uploading").length,
      queued:   jobs.filter(j => j.status === "queued").length,
      done:     jobs.filter(j => j.status === "done").length,
      errors:   jobs.filter(j => j.status === "error").length,
      speedBps: totalBps,
    };
  }

  setWorkers(n)    { this.workers = n; this._tick(); }
  setChunkSize(mb) { this.chunkSize = mb * 1024 * 1024; }
  shutdown()       { this._stopped = true; }

  // ── Internal ────────────────────────────────────────────────────────────────

  _tick() {
    if (this._stopped) return;
    for (const job of this.queue.values()) {
      if (this.active.size >= this.workers) break;
      if (job.status === "queued") {
        this.active.add(job.id);
        this._runJob(job).catch(() => {});
      }
    }
  }

  async _runJob(job) {
    job.status    = "uploading";
    job.startedAt = Date.now();
    const client  = job._dwClient;

    try {
      // 1. Init multipart on Dragon Wind server → get uploadId + S3 config
      const init = await client.initMultipart({
        filename: job.name,
        size:     job.size,
        prefix:   job.prefix,
        totalParts: job.totalChunks,
      });

      if (!init.success) throw new Error(init.error || "Failed to init multipart");

      job._uploadId = init.uploadId;
      const { presignedParts, bucket, key } = init;

      // 2. Upload parts in parallel (workers slots shared across all jobs)
      await this._uploadParts(job, presignedParts);

      if (job._cancel) return;

      // 3. Complete multipart
      const complete = await client.completeMultipart({
        uploadId: job._uploadId,
        key,
        bucket,
        parts: job._parts,
      });

      if (!complete.success) throw new Error(complete.error || "Failed to complete multipart");

      job.status  = "done";
      job.percent = 100;
      this.active.delete(job.id);
      this.onComplete(this._publicJob(job));
    } catch (err) {
      if (job._cancel) return;
      job.status = "error";
      job.error  = err.message;
      this.active.delete(job.id);
      this.onError(this._publicJob(job));
    } finally {
      this._tick();
    }
  }

  async _uploadParts(job, presignedParts) {
    const fd         = fs.openSync(job.file, "r");
    const concurrency = Math.max(1, Math.floor(this.workers / Math.max(1, this.active.size)));

    try {
      let partIdx = 0;
      const inFlight = new Set();

      const launchNext = () => {
        while (inFlight.size < concurrency && partIdx < job.totalChunks && !job._cancel) {
          const i      = partIdx++;
          const offset = i * job.chunkSize;
          const length = Math.min(job.chunkSize, job.size - offset);
          const url    = presignedParts[i];
          const p      = this._uploadPart(fd, offset, length, url, i + 1, job)
            .then(etag => {
              job._parts.push({ PartNumber: i + 1, ETag: etag });
              inFlight.delete(p);
              launchNext();
            })
            .catch(err => {
              inFlight.delete(p);
              if (!job._cancel) throw err;
            });
          inFlight.add(p);
        }
      };

      launchNext();

      // Wait for all in-flight to finish
      while (inFlight.size > 0) {
        await Promise.race([...inFlight]);
        if (job._cancel) break;
      }
    } finally {
      fs.closeSync(fd);
    }

    // Sort parts by PartNumber for S3 CompleteMultipart
    job._parts.sort((a, b) => a.PartNumber - b.PartNumber);
  }

  async _uploadPart(fd, offset, length, url, partNumber, job) {
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, offset);

    const t0 = Date.now();

    const etag = await this._putRequest(url, buf);  // real ETag from S3

    const elapsed = (Date.now() - t0) / 1000;
    const bps     = length / Math.max(elapsed, 0.001);

    // Rolling speed average (last 5 parts)
    job._speedSamples.push(bps);
    if (job._speedSamples.length > 5) job._speedSamples.shift();
    job.speedBps = job._speedSamples.reduce((a, b) => a + b, 0) / job._speedSamples.length;

    job.uploadedBytes += length;
    job.percent = Math.round((job.uploadedBytes / job.size) * 100);

    const remaining = job.size - job.uploadedBytes;
    job.eta = job.speedBps > 0 ? Math.round(remaining / job.speedBps) : null;

    this.onProgress(this._publicJob(job));
    return etag;
  }

  _putRequest(url, body) {
    return new Promise((resolve, reject) => {
      const parsed   = new URL(url);
      const isHttps  = parsed.protocol === "https:";
      const lib      = isHttps ? https : http;
      const options  = {
        hostname: parsed.hostname,
        port:     parsed.port || (isHttps ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   "PUT",
        headers:  {
          "Content-Length": body.length,
          "Content-Type":   "application/octet-stream",
        },
      };

      const req = lib.request(options, (res) => {
        const etag = res.headers["etag"] || "";
        res.resume();  // drain
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(etag);
          else reject(new Error(`S3 PUT failed: ${res.statusCode}`));
        });
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  _publicJob(job) {
    return {
      id:            job.id,
      name:          job.name,
      size:          job.size,
      prefix:        job.prefix,
      status:        job.status,
      uploadedBytes: job.uploadedBytes,
      speedBps:      job.speedBps,
      percent:       job.percent,
      eta:           job.eta,
      error:         job.error,
    };
  }
}

module.exports = { TransferEngine };
