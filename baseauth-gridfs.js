const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');
const { Client } = require('whatsapp-web.js');
const BaseAuthStrategy = require("whatsapp-web.js/src/authStrategies/BaseAuthStrategy");
const qrcode = require('qrcode');
const escutarGrupos = require('./grupos');

// ======================
// Configurações
// ======================
const MAX_CONCURRENT_CLIENTS = parseInt(process.env.MAX_CONCURRENT_CLIENTS, 10) || 5;
const SAVE_INTERVAL_MS = parseInt(process.env.SAVE_INTERVAL_MS, 10) || 30 * 60 * 1000; // 30 min

// Controle de concorrência
let _activeClientsCount = 0;
const _pendingQueue = [];

async function _runWithLimit(fn) {
  if (_activeClientsCount >= MAX_CONCURRENT_CLIENTS) {
    return new Promise((resolve, reject) => {
      _pendingQueue.push({ fn, resolve, reject });
    });
  }
  _activeClientsCount++;
  try {
    return await fn();
  } finally {
    _activeClientsCount--;
    if (_pendingQueue.length > 0) {
      const job = _pendingQueue.shift();
      _runWithLimit(job.fn).then(job.resolve).catch(job.reject);
    }
  }
}

// Cache global para buckets
const bucketCache = new Map();

// ======================
// GridFSAuthStrategy
// ======================
class GridFSAuthStrategy extends BaseAuthStrategy {
  constructor(options = {}) {
    super();
    this.clientId = options.clientId;
    this.dataPath = options.dataPath || path.join(__dirname, '.wwebjs_gridfs');
    this.userDataDir = path.join(this.dataPath, this.clientId);
    this.bucket = null;
    this.sessionRestored = false;

    this.fileCache = new Map();
    this.lastSaveTime = 0;
    this.saveThrottleMs = 30 * 1000; // 30s mínimo entre saves

    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }
  }

  initGridFS() {
    const cacheKey = `sessions_${this.clientId}`;
    if (bucketCache.has(cacheKey)) {
      this.bucket = bucketCache.get(cacheKey);
      return this.bucket;
    }

    if (!this.bucket && mongoose.connection.readyState === 1) {
      try {
        this.bucket = new GridFSBucket(mongoose.connection.db, {
          bucketName: 'sessions'
        });
        bucketCache.set(cacheKey, this.bucket);
        console.log(`[${this.clientId}] ✅ GridFSBucket inicializado`);
      } catch (error) {
        console.error(`[${this.clientId}] ❌ Erro ao criar GridFSBucket:`, error);
      }
    }
    return this.bucket;
  }

  getCriticalPaths() {
    return {
      dirs: ['Default/IndexedDB'],
      files: ['Default/Preferences', 'Default/Cookies', 'Default/Local State'],
      exts: ['.db', '.sqlite', '.json']
    };
  }

  async readSessionFiles() {
    const { dirs, files, exts } = this.getCriticalPaths();
    const sessionFiles = [];
    const processed = new Set();

    const addFile = (filePath, relativePath) => {
      try {
        if (processed.has(relativePath)) return;
        processed.add(relativePath);

        if (!fs.existsSync(filePath)) return;
        const stats = fs.statSync(filePath);
        if (!stats.isFile() || stats.size === 0) return;

        const isValidExt = exts.some(ext => relativePath.endsWith(ext));
        const isKnownFile = files.some(f => relativePath === f);
        if (!isValidExt && !isKnownFile) return;

        if (stats.size > 50 * 1024 * 1024) {
          console.warn(`[${this.clientId}] Arquivo ignorado (muito grande): ${relativePath}`);
          return;
        }

        const cacheKey = `${relativePath}_${stats.mtime.getTime()}`;
        if (this.fileCache.has(cacheKey)) {
          sessionFiles.push(this.fileCache.get(cacheKey));
          return;
        }

        const data = fs.readFileSync(filePath);
        const fileObj = {
          path: relativePath.replace(/\\/g, '/'),
          data,
          size: data.length,
          mtime: stats.mtime
        };

        this.fileCache.set(cacheKey, fileObj);
        sessionFiles.push(fileObj);
      } catch {}
    };

    const walk = (baseDir) => {
      const fullPath = path.join(this.userDataDir, baseDir);
      if (!fs.existsSync(fullPath)) return;
      try {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(fullPath, entry.name);
          const relativePath = path.relative(this.userDataDir, entryPath);
          if (entry.isFile()) addFile(entryPath, relativePath);
          else if (entry.isDirectory() && entry.name !== 'Code Cache') {
            if (relativePath.split('/').length <= 3) walk(relativePath);
          }
        }
      } catch {}
    };

    for (const dir of dirs) walk(dir);
    for (const file of files) addFile(path.join(this.userDataDir, file), file);

    return sessionFiles;
  }

  async restoreSessionFiles(files) {
    if (!files || files.length === 0) return;
    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      await Promise.all(batch.map(async (file) => {
        try {
          const fullPath = path.join(this.userDataDir, file.path);
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
          fs.writeFileSync(fullPath, buffer);
        } catch {}
      }));
    }
  }

  async saveSession() {
    try {
      const now = Date.now();
      if (now - this.lastSaveTime < this.saveThrottleMs) return false;
      this.lastSaveTime = now;

      const bucket = this.initGridFS();
      if (!bucket) return false;

      const sessionFiles = await this.readSessionFiles();
      if (sessionFiles.length === 0) return false;

      await this.deleteExistingSession();

      const batchSize = 5;
      for (let i = 0; i < sessionFiles.length; i += batchSize) {
        const batch = sessionFiles.slice(i, i + batchSize);
        await Promise.all(batch.map((file, index) => {
          const filename = `${this.clientId}_${file.path.replace(/[/\\]/g, '_')}`;
          return new Promise((resolve, reject) => {
            const upload = bucket.openUploadStream(filename, {
              metadata: {
                clientId: this.clientId,
                originalPath: file.path,
                fileIndex: index,
                mtime: file.mtime,
                sessionVersion: now
              }
            });
            upload.on('finish', () => resolve(upload.id));
            upload.on('error', reject);
            upload.end(file.data);
          });
        }));
      }

      console.log(`[${this.clientId}] ✅ Sessão salva (${sessionFiles.length} arquivos)`);
      return true;
    } catch (error) {
      console.error(`[${this.clientId}] ❌ Erro ao salvar sessão:`, error);
      return false;
    }
  }

  async deleteExistingSession() {
    try {
      const bucket = this.initGridFS();
      if (!bucket) return;
      const files = await bucket.find({ 'metadata.clientId': this.clientId }).toArray();
      await Promise.all(files.map(f => bucket.delete(f._id).catch(() => {})));
    } catch {}
  }

  async loadSession() {
    try {
      const bucket = this.initGridFS();
      if (!bucket) return [];
      const files = await bucket.find({ 'metadata.clientId': this.clientId })
        .sort({ 'metadata.fileIndex': 1 }).toArray();
      if (files.length === 0) return [];

      const sessionFiles = [];
      for (const file of files) {
        const chunks = [];
        const stream = bucket.openDownloadStream(file._id);
        await new Promise((resolve, reject) => {
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', resolve);
          stream.on('error', reject);
        });
        const data = Buffer.concat(chunks);
        sessionFiles.push({
          path: file.metadata.originalPath,
          data,
          size: data.length,
          mtime: file.metadata.mtime
        });
      }
      return sessionFiles;
    } catch {
      return [];
    }
  }

  async beforeBrowserInitialized() {
    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }

    let retries = 0;
    while (mongoose.connection.readyState !== 1 && retries < 5) {
      await new Promise(r => setTimeout(r, 200));
      retries++;
    }
    if (mongoose.connection.readyState !== 1) {
      console.error(`[${this.clientId}] ❌ MongoDB não disponível`);
      return;
    }

    try {
      const sessionFiles = await Promise.race([
        this.loadSession(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
      ]);
      if (sessionFiles.length > 0) {
        await this.restoreSessionFiles(sessionFiles);
        this.sessionRestored = true;
        console.log(`[${this.clientId}] ✅ Sessão restaurada (${sessionFiles.length} arquivos)`);
      }
    } catch {
      console.error(`[${this.clientId}] ❌ Erro ao restaurar sessão`);
    }
  }

  async afterBrowserInitialized() {}

  async logout() { await this.saveSession(); }
  async destroy() {
    await this.saveSession();
    if (fs.existsSync(this.userDataDir)) fs.rmSync(this.userDataDir, { recursive: true, force: true });
  }
  async deletePermanently() {
    await this.deleteExistingSession();
    if (fs.existsSync(this.userDataDir)) fs.rmSync(this.userDataDir, { recursive: true, force: true });
    return true;
  }
  async sessionExists() {
    try {
      const bucket = this.initGridFS();
      if (!bucket) return false;
      const files = await bucket.find({ 'metadata.clientId': this.clientId }).limit(1).toArray();
      return files.length > 0;
    } catch { return false; }
  }
  async getSessionInfo() {
    try {
      const bucket = this.initGridFS();
      if (!bucket) return null;
      const files = await bucket.find({ 'metadata.clientId': this.clientId }).toArray();
      if (files.length === 0) return null;
      const totalSize = files.reduce((s, f) => s + f.length, 0);
      const lastModified = Math.max(...files.map(f => f.metadata.sessionVersion || 0));
      return {
        clientId: this.clientId,
        fileCount: files.length,
        totalSize,
        lastModified: new Date(lastModified),
        files: files.map(f => ({ name: f.filename, size: f.length, path: f.metadata.originalPath }))
      };
    } catch { return null; }
  }
}

// ======================
// startClient
// ======================
async function startClient(userId, clientsMap = null, clientStatesMap = null) {
  return _runWithLimit(async () => {
    const uid = String(userId);
    console.log(`[${uid}] Iniciando cliente`);

    if (clientsMap && clientsMap.has(uid)) {
      const existing = clientsMap.get(uid);
      try { if (!existing.destroyed) await existing.destroy(); } catch {}
      clientsMap.delete(uid);
      clientStatesMap?.delete(uid);
    }

    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect('mongodb://127.0.0.1:27017/whatsapp', {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        maxPoolSize: 5,
        minPoolSize: 1
      });
    }

    const authStrategy = new GridFSAuthStrategy({ clientId: uid, dataPath: path.join(__dirname, '.wwebjs_gridfs') });
    const client = new Client({
      authStrategy,
      puppeteer: {
        headless: true,
        userDataDir: authStrategy.userDataDir,
        executablePath: '/usr/bin/google-chrome',
        args: [
          '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas','--no-first-run','--no-zygote',
          '--disable-gpu','--disable-extensions'
        ]
      },
      webVersion: '2.2412.54',
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
      }
    });

    let readyFired = false;
    let saveInterval = null;

      // ========== EVENTOS ==========
    client.once('qr', async (qr) => {
      try {
        const qrBase64 = await qrcode.toDataURL(qr);
        clientStatesMap?.set(uid, {
          connected: false,
          qr: qrBase64,
          status: 'awaiting_qr',
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error(`[${uid}] Erro ao gerar QR:`, err.message);
      }
    });

    client.once('authenticated', async () => {
      console.log(`[${uid}] Autenticado`);
      try { await client.authStrategy.saveSession(); } catch {}
      try { escutarGrupos(client, uid); } catch {}
    });

    client.once('ready', async () => {
      if (readyFired) return;
      readyFired = true;
      console.log(`[${uid}] ✅ Cliente pronto`);
      clientStatesMap?.set(uid, {
        connected: true,
        qr: null,
        status: 'connected',
        timestamp: new Date().toISOString()
      });

      // salva sessão 10s após ficar pronto
      setTimeout(async () => {
        try { await client.authStrategy.saveSession(); } catch {}
      }, 10000);

      saveInterval = setInterval(async () => {
        try {
          const state = clientStatesMap?.get(uid);
          if (state?.connected && client && !client.destroyed) {
            await client.authStrategy.saveSession();
          } else {
            clearInterval(saveInterval);
          }
        } catch {}
      }, SAVE_INTERVAL_MS);
    });

    client.on('disconnected', async (reason) => {
      console.log(`[${uid}] 🔌 Desconectado: ${reason}`);
      clearInterval(saveInterval);
      client.removeAllListeners(); // ✅ limpar listeners para evitar vazamento
      try { await client.authStrategy.saveSession(); } catch {}
      clientStatesMap?.set(uid, {
        connected: false,
        qr: null,
        status: 'disconnected',
        reason,
        timestamp: new Date().toISOString()
      });
    });

    client.on('auth_failure', (msg) => {
      console.log(`[${uid}] ❌ Falha de autenticação:`, msg);
      clearInterval(saveInterval);
      client.removeAllListeners(); // ✅ limpar listeners para evitar duplicados
      clientStatesMap?.set(uid, {
        connected: false,
        qr: null,
        status: 'auth_failed',
        error: msg,
        timestamp: new Date().toISOString()
      });
    });


    if (clientsMap) clientsMap.set(uid, client);

    await client.initialize();

    await new Promise((resolve) => {
      const done = () => {
        client.off('qr', done);
        client.off('ready', done);
        resolve();
      };
      client.once('qr', done);
      client.once('ready', done);
      setTimeout(resolve, 30000);
    });

    return client;
  });
}

module.exports = { GridFSAuthStrategy, startClient };
