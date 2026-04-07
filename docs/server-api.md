# Dragon Wind Desktop — Server API Additions

These three endpoints need to be added to `server.js` in the VPM-Uploader repo to support the desktop client.

## POST /api/desktop/multipart/init

Auth: `x-auth-token` header required.

Request:
```json
{
  "filename": "A001C001.mxf",
  "size": 10737418240,
  "prefix": "Jobs/2026-04-06",
  "totalParts": 640
}
```

Response:
```json
{
  "uploadId": "abc123...",
  "key": "Jobs/2026-04-06/A001C001.mxf",
  "bucket": "vpm-media",
  "presignedParts": [
    "https://s3.example.com/vpm-media/Jobs/...",
    "..."
  ]
}
```

Implementation notes:
- Call `s3.createMultipartUpload({ Bucket, Key })`
- For each part 1..totalParts, call `getSignedUrl(s3, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: i }), { expiresIn: 3600 })`
- Return all presigned URLs in order
- Store `{ uploadId, key, bucket, userId }` in memory for completion validation

## POST /api/desktop/multipart/complete

Auth: `x-auth-token` required.

Request:
```json
{
  "uploadId": "abc123...",
  "key": "Jobs/2026-04-06/A001C001.mxf",
  "bucket": "vpm-media",
  "parts": [
    { "PartNumber": 1, "ETag": "\"abc\"" },
    { "PartNumber": 2, "ETag": "\"def\"" }
  ]
}
```

Response:
```json
{ "success": true }
```

Implementation notes:
- Call `s3.completeMultipartUpload({ Bucket, Key, UploadId, MultipartUpload: { Parts: parts } })`
- Update user uploadedBytes stat

## POST /api/desktop/multipart/abort

Auth: `x-auth-token` required.

Request:
```json
{
  "uploadId": "abc123...",
  "key": "Jobs/2026-04-06/A001C001.mxf",
  "bucket": "vpm-media"
}
```

Response:
```json
{ "success": true }
```

## Sample Express implementation

```js
// Add to server.js after existing /api/udp routes

const { UploadPartCommand, CreateMultipartUploadCommand,
        CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const desktopSessions = new Map(); // uploadId → { key, bucket, userId }

app.post('/api/desktop/multipart/init', requireAuth, async (req, res) => {
  const { filename, size, prefix, totalParts } = req.body;
  if (!filename || !size || !totalParts) return res.status(400).json({ error: 'Missing fields' });
  const cfg = getConfig();
  if (!cfg.bucket) return res.status(503).json({ error: 'S3 not configured' });

  const key = prefix ? `${prefix.replace(/\/+$/, '')}/${filename}` : filename;

  try {
    const create = await s3Client.send(new CreateMultipartUploadCommand({ Bucket: cfg.bucket, Key: key }));
    const uploadId = create.UploadId;

    const presignedParts = await Promise.all(
      Array.from({ length: totalParts }, (_, i) =>
        getSignedUrl(s3Client, new UploadPartCommand({
          Bucket: cfg.bucket, Key: key, UploadId: uploadId, PartNumber: i + 1,
        }), { expiresIn: 3600 })
      )
    );

    desktopSessions.set(uploadId, { key, bucket: cfg.bucket, userId: req.user.username });
    res.json({ uploadId, key, bucket: cfg.bucket, presignedParts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/desktop/multipart/complete', requireAuth, async (req, res) => {
  const { uploadId, key, bucket, parts } = req.body;
  if (!uploadId || !parts) return res.status(400).json({ error: 'Missing fields' });
  try {
    await s3Client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber) },
    }));
    desktopSessions.delete(uploadId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/desktop/multipart/abort', requireAuth, async (req, res) => {
  const { uploadId, key, bucket } = req.body;
  try {
    await s3Client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
    desktopSessions.delete(uploadId);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: true }); // best-effort
  }
});
```
