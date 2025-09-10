const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');
const { Client } = require('whatsapp-web.js');
const BaseAuthStrategy = require("whatsapp-web.js/src/authStrategies/BaseAuthStrategy");
const qrcode = require('qrcode');
const escutarGrupos = require('./grupos');

// Cache global para buckets (evita recriar)
const bucketCache = new Map();

// ======================
// GridFSAuthStrategy OTIMIZADA
// ======================
class GridFSAuthStrategy extends BaseAuthStrategy {
  constructor(options = {}) {
    super();
    this.clientId = options.clientId;
    this.dataPath = options.dataPath || path.join(__dirname, '.wwebjs_gridfs');
    this.userDataDir = path.join(this.dataPath, this.clientId);
    this.bucket = null;
    this.sessionRestored = false;
    
    // Cache de arquivos para evitar leituras desnecessárias
    this.fileCache = new Map();
    this.lastSaveTime = 0;
    this.saveThrottleMs = 30000; // Throttle saves para 30s

    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }
  }

  initGridFS() {
    // Usar cache global para evitar múltiplas instâncias
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
        console.log(`[${this.clientId}] ✅ GridFSBucket criado e cacheado`);
      } catch (error) {
        console.error(`[${this.clientId}] ❌ Erro ao criar GridFSBucket:`, error);
      }
    }
    return this.bucket;
  }

  // Método otimizado - menos operações de I/O
  getCriticalPaths() {
    // Reduzir para apenas os arquivos mais críticos
    return {
      dirs: [
        'Default/Local Storage',
        'Default/Session Storage',
        'Default/IndexedDB'
      ],
      files: [
        'Default/Preferences',
        'Default/Cookies',
        'Default/Local State'
      ],
      exts: ['.db', '.sqlite', '.ldb', '.json'] // Removido logs desnecessários
    };
  }

  // Leitura otimizada com cache
  async readSessionFiles() {
    const { dirs, files, exts } = this.getCriticalPaths();
    const sessionFiles = [];
    const processedPaths = new Set(); // Evitar duplicatas

    const addFile = (filePath, relativePath) => {
      try {
        if (processedPaths.has(relativePath)) return;
        processedPaths.add(relativePath);

        if (!fs.existsSync(filePath)) return;
        
        const stats = fs.statSync(filePath);
        if (!stats.isFile() || stats.size === 0) return; // Pular arquivos vazios
        
        // Verificar cache por mtime
        const cacheKey = `${relativePath}_${stats.mtime.getTime()}`;
        if (this.fileCache.has(cacheKey)) {
          sessionFiles.push(this.fileCache.get(cacheKey));
          return;
        }

        const isValidExt = exts.some(ext => relativePath.endsWith(ext));
        const isKnownFile = files.some(f => relativePath === f);
        if (!isValidExt && !isKnownFile) return;

        // Limite de tamanho para evitar arquivos muito grandes
        if (stats.size > 50 * 1024 * 1024) { // 50MB max
          console.warn(`[${this.clientId}] Arquivo muito grande ignorado: ${relativePath}`);
          return;
        }

        const data = fs.readFileSync(filePath);
        const normalizedPath = relativePath.replace(/\\/g, '/');
        
        const fileObj = {
          path: normalizedPath,
          data: data,
          size: data.length,
          mtime: stats.mtime
        };

        // Cache o arquivo
        this.fileCache.set(cacheKey, fileObj);
        sessionFiles.push(fileObj);

      } catch (error) {
        // Silencioso para não poluir logs
      }
    };

    // Leitura mais eficiente de diretórios
    const walkDirectory = (baseDir) => {
      const fullPath = path.join(this.userDataDir, baseDir);
      if (!fs.existsSync(fullPath)) return;

      try {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const entryPath = path.join(fullPath, entry.name);
            const relativePath = path.relative(this.userDataDir, entryPath);
            addFile(entryPath, relativePath);
          } else if (entry.isDirectory() && entry.name !== 'Code Cache') {
            // Recursão limitada para evitar overhead
            const subdirPath = path.join(baseDir, entry.name);
            if (subdirPath.split('/').length <= 3) { // Máximo 3 níveis
              walkDirectory(subdirPath);
            }
          }
        }
      } catch (error) {
        // Silencioso
      }
    };

    // Processar apenas diretórios críticos
    for (const dir of dirs) {
      walkDirectory(dir);
    }

    // Processar arquivos específicos
    for (const file of files) {
      const filePath = path.join(this.userDataDir, file);
      addFile(filePath, file);
    }

    return sessionFiles;
  }

  async restoreSessionFiles(files) {
    if (!files || files.length === 0) return;
    
    // Processar em lotes para reduzir I/O simultâneo
    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (file) => {
        try {
          const fullPath = path.join(this.userDataDir, file.path);
          const dir = path.dirname(fullPath);
          
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          
          const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
          fs.writeFileSync(fullPath, buffer);
        } catch (error) {
          // Silencioso
        }
      }));
    }
  }

  async saveSession() {
    try {
      // Throttle saves para evitar excesso
      const now = Date.now();
      if (now - this.lastSaveTime < this.saveThrottleMs) {
        console.log(`[${this.clientId}] Save throttled`);
        return false;
      }
      this.lastSaveTime = now;

      const bucket = this.initGridFS();
      if (!bucket) return false;
      
      const sessionFiles = await this.readSessionFiles();
      
      if (sessionFiles.length === 0) {
        console.log(`[${this.clientId}] ⚠️ Nenhum arquivo crítico encontrado`);
        return false;
      }

      // Limpar sessões antigas de forma assíncrona (não bloquear)
      this.deleteExistingSession().catch(console.error);

      // Salvar em lotes menores
      const batchSize = 5; // Reduzido para menos overhead
      const batches = [];
      
      for (let i = 0; i < sessionFiles.length; i += batchSize) {
        batches.push(sessionFiles.slice(i, i + batchSize));
      }

      for (const batch of batches) {
        const promises = batch.map((file, index) => {
          const filename = `${this.clientId}_${file.path.replace(/[/\\]/g, '_')}`;
          
          return new Promise((resolve, reject) => {
            const uploadStream = bucket.openUploadStream(filename, {
              metadata: {
                clientId: this.clientId,
                originalPath: file.path,
                fileIndex: index,
                mtime: file.mtime,
                sessionVersion: now
              }
            });
            
            uploadStream.on('finish', () => resolve(uploadStream.id));
            uploadStream.on('error', reject);
            uploadStream.end(file.data);
          });
        });

        await Promise.all(promises);
      }

      console.log(`[${this.clientId}] ✅ Sessão salva: ${sessionFiles.length} arquivos`);
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
      
      const cursor = bucket.find({ 'metadata.clientId': this.clientId });
      const files = await cursor.toArray();
      
      // Delete em lotes para reduzir carga
      const batchSize = 10;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        await Promise.all(batch.map(file => bucket.delete(file._id).catch(() => {})));
      }
    } catch (error) {
      // Silencioso
    }
  }

  async loadSession() {
    try {
      const bucket = this.initGridFS();
      if (!bucket) return [];
      
      const cursor = bucket.find({ 'metadata.clientId': this.clientId })
        .sort({ 'metadata.fileIndex': 1 });
      const files = await cursor.toArray();
      
      if (files.length === 0) return [];

      const sessionFiles = [];
      
      // Carregar em lotes
      const batchSize = 10;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        
        const batchResults = await Promise.all(batch.map(async (file) => {
          try {
            const downloadStream = bucket.openDownloadStream(file._id);
            const chunks = [];
            
            await new Promise((resolve, reject) => {
              downloadStream.on('data', chunk => chunks.push(chunk));
              downloadStream.on('end', resolve);
              downloadStream.on('error', reject);
            });
            
            return {
              path: file.metadata.originalPath,
              data: Buffer.concat(chunks),
              size: Buffer.concat(chunks).length,
              mtime: file.metadata.mtime
            };
          } catch (error) {
            return null;
          }
        }));
        
        sessionFiles.push(...batchResults.filter(f => f !== null));
      }
      
      return sessionFiles;
    } catch (error) {
      return [];
    }
  }

  async beforeBrowserInitialized() {
    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }

    // Timeout mais agressivo para MongoDB
    let retries = 0;
    const maxRetries = 3; // Reduzido drasticamente
    
    while (mongoose.connection.readyState !== 1 && retries < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, 500)); // 500ms
      retries++;
    }
    
    if (mongoose.connection.readyState !== 1) {
      console.error(`[${this.clientId}] ❌ MongoDB timeout, continuando sem sessão`);
      return;
    }

    try {
      const sessionFiles = await Promise.race([
        this.loadSession(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000)) // 3s timeout
      ]);
      
      if (sessionFiles.length > 0) {
        await this.restoreSessionFiles(sessionFiles);
        this.sessionRestored = true;
        console.log(`[${this.clientId}] ✅ Sessão restaurada: ${sessionFiles.length} arquivos`);
      }
    } catch (error) {
      console.error(`[${this.clientId}] ❌ Timeout ao carregar sessão`);
    }
  }

  async afterBrowserInitialized() {
    // Implementação mínima para reduzir overhead
  }

  async logout() {
    await this.saveSession();
  }

  async destroy() {
    // Limpar cache
    this.fileCache.clear();
    await this.saveSession();
    
    if (fs.existsSync(this.userDataDir)) {
      fs.rmSync(this.userDataDir, { recursive: true, force: true });
    }
  }

  async deletePermanently() {
    this.fileCache.clear();
    await this.deleteExistingSession();
    
    if (fs.existsSync(this.userDataDir)) {
      fs.rmSync(this.userDataDir, { recursive: true, force: true });
    }
  }

  async sessionExists() {
    try {
      const bucket = this.initGridFS();
      if (!bucket) return false;
      
      const cursor = bucket.find({ 'metadata.clientId': this.clientId }).limit(1);
      const files = await cursor.toArray();
      return files.length > 0;
    } catch (error) {
      return false;
    }
  }

  async getSessionInfo() {
    try {
      const bucket = this.initGridFS();
      if (!bucket) return null;
      
      const cursor = bucket.find({ 'metadata.clientId': this.clientId });
      const files = await cursor.toArray();
      
      if (files.length === 0) return null;
      
      const totalSize = files.reduce((sum, file) => sum + file.length, 0);
      const lastModified = Math.max(...files.map(f => f.metadata.sessionVersion || 0));
      
      return {
        clientId: this.clientId,
        fileCount: files.length,
        totalSize: totalSize,
        lastModified: new Date(lastModified),
        files: files.map(f => ({
          name: f.filename,
          size: f.length,
          path: f.metadata.originalPath
        }))
      };
    } catch (error) {
      return null;
    }
  }
}

// ======================
// startClient OTIMIZADO
// ======================
async function startClient(userId, clientsMap = null, clientStatesMap = null) {
  const uid = String(userId);
  console.log(`[${uid}] Iniciando cliente.`);

  // Cleanup mais agressivo de clientes existentes
  if (clientsMap && clientsMap.has(uid)) {
    const existingClient = clientsMap.get(uid);
    console.log(`[${uid}] Removendo cliente anterior`);
    
    try {
      if (!existingClient.destroyed) {
        await existingClient.destroy();
      }
    } catch (e) {
      console.log(`[${uid}] Cleanup: ${e.message}`);
    }
    
    clientsMap.delete(uid);
    clientStatesMap?.delete(uid);
  }

  // MongoDB com configurações otimizadas
  if (mongoose.connection.readyState !== 1) {
    console.log(`[${uid}] Conectando ao MongoDB.`);
    try {
      await mongoose.connect('mongodb://127.0.0.1:27017/whatsapp', {
        serverSelectionTimeoutMS: 5000, // Reduzido
        connectTimeoutMS: 5000, // Reduzido
        maxPoolSize: 5, // Reduzido
        minPoolSize: 1, // Reduzido
        maxIdleTimeMS: 30000, // Conexões idle por 30s
        bufferMaxEntries: 0 // Sem buffer
      });
      console.log(`[${uid}] MongoDB conectado`);
    } catch (error) {
      console.error(`[${uid}] Erro ao conectar MongoDB:`, error);
      throw error;
    }
  }

  const authStrategy = new GridFSAuthStrategy({
    clientId: uid,
    dataPath: path.join(__dirname, '.wwebjs_gridfs')
  });

  // Puppeteer com configurações mais leves
  const client = new Client({
    authStrategy,
    puppeteer: {
      headless: true,
      userDataDir: authStrategy.userDataDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security', // Adicional
        '--disable-features=VizDisplayCompositor', // Adicional
        '--memory-pressure-off', // Adicional
        '--max-old-space-size=256' // Limite de memória
      ]
    },
    webVersion: '2.2412.54',
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
  });

  // Flags de controle
  let readyFired = false;
  let authCompleted = false;
  let gruposEscutando = false;
  let saveInterval = null;

  // Event handlers otimizados
  client.on('qr', async (qr) => {
    console.log(`[${uid}] QR Code recebido`);
    try {
      const qrBase64 = await qrcode.toDataURL(qr);
      if (clientStatesMap) {
        clientStatesMap.set(uid, {
          connected: false,
          qr: qrBase64,
          status: 'awaiting_qr',
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error(`[${uid}] Erro ao gerar QR:`, error);
    }
  });

  client.on('authenticated', async () => {
    console.log(`[${uid}] Autenticado com sucesso`);
    authCompleted = true;

    // Save session imediatamente (throttled internamente)
    try {
      if (client.authStrategy?.saveSession) {
        await client.authStrategy.saveSession();
      }
    } catch (e) {
      console.error(`[${uid}] Erro ao salvar sessão:`, e);
    }

    // Configurar escuta de grupos
    if (!gruposEscutando) {
      try {
        escutarGrupos(client, uid);
        gruposEscutando = true;
        console.log(`[${uid}] 📡 escutarGrupos configurado`);
      } catch (error) {
        console.error(`[${uid}] ❌ Erro ao configurar escutarGrupos:`, error);
      }
    }

    // Fallback otimizado - timeout reduzido
    setTimeout(async () => {
      if (!readyFired) {
        try {
          const state = await client.getState();
          if (state === 'CONNECTED') {
            console.log(`[${uid}] ⚠️ Ready forçado após timeout`);
            readyFired = true;
            if (clientStatesMap) {
              clientStatesMap.set(uid, {
                connected: true,
                qr: null,
                status: 'connected',
                forced: true,
                timestamp: new Date().toISOString()
              });
            }
            try { 
              client.emit('ready'); 
            } catch(e) { 
              console.warn(`[${uid}] Erro emitindo ready:`, e.message); 
            }
          }
        } catch (err) {
          console.log(`[${uid}] ⚠️ Erro verificando estado:`, err.message);
        }
      }
    }, 60000); // Reduzido para 60s
  });

  client.on('ready', async () => {
    if (readyFired) return;
    readyFired = true;

    if (clientStatesMap) {
      clientStatesMap.set(uid, {
        connected: true,
        qr: null,
        status: 'connected',
        timestamp: new Date().toISOString()
      });
    }

    // Configurar escuta de grupos se ainda não foi feito
    if (!gruposEscutando) {
      try {
        escutarGrupos(client, uid);
        gruposEscutando = true;
        console.log(`[${uid}] 📡 escutarGrupos configurado em ready`);
      } catch (error) {
        console.error(`[${uid}] ❌ Erro ao configurar escutarGrupos:`, error);
      }
    }

    // Save session após delay menor
    setTimeout(async () => {
      try {
        if (client.authStrategy && client.authStrategy.saveSession) {
          await client.authStrategy.saveSession();
        }
      } catch (error) {
        console.error(`[${uid}] Erro ao salvar sessão:`, error);
      }
    }, 5000); // Reduzido para 5s

    // Salvamento periódico otimizado
    saveInterval = setInterval(async () => {
      try {
        const state = clientStatesMap?.get(uid);
        if (state?.connected && client && !client.destroyed) {
          if (client.authStrategy && client.authStrategy.saveSession) {
            await client.authStrategy.saveSession();
          }
        } else {
          if (saveInterval) {
            clearInterval(saveInterval);
            saveInterval = null;
          }
        }
      } catch (error) {
        // Silencioso
      }
    }, 600000); // Aumentado para 10 minutos (menos I/O)
  });

  // Cleanup na desconexão
  const cleanup = () => {
    if (saveInterval) {
      clearInterval(saveInterval);
      saveInterval = null;
    }
    readyFired = false;
    authCompleted = false;
    gruposEscutando = false;
  };

  client.on('auth_failure', (msg) => {
    console.log(`[${uid}] Falha na autenticação:`, msg);
    cleanup();

    if (clientStatesMap) {
      clientStatesMap.set(uid, {
        connected: false,
        qr: null,
        status: 'auth_failed',
        error: msg,
        timestamp: new Date().toISOString()
      });
    }
  });

  client.on('disconnected', async (reason) => {
    console.log(`[${uid}] Desconectado:`, reason);
    cleanup();

    if (clientStatesMap) {
      clientStatesMap.set(uid, {
        connected: false,
        qr: null,
        status: 'disconnected',
        reason,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Salvar cliente e inicializar
  if (clientsMap) {
    clientsMap.set(uid, client);
  }

  try {
    console.log(`[${uid}] Inicializando cliente.`);
    await client.initialize();
    console.log(`[${uid}] Cliente inicializado com sucesso`);
    return client;
  } catch (error) {
    console.error(`[${uid}] Erro ao inicializar:`, error);
    cleanup();

    if (clientsMap && clientsMap.has(uid)) {
      clientsMap.delete(uid);
    }
    if (clientStatesMap) {
      clientStatesMap.set(uid, {
        connected: false,
        qr: null,
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
    throw error;
  }
}

module.exports = { GridFSAuthStrategy, startClient };