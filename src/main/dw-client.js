"use strict";
/**
 * Dragon Wind Server Client
 *
 * Thin wrapper around the Dragon Wind HTTP API.
 * Handles auth and the new multipart endpoint we'll add server-side.
 */

const https = require("https");
const http  = require("http");

class DragonWindClient {
  constructor(serverUrl) {
    this.serverUrl = serverUrl.replace(/\/$/, "");
    this.token     = null;
  }

  setToken(token) { this.token = token; }

  // ── Auth ────────────────────────────────────────────────────────────────────

  async login(username, password) {
    try {
      const res = await this._request("POST", "/api/login", { username, password });
      if (res.token) {
        this.token = res.token;
        return { success: true, token: res.token, role: res.role };
      }
      return { success: false, error: res.error || "Login failed" };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── Folders ─────────────────────────────────────────────────────────────────

  async getFolders() {
    try {
      const res = await this._request("GET", "/api/folders");
      return { success: true, tree: res.tree || [] };
    } catch (err) {
      return { success: false, error: err.message, tree: [] };
    }
  }

  // ── Multipart Upload ─────────────────────────────────────────────────────────
  //
  // Requests presigned URLs for every part in one shot.
  // Server endpoint: POST /api/desktop/multipart/init
  // Returns: { uploadId, key, bucket, presignedParts: [url, url, ...] }

  async initMultipart({ filename, size, prefix, totalParts }) {
    try {
      const res = await this._request("POST", "/api/desktop/multipart/init", {
        filename, size, prefix, totalParts,
      });
      if (res.uploadId) return { success: true, ...res };
      return { success: false, error: res.error || "Init failed" };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async completeMultipart({ uploadId, key, bucket, parts }) {
    try {
      const res = await this._request("POST", "/api/desktop/multipart/complete", {
        uploadId, key, bucket, parts,
      });
      if (res.success) return { success: true };
      return { success: false, error: res.error || "Complete failed" };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async abortMultipart({ uploadId, key, bucket }) {
    try {
      await this._request("POST", "/api/desktop/multipart/abort", { uploadId, key, bucket });
    } catch (_) {}
  }

  // ── HTTP helper ──────────────────────────────────────────────────────────────

  _request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const full    = new URL(this.serverUrl + urlPath);
      const isHttps = full.protocol === "https:";
      const lib     = isHttps ? https : http;

      const payload = body ? JSON.stringify(body) : null;
      const options = {
        hostname: full.hostname,
        port:     full.port || (isHttps ? 443 : 80),
        path:     full.pathname + full.search,
        method,
        headers: {
          "Content-Type":  "application/json",
          "Accept":        "application/json",
          ...(this.token ? { "x-auth-token": this.token } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        rejectUnauthorized: false,  // allow self-signed for internal deployments
      };

      const req = lib.request(options, (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
            else reject(new Error(json.error || `HTTP ${res.statusCode}`));
          } catch (e) {
            reject(new Error(`Parse error: ${data.slice(0, 100)}`));
          }
        });
      });

      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = { DragonWindClient };
