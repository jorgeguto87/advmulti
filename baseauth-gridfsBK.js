const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');
const { Client } = require('whatsapp-web.js');
const BaseAuthStrategy = require("whatsapp-web.js/src/authStrategies/BaseAuthStrategy");
const qrcode = require('qrcode');
const escutarGrupos = require('./grupos');

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

    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }
  }

  initGridFS() {
    console.log(`[${this.clientId}] Inicializando GridFS...`);
    console.log(`[${this.clientId}] Estado do MongoDB: ${mongoose.connection.readyState}`);
    
    if (!this.bucket && mongoose.connection.readyState === 1) {
      try {
        console.log(`[${this.clientId}] Criando GridFSBucket...`);
        // CORREÇÃO: usar mesmo bucketName do server.js
        this.bucket = new GridFSBucket(mongoose.connection.db, {
          bucketName: 'sessions' // Era 'whatsapp_sessions' no server.js
        });
        console.log(`[${this.clientId}] ✅ GridFSBucket criado com sucesso`);
      } catch (error) {
        console.error(`[${this.clientId}] ❌ Erro ao criar GridFSBucket:`, error);
      }
    }
    return this.bucket;
  }

// Adicione este método
async createGridFSCollections() {
  try {
    const db = mongoose.connection.db;
    await db.createCollection('sessions.files');
    await db.createCollection('sessions.chunks');
    console.log('✅ Collections do GridFS criadas manualmente');
    
    // Tentar novamente
    this.bucket = new GridFSBucket(mongoose.connection.db, {
      bucketName: 'sessions'
    });
  } catch (error) {
    console.error('❌ Falha ao criar collections do GridFS:', error);
  }
}
  // ========== métodos auxiliares ==========
  getCriticalPaths() {
    return {
      dirs: [
        'Default',
        'Default/IndexedDB',
        'Default/Local Storage',
        'Default/Session Storage',
        'Default/Service Worker',
        'Default/databases',
        'Default/Code Cache'
      ],
      files: [
        'Default/Preferences',
        'Default/Cookies',
        'Default/Local State',
        'Default/Network/Cookies',
        'Default/TransportSecurity'
      ],
      exts: ['.db', '.sqlite', '.sqlite3', '.ldb', '.log', '.json']
    };
  }

  async readSessionFiles() {
    const { dirs, files, exts } = this.getCriticalPaths();
    const sessionFiles = [];

    const addFile = (filePath, relativePath) => {
      try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          return;
        }
        const isValidExt = exts.some(ext => relativePath.endsWith(ext));
        const isKnownFile = files.some(f => relativePath === f);
        if (!isValidExt && !isKnownFile) {
        return;
        }
        const data = fs.readFileSync(filePath);
        const normalizedPath = relativePath.replace(/\\/g, '/');
        sessionFiles.push({
          path: normalizedPath,
          data: data,
          size: data.length,
          mtime: fs.statSync(filePath).mtime
        });
      } catch {}
    };

    const walkDirectory = (baseDir) => {
      const fullPath = path.join(this.userDataDir, baseDir);
      if (!fs.existsSync(fullPath)) return;
      const traverseDir = (currentPath) => {
        try {
          const entries = fs.readdirSync(currentPath, { withFileTypes: true });
          for (const entry of entries) {
            const entryPath = path.join(currentPath, entry.name);
            const relativePath = path.relative(this.userDataDir, entryPath);
            if (entry.isDirectory()) traverseDir(entryPath);
            else if (entry.isFile()) addFile(entryPath, relativePath);
          }
        } catch {}
      };
      traverseDir(fullPath);
    };

    for (const dir of dirs) walkDirectory(dir);
    for (const file of files) {
      const filePath = path.join(this.userDataDir, file);
      addFile(filePath, file);
    }

    return sessionFiles;
  }

  async restoreSessionFiles(files) {
    if (!files || files.length === 0) return;
    for (const file of files) {
      try {
        const fullPath = path.join(this.userDataDir, file.path);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
        fs.writeFileSync(fullPath, buffer);
      } catch {}
    }
  }

  async saveSession() {
  try {
    console.log(`[${this.clientId}] Tentando salvar sessão...`);
    const bucket = this.initGridFS();
    if (!bucket) {
      console.log(`[${this.clientId}] Bucket não inicializado`);
      return false;
    }
    
    const sessionFiles = await this.readSessionFiles();
    //console.log(`[${this.clientId}] DEBUG: Arquivos lidos:`, sessionFiles.map(f => f.path));
    //console.log(`[${this.clientId}] ${sessionFiles.length} arquivos de sessão encontrados`);
    
    if (sessionFiles.length === 0) {
  console.log(`[${this.clientId}] ⚠️ Nenhum arquivo crítico encontrado, aplicando fallback...`);
  const walkAll = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      const relativePath = path.relative(this.userDataDir, entryPath);
      if (entry.isDirectory()) walkAll(entryPath);
      else if (entry.isFile()) {
        try {
          const data = fs.readFileSync(entryPath);
          sessionFiles.push({
            path: relativePath,
            data,
            size: data.length,
            mtime: fs.statSync(entryPath).mtime
          });
        } catch {}
      }
    }
  };
  walkAll(this.userDataDir);
  console.log(`[${this.clientId}] Fallback capturou ${sessionFiles.length} arquivos`);
}

    if (sessionFiles.length === 0) {
      console.log(`[${this.clientId}] Nenhum arquivo de sessão para salvar`);
      return false;
    }

    
    // Fallback: se não achar nada, pega tudo que existir em userDataDir


    
    await this.deleteExistingSession();
    console.log(`[${this.clientId}] Sessões existentes deletadas`);

    const promises = sessionFiles.map((file, index) => {
      const filename = `${this.clientId}_${file.path.replace(/[/\\]/g, '_')}`;
      console.log(`[${this.clientId}] Salvando arquivo: ${filename}`);
      
      return new Promise((resolve, reject) => {
        const uploadStream = bucket.openUploadStream(filename, {
          metadata: {
            clientId: this.clientId,
            originalPath: file.path,
            fileIndex: index,
            mtime: file.mtime,
            sessionVersion: Date.now()
          }
        });
        
        uploadStream.on('finish', () => {
          console.log(`[${this.clientId}] Arquivo salvo: ${filename}`);
          resolve(uploadStream.id);
        });
        
        uploadStream.on('error', (error) => {
          console.error(`[${this.clientId}] Erro ao salvar arquivo ${filename}:`, error);
          reject(error);
        });
        
        uploadStream.end(file.data);
      });
    });

    await Promise.all(promises);
    console.log(`[${this.clientId}] ✅ Todas as sessões salvas com sucesso`);
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
      for (const file of files) {
        await bucket.delete(file._id);
      }
    } catch {}
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
      for (const file of files) {
        const downloadStream = bucket.openDownloadStream(file._id);
        const chunks = [];
        await new Promise((resolve, reject) => {
          downloadStream.on('data', chunk => chunks.push(chunk));
          downloadStream.on('end', resolve);
          downloadStream.on('error', reject);
        });
        const data = Buffer.concat(chunks);
        sessionFiles.push({
          path: file.metadata.originalPath,
          data: data,
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

  console.log(`[${this.clientId}] Aguardando MongoDB...`);
  
  // AGUARDAR MongoDB com timeout mais curto
  let retries = 0;
  const maxRetries = 5; // Reduzido drasticamente
  
  while (mongoose.connection.readyState !== 1 && retries < maxRetries) {
    await new Promise(resolve => setTimeout(resolve, 200)); // 200ms apenas
    retries++;
    if (retries % 5 === 0) { // Log a cada 5 tentativas
      console.log(`[${this.clientId}] MongoDB retry ${retries}/${maxRetries}`);
    }
  }
  
  if (mongoose.connection.readyState !== 1) {
    console.error(`[${this.clientId}] ❌ MongoDB não conectou, continuando sem sessão salva`);
    return;
  }

  console.log(`[${this.clientId}] ✅ MongoDB conectado, carregando sessão...`);
  
  try {
    const sessionFiles = await Promise.race([
      this.loadSession(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);
    
    if (sessionFiles.length > 0) {
      await this.restoreSessionFiles(sessionFiles);
      this.sessionRestored = true;
      console.log(`[${this.clientId}] ✅ Sessão restaurada com ${sessionFiles.length} arquivos`);
    } else {
      console.log(`[${this.clientId}] ℹ️ Nenhuma sessão anterior encontrada`);
    }
  } catch (error) {
    console.error(`[${this.clientId}] ❌ Timeout/erro ao carregar sessão:`, error.message);
  }
  
  console.log(`[${this.clientId}] beforeBrowserInitialized concluído`);
}

   async afterBrowserInitialized() {
    console.log(`[${this.clientId}] afterBrowserInitialized - sessionRestored: ${this.sessionRestored}`);
    
    if (this.sessionRestored) {
    console.log(`[${this.clientId}] Sessão restaurada, aguardando ready...`);
  }
  }

  async logout() {
    await this.saveSession();
  }

  async destroy() {
    await this.saveSession();
    if (fs.existsSync(this.userDataDir)) {
      fs.rmSync(this.userDataDir, { recursive: true, force: true });
    }
  }

  async deletePermanently() {
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
    } catch {
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
    } catch {
      return null;
    }
  }
}

// ======================
// startClient
// ======================
async function startClient(userId, clientsMap = null, clientStatesMap = null) {
  const uid = String(userId);
  console.log(`[${uid}] Iniciando cliente.`);

  // Se cliente já existe e está ativo, retorna ele
  if (clientsMap && clientsMap.has(uid)) {
    const existingClient = clientsMap.get(uid);
    const currentState = clientStatesMap?.get(uid);

    if (!existingClient.destroyed && currentState?.connected === true) {
      console.log(`[${uid}] Cliente já conectado`);
      return existingClient;
    } else {
      console.log(`[${uid}] Removendo cliente anterior`);
      try { await existingClient.destroy(); } catch (e) { console.log(`[${uid}] Cleanup: ${e.message}`); }
      clientsMap.delete(uid);
      clientStatesMap?.delete(uid);
    }
  }

  // Conectar MongoDB se necessário (mantive tuas opções)
  if (mongoose.connection.readyState !== 1) {
    console.log(`[${uid}] Conectando ao MongoDB.`);
    try {
      await mongoose.connect('mongodb://127.0.0.1:27017/whatsapp', {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        maxPoolSize: 10,
        minPoolSize: 2
      });
      console.log(`[${uid}] MongoDB conectado`);
    } catch (error) {
      console.error(`[${uid}] Erro ao conectar MongoDB:`, error);
      throw error;
    }
  }

  // Criar authStrategy (mantive tua implementação)
  const authStrategy = new GridFSAuthStrategy({
    clientId: uid,
    dataPath: path.join(__dirname, '.wwebjs_gridfs')
  });

  // Criar o client com mesmas opções de puppeteer
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
      '--disable-gpu'
    ]
  },
  webVersion: '2.2412.54', // exemplo
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  }
});

  // flags de controle
  let readyFired = false;
  let authCompleted = false;
  let gruposEscutando = false;

  // ------------------------
  // QR
  // ------------------------
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

  // ------------------------
  // AUTHENTICATED
  // ------------------------
  client.on('authenticated', async () => {
    console.log(`[${uid}] Autenticado com sucesso`);
    authCompleted = true;

    // salvar sessão imediatamente
    try {
      if (client.authStrategy?.saveSession) {
        await client.authStrategy.saveSession();
        console.log(`[${uid}] Sessão salva no MongoDB imediatamente após authenticated`);
      }
    } catch (e) {
      console.error(`[${uid}] Erro ao salvar sessão no authenticated:`, e);
    }

    // --- HÍBRIDO: registrar escuta de grupos já em authenticated (se ainda não registrado)
    if (!gruposEscutando) {
      try {
        escutarGrupos(client, uid);
        gruposEscutando = true;
        console.log(`[${uid}] 📡 escutarGrupos configurado em authenticated`);
      } catch (error) {
        console.error(`[${uid}] ❌ Erro ao configurar escutarGrupos em authenticated:`, error);
      }
    }

    //log temporario início
    /*console.log(`[${uid}] escutarGrupos foi chamado (typeof: ${typeof escutarGrupos})`);
    console.log(`[${uid}] eventNames agora:`, client.eventNames ? client.eventNames() : 'N/A');
    console.log(`[${uid}] listeners count -> message:`, client.listenerCount('message'), ' message_create:', client.listenerCount('message_create'));

// DEBUG TEMP: listener extra para garantir que qualquer mensagem seja logada (remova depois)
    if (!client._debug_grupos_listener) {
    client._debug_grupos_listener = (m) => {
    try {
      console.log(`[${uid}] <<<DEBUG GERAL>>> evento message capturado: from=${m.from} to=${m.to} body=${(m.body||'').substring(0,80)}`);
    } catch(e){}
  };
  client.on('message', client._debug_grupos_listener);
}*/
//log temporario fim

    // Fallback: se ready não vier, forçar estado conectado após timeout
    // OBS: corrigi a condição para forçar apenas se o estado estiver CONNECTED (cenário comum: session restaurada mas evento didn't fire)
    setTimeout(async () => {
      if (!readyFired) {
        try {
          const state = await client.getState();
          // Forçar ready apenas se estiver 'CONNECTED' (ou seja: sessão ativa mas evento não disparou)
          if (state === 'CONNECTED') {
            console.log(`[${uid}] ⚠️ Ready forçado após timeout (estado CONNECTED, mas evento não disparou)`);
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
            // emitir ready — o handler 'ready' cuidará do restante (inclusive escutarGrupos caso ainda não esteja)
            try { client.emit('ready'); } catch(e) { console.warn(`[${uid}] Erro emitindo ready:`, e.message); }
          } else {
            console.log(`[${uid}] ℹ️ Fallback: estado atual = ${state} → não forçando ready`);
          }
        } catch (err) {
          console.log(`[${uid}] ⚠️ Não foi possível verificar o estado antes do fallback:`, err.message);
        }
      }
    }, 190000); // 190s
  });

  // ------------------------
  // READY
  // ------------------------
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

    // Se ainda não configurou escuta de grupos, faz aqui (proteção para não duplicar)
    if (!gruposEscutando) {
      try {
        escutarGrupos(client, uid);
        gruposEscutando = true;
        console.log(`[${uid}] 📡 escutarGrupos configurado em ready`);
      } catch (error) {
        console.error(`[${uid}] ❌ Erro ao configurar escutarGrupos em ready:`, error);
      }
    }

    /*//log temporario início
    console.log(`[${uid}] escutarGrupos foi chamado (typeof: ${typeof escutarGrupos})`);
    console.log(`[${uid}] eventNames agora:`, client.eventNames ? client.eventNames() : 'N/A');
    console.log(`[${uid}] listeners count -> message:`, client.listenerCount('message'), ' message_create:', client.listenerCount('message_create'));

// DEBUG TEMP: listener extra para garantir que qualquer mensagem seja logada (remova depois)
    if (!client._debug_grupos_listener) {
    client._debug_grupos_listener = (m) => {
    try {
      console.log(`[${uid}] <<<DEBUG GERAL>>> evento message capturado: from=${m.from} to=${m.to} body=${(m.body||'').substring(0,80)}`);
    } catch(e){}
  };
  client.on('message', client._debug_grupos_listener);
}*/
//log temporario fim

    // salvar sessão após pequeno delay
    setTimeout(async () => {
      try {
        if (client.authStrategy && client.authStrategy.saveSession) {
          await client.authStrategy.saveSession();
        }
      } catch (error) {
        console.error(`[${uid}] Erro ao salvar sessão:`, error);
      }
    }, 10000);

    // salvamento periódico (iniciar aqui para só rodar quando ready)
    const saveInterval = setInterval(async () => {
      try {
        const state = clientStatesMap?.get(uid);
        if (state?.connected && client && !client.destroyed) {
          if (client.authStrategy && client.authStrategy.saveSession) {
            await client.authStrategy.saveSession();
          }
        } else {
          clearInterval(saveInterval);
        }
      } catch (error) {
        // silencioso
      }
    }, 300000); // 5 minutos

    // limpar interval ao desconectar
    client.on('disconnected', () => {
      clearInterval(saveInterval);
    });
  });

  // ------------------------
  // AUTH FAILURE
  // ------------------------
  client.on('auth_failure', (msg) => {
    console.log(`[${uid}] Falha na autenticação:`, msg);
    readyFired = false;
    authCompleted = false;

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

  // ------------------------
  // DISCONNECTED (geral)
  // ------------------------
  client.on('disconnected', async (reason) => {
    console.log(`[${uid}] Desconectado:`, reason);
    readyFired = false;
    authCompleted = false;

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

  // ------------------------
  // Salvar cliente e inicializar
  // ------------------------
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

    // cleanup parcial (preserva sessão salvo no GridFS)
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
