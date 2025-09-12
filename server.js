const https = require ('https');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const qrcode = require('qrcode');
const { Client, MessageMedia } = require('whatsapp-web.js');
const cron = require('node-cron');
const cors = require('cors');
const axios = require('axios');
const { exec } = require('child_process');
const bcrypt = require('bcryptjs');
const { GridFSAuthStrategy, startClient } = require('./baseauth-gridfs');
const mongoose = require('mongoose');
const escutarGrupos = require('./grupos');

// Adicione esta função após as importações
async function ensureGridFSCollections() {
  try {
    const db = mongoose.connection.db;
    
    // Listar collections existentes
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    // Criar sessions.files se não existir
    if (!collectionNames.includes('sessions.files')) {
      await db.createCollection('sessions.files');
      console.log('✅ sessions.files collection created');
    }
    
    // Criar sessions.chunks se não existir
    if (!collectionNames.includes('sessions.chunks')) {
      await db.createCollection('sessions.chunks');
      console.log('✅ sessions.chunks collection created');
    }
    
    // Criar índices necessários
    await db.collection('sessions.files').createIndex({ "metadata.clientId": 1 });
    await db.collection('sessions.chunks').createIndex({ files_id: 1, n: 1 });
    console.log('✅ Índices do GridFS criados');
    
  } catch (error) {
    console.log('Collections do GridFS já existem ou erro:', error.message);
  }
}

// Função para inicializar MongoDB com Promise
async function inicializarMongoDB() {
  return new Promise((resolve, reject) => {
    if (mongoose.connection.readyState === 1) {
      console.log('✅ MongoDB já conectado');
      ensureGridFSCollections().then(() => resolve(true));
      return;
    }

    console.log('🔌 Conectando ao MongoDB...');
    
    mongoose.connect('mongodb://127.0.0.1:27017/whatsapp', {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      maxPoolSize: 10,
      minPoolSize: 5
    });

    mongoose.connection.on('connected', async () => {
      console.log('✅ MongoDB conectado');
      try {
        await ensureGridFSCollections();
        resolve(true);
      } catch (error) {
        reject(error);
      }
    });

    mongoose.connection.on('error', (error) => {
      console.error('❌ Erro ao conectar MongoDB:', error);
      console.error('💡 Solução: Execute "net start MongoDB" como administrador');
      reject(error);
    });

    // Timeout de 20 segundos
    setTimeout(() => {
      if (mongoose.connection.readyState !== 1) {
        reject(new Error('Timeout na conexão MongoDB'));
      }
    }, 20000);
  });
}
// Multiusuário: 1 client por usuário
const clients = new Map();       // userId -> Client
const clientStates = new Map();  // userId -> { connected: bool }
//const qrMap = new Map();         // userId -> base64 do QR


const app = express();
const PORT = 5000;

app.use(cors({
  origin: 'https://atentus.com.br',
  methods: ['GET', 'POST', 'OPTIONS'],
  Authorization: "Bearer 123456abcdef",
  credentials: true
}));

const credentials = {
    key: fs.readFileSync('/etc/letsencrypt/live/atentus.com.br/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/atentus.com.br/fullchain.pem')
};


const assetsDir = path.join(__dirname, 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/*let qrBase64 = '';
let isConnected = false;
let client;
*/
// Função para verificar status do MongoDB
async function verificarMongoDB() {
  try {
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    console.log('Database:', db.databaseName);
    console.log('Collections disponíveis:', collections.map(c => c.name));
    
    // Verificar quantas sessões existem
    const sessionCollection = db.collection('sessions');
    const count = await sessionCollection.countDocuments();
    console.log(`Total de sessões armazenadas: ${count}`);
    
    return true;
  } catch (error) {
    console.error('Erro ao verificar MongoDB:', error);
    return false;
  }
}

const diaMap = {
  1: 'segunda',
  2: 'terca',
  3: 'quarta',
  4: 'quinta',
  5: 'sexta',
  6: 'sabado'
};

const imagemMap = {
  1: 'diaum',
  2: 'diadois',
  3: 'diatres',
  4: 'diaquatro',
  5: 'diacinco',
  6: 'diaseis'
};

//Função para criptografar senha
async function senhaHash(password, saltRounds = 10) {
  try {
    const hash = await bcrypt.hash(password, saltRounds);
    return hash;
  } catch (error) {
    console.error('Erro ao gerar hash:', error);
    throw error;
  }
}

function lerHorarios() {
  const filePath = path.join(__dirname, 'horarios.txt');
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.split(',').map(h => parseInt(h.trim())).filter(h => !isNaN(h));
}

function lerGruposUsuario(userId) {
  const arquivoUsuario = path.join(__dirname, `grupos_scan_${userId}.txt`);
  
  if (!fs.existsSync(arquivoUsuario)) {
    console.log(`[${userId}] ℹ️ Arquivo de grupos não encontrado: ${arquivoUsuario}`);
    return [];
  }
  
  try {
    const conteudo = fs.readFileSync(arquivoUsuario, 'utf-8');
    const grupos = conteudo
      .split('\n')
      .filter(linha => linha.trim())
      .map(linha => {
        const [id, nome] = linha.split('|');
        return {
          id: id.trim(),
          nome: (nome || 'Nome não disponível').trim()
        };
      })
      .filter(grupo => grupo.id.endsWith('@g.us'));
    
    console.log(`[${userId}] 📋 ${grupos.length} grupos encontrados`);
    return grupos;
  } catch (error) {
    console.error(`[${userId}] ❌ Erro ao ler arquivo de grupos:`, error.message);
    return [];
  }
}

// Função para ler grupos destinatários específicos de um usuário
function lerGruposDestinatariosUsuario(userId) {
  const arquivoUsuario = path.join(__dirname, `grupos_check_${userId}.txt`);
  
  if (!fs.existsSync(arquivoUsuario)) {
    console.log(`[${userId}] ℹ️ Arquivo de grupos destinatários não encontrado`);
    return [];
  }
  
  try {
    return fs.readFileSync(arquivoUsuario, 'utf-8')
      .split('\n')
      .map(linha => linha.split('|')[0]?.trim())
      .filter(id => id && id.endsWith('@g.us'));
  } catch (error) {
    console.error(`[${userId}] ❌ Erro ao ler grupos destinatários:`, error.message);
    return [];
  }
}

function migrarGruposParaUsuario(userId) {
  const arquivoGeral = path.join(__dirname, 'grupos_scan.txt');
  const arquivoUsuario = path.join(__dirname, `grupos_scan_${userId}.txt`);
  
  if (fs.existsSync(arquivoGeral) && !fs.existsSync(arquivoUsuario)) {
    try {
      fs.copyFileSync(arquivoGeral, arquivoUsuario);
      console.log(`[${userId}] 🔄 Grupos migrados do arquivo geral para usuário específico`);
    } catch (error) {
      console.error(`[${userId}] ❌ Erro ao migrar grupos:`, error.message);
    }
  }
}


function lerMensagensDataTxt() {
  const filePath = path.join(__dirname, 'data.txt');
  if (!fs.existsSync(filePath)) return {};
  const linhas = fs.readFileSync(filePath, 'utf-8').split('\n');
  const mapa = {};
  for (const linha of linhas) {
    const [dia, ...msg] = linha.split(':');
    if (dia && msg.length > 0) {
      mapa[dia.trim()] = msg.join(':').trim().replace(/\\n/g, '\n');
    }
  }
  return mapa;
}

// SUBSTITUA A FUNÇÃO logoutClient EXISTENTE POR ESTA:

async function logoutClient(userId) {
    const uid = String(userId);
    const client = clients.get(uid);

    try {
        if (client) {
            // Apenas destruir em memória, mas NÃO apagar do banco
            await client.destroy();
            clients.delete(uid);
            console.log(`[${uid}] Cliente destruído em memória, sessão preservada no banco`);
        }

        clientStates.set(uid, { connected: false, qr: null });
    } catch (error) {
        console.error(`[${uid}] Erro no logout:`, error);
        throw error;
    }
}

// ADICIONE ESTA NOVA FUNÇÃO (se não existir):

async function restartClient(userId) {
    const uid = String(userId);
    try {
        // Primeiro fazer logout completo
        await logoutClient(uid);
        
        // Aguardar um pouco para limpeza
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Iniciar novamente
        await startClient(uid);
        
        console.log(`[${uid}] Restart realizado com sucesso`);
    } catch (error) {
        console.error(`[${uid}] Erro no restart:`, error);
        throw error;
    }
}

//FUNÇÃO ESCUTAR GRUPOS
/*function escutarGrupos(client, userId) {
  console.log(`[${userId}] 📱 Iniciando escuta de grupos para usuário`);

  async function processarGrupo(msg) {
    try {
      const isFromGroup = msg.from.endsWith('@g.us');
      const isToGroup = msg.to && msg.to.endsWith('@g.us');
      
      if (isFromGroup || isToGroup) {
        const grupoId = isFromGroup ? msg.from : msg.to;
        
        try {
          const chat = await msg.getChat();
          const nomeGrupo = chat.name || 'Nome não disponível';
          const registro = `${grupoId}|${nomeGrupo}`;
          
          // Arquivo específico para cada usuário
          const arquivoUsuario = path.join(__dirname, `grupos_scan_${userId}.txt`);
          
          // Verificar se já existe no arquivo do usuário
          let existente = '';
          if (fs.existsSync(arquivoUsuario)) {
            existente = fs.readFileSync(arquivoUsuario, 'utf-8');
          }
          
          if (!existente.includes(grupoId)) {
            fs.appendFileSync(arquivoUsuario, registro + '\n', 'utf-8');
            console.log(`[${userId}] 📝 Grupo salvo: ${registro}`);
          }
          
          // Também salvar no arquivo geral (mantendo compatibilidade)
          const arquivoGeral = path.join(__dirname, 'grupos_scan.txt');
          let existenteGeral = '';
          if (fs.existsSync(arquivoGeral)) {
            existenteGeral = fs.readFileSync(arquivoGeral, 'utf-8');
          }
          
          if (!existenteGeral.includes(grupoId)) {
            fs.appendFileSync(arquivoGeral, registro + '\n', 'utf-8');
          }
          
        } catch (chatError) {
          console.error(`[${userId}] ❌ Erro ao obter informações do chat ${grupoId}:`, chatError.message);
          
          // Salvar mesmo sem o nome
          const registroSemNome = `${grupoId}|Erro ao obter nome`;
          const arquivoUsuario = path.join(__dirname, `grupos_scan_${userId}.txt`);
          
          let existente = '';
          if (fs.existsSync(arquivoUsuario)) {
            existente = fs.readFileSync(arquivoUsuario, 'utf-8');
          }
          
          if (!existente.includes(grupoId)) {
            fs.appendFileSync(arquivoUsuario, registroSemNome + '\n', 'utf-8');
            console.log(`[${userId}] 📝 Grupo salvo sem nome: ${grupoId}`);
          }
        }
      }
    } catch (error) {
      console.error(`[${userId}] ❌ Erro ao processar mensagem do grupo:`, error.message);
    }
  }

  // Registrar os listeners
  client.on('message', msg => {
  console.log(`[${uid}] DEBUG mensagem recebida:`, msg.from, msg.body?.substring(0, 30));
});
  client.on('message_create', msg => {
  console.log(`[${uid}] DEBUG mensagem criada:`, msg.to, msg.body?.substring(0, 30));
});
}*/
// Função para comprimir imagem (com fallback local)
async function comprimirImagem(imagemBuffer, nomeArquivo, qualidade = 0.7, larguraMaxima = 800) {
    try {
        console.log(`📤 Enviando ${nomeArquivo} para compressão (${imagemBuffer.length} bytes)...`);

        const FormData = require('form-data');
        const form = new FormData();
        
        form.append('file', imagemBuffer, {
            filename: nomeArquivo,
            contentType: 'image/jpeg'
        });
        
        form.append('quality', qualidade.toString());
        form.append('maxWidth', larguraMaxima.toString());

        const response = await axios.post('http://localhost:8080/api/images/compress', form, {
            headers: {
                ...form.getHeaders(),
                'Accept': 'image/jpeg'
            },
            responseType: 'arraybuffer',
            timeout: 30000
        });

        console.log(`✅ Imagem comprimida: ${response.data.length} bytes`);
        return Buffer.from(response.data);
        
    } catch (error) {
        if (error.response?.status === 413 || error.code === 'ECONNREFUSED') {
            console.warn('⚠️ API indisponível ou imagem muito grande. Comprimindo localmente...');
            return await comprimirLocalmente(imagemBuffer, qualidade, larguraMaxima);
        }
        console.error('❌ Erro na compressão:', error.message);
        throw error;
    }
}

// Função de compressão local com Sharp
// Função de compressão local com Sharp (melhorada)
async function comprimirLocalmente(imagemBuffer, qualidade = 0.7, larguraMaxima = 800) {
    try {
        const sharp = require('sharp');
        
        // Determinar formato de entrada
        let imagem = sharp(imagemBuffer);
        
        // Obter metadados para decisões de processamento
        const metadata = await imagem.metadata();
        
        // Redimensionar apenas se necessário
        if (metadata.width > larguraMaxima) {
            imagem = imagem.resize(larguraMaxima, null, {
                fit: 'inside',
                withoutEnlargement: true,
                kernel: sharp.kernel.lanczos3
            });
        }
        
        // Converter para JPEG com otimizações
        const imagemComprimida = await imagem
            .jpeg({ 
                quality: Math.floor(qualidade * 100),
                mozjpeg: true,
                progressive: true,
                optimizeScans: true,
                chromaSubsampling: '4:4:4'
            })
            .toBuffer();

        console.log(`📦 Comprimido localmente: ${imagemBuffer.length} bytes → ${imagemComprimida.length} bytes`);
        return imagemComprimida;

    } catch (error) {
        console.error('❌ Erro na compressão local:', error);
        
        // Fallback: se for PNG, converte para JPG básico
        if (imagemBuffer.toString('hex', 0, 8).includes('89504e47')) {
            console.log('🔄 Tentando fallback para conversão PNG→JPG');
            try {
                const sharp = require('sharp');
                return await sharp(imagemBuffer)
                    .jpeg({ quality: 80 })
                    .toBuffer();
            } catch (fallbackError) {
                console.error('❌ Fallback também falhou:', fallbackError);
            }
        }
        
        // Último recurso: retorna a imagem original
        return imagemBuffer;
    }
}

//***** AGENDAR ENVIOS NOVO COM TIMEZONE (ajustado) *****

// Configuração do fuso horário
//***** AGENDAR ENVIOS NOVO COM TIMEZONE + CACHE TTL *****

// Configuração do fuso horário
const TIMEZONE_OFFSET = -3; // UTC-3 (Brasil) - ajuste conforme necessário
const TARGET_TIMEZONE = 'America/Sao_Paulo'; // Timezone do Brasil

// Cache com TTL curto
const NodeCache = require("node-cache");
const cacheHorarios = new NodeCache({ stdTTL: 60, checkperiod: 30 });  // 1 min
const cacheMensagem = new NodeCache({ stdTTL: 30, checkperiod: 15 }); // 30s
const cacheGrupos = new NodeCache({ stdTTL: 30, checkperiod: 15 });   // 30s

async function fetchWithCache(url, options = {}, cache, cacheKey) {
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`⚡ Cache HIT: ${cacheKey}`);
    return cached;
  }
  console.log(`🌐 Cache MISS: ${cacheKey}`);
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Erro API: ${res.status}`);
  const data = await res.json();
  cache.set(cacheKey, data);
  return data;
}

// Função para obter data/hora no timezone correto
function obterDataBrasil() {
  return new Date(new Date().toLocaleString("en-US", {timeZone: TARGET_TIMEZONE}));
}

// Função para obter hora no Brasil baseada no horário UTC da VPS
function obterHoraBrasil() {
  const agora = new Date();
  const horaUTC = agora.getUTCHours();
  const horaBrasil = (horaUTC + TIMEZONE_OFFSET + 24) % 24;
  return horaBrasil;
}

// Função para obter dia da semana no Brasil
function obterDiaBrasil() {
  const dataBrasil = obterDataBrasil();
  return dataBrasil.getDay();
}

async function agendarEnvios() {
  console.log('📅 Função de agendamento registrada (baseada em tokens do banco) - Timezone Brasil');
  const enviadosHoje = new Map();

  cron.schedule('0 3 * * *', () => {
    enviadosHoje.clear();
    const dataBrasil = obterDataBrasil();
    console.log(`🔄 Registros de envios limpos. Data Brasil: ${dataBrasil.toLocaleDateString('pt-BR')}`);
  }, { timezone: "UTC" });

  cron.schedule('*/20 * * * *', async () => {
    const horaBrasil = obterHoraBrasil();
    const diaBrasil = obterDiaBrasil();
    const dataBrasil = obterDataBrasil();
    console.log(`\n🔍 Verificando tokens... Hora Brasil: ${horaBrasil}h, Dia: ${diaBrasil}, Data: ${dataBrasil.toLocaleDateString('pt-BR')}`);
    await verificarEPrepararEnvios(enviadosHoje);
  });

  cron.schedule('0 * * * *', async () => {
    const horaBrasil = obterHoraBrasil();
    const diaBrasil = obterDiaBrasil();
    const dataBrasil = obterDataBrasil();
    console.log(`\n🕐 Executando envios... Hora Brasil: ${horaBrasil}h, Dia: ${diaBrasil}, Data: ${dataBrasil.toLocaleDateString('pt-BR')}`);
    await executarEnviosProgramados(enviadosHoje);
  });
}

async function verificarEPrepararEnvios(enviadosHoje) {
  try {
    const horaBrasil = obterHoraBrasil();
    const diaBrasil = obterDiaBrasil();
    const proximaHora = (horaBrasil + 1) % 24;
    
    if (diaBrasil === 0) {
      console.log('⛔ Domingo - sem preparação');
      return;
    }

    const horariosData = await fetchWithCache(
      'https://atentus.cloud/api/api.php/horarios',
      {
        method: 'GET',
        headers: { 'Authorization': 'Bearer 123456abcdef','Content-Type': 'application/json','Accept': 'application/json' },
        timeout: 15000
      },
      cacheHorarios,
      'horarios_global'
    );

    const tokensParaEnviar = horariosData.filter(item => {
      if (!item.TOKEN || !item.HORARIOS) return false;
      const horarios = item.HORARIOS.split(',').map(h => parseInt(h.trim())).filter(h => !isNaN(h));
      return horarios.includes(proximaHora);
    });

    for (const tokenData of tokensParaEnviar) {
      await prepararEnvioToken(tokenData.TOKEN, diaBrasil, proximaHora);
    }

  } catch (error) {
    console.error('❌ Erro verificar envios:', error.message);
  }
}

async function prepararEnvioToken(token, dia, hora) {
  const uid = String(token);
  try {
    console.log(`[${uid}] 🔧 Preparando envio para ${hora}h (Brasil), dia ${dia}`);
    if (!await verificarImagemLocal(uid, dia)) return;
    if (!await verificarMensagemToken(uid, dia)) return;
    if (!await verificarGruposToken(uid)) return;
    console.log(`[${uid}] ✅ Token preparado`);
    await garantirClientePronto(uid);
  } catch (error) {
    console.error(`[${uid}] ❌ Erro ao preparar envio:`, error.message);
  }
}

async function executarEnviosProgramados(enviadosHoje) {
  try {
    const horaBrasil = obterHoraBrasil();
    const diaBrasil = obterDiaBrasil();
    const dataBrasil = obterDataBrasil();
    if (diaBrasil === 0) {
      console.log('⛔ Domingo - sem envios');
      return;
    }

    const horariosData = await fetchWithCache(
      'https://atentus.cloud/api/api.php/horarios',
      {
        method: 'GET',
        headers: { 'Authorization': 'Bearer 123456abcdef','Content-Type': 'application/json','Accept': 'application/json' },
        timeout: 15000
      },
      cacheHorarios,
      'horarios_global'
    );

    const tokensParaEnviarAgora = horariosData.filter(item => {
      if (!item.TOKEN || !item.HORARIOS) return false;
      const horarios = item.HORARIOS.split(',').map(h => parseInt(h.trim())).filter(h => !isNaN(h));
      return horarios.includes(horaBrasil);
    });

    for (const tokenData of tokensParaEnviarAgora) {
      await executarEnvioToken(tokenData.TOKEN, diaBrasil, horaBrasil, enviadosHoje);
      if (tokensParaEnviarAgora.length > 1) {
        console.log(`[GLOBAL] ⏱️ Delay 5s entre tokens...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

  } catch (error) {
    console.error('❌ Erro execução envios:', error.message);
  }
}

async function executarEnvioToken(token, dia, hora, enviadosHoje) {
  const uid = String(token);
  try {
    if (!enviadosHoje.has(uid)) enviadosHoje.set(uid, new Set());
    const enviadosToken = enviadosHoje.get(uid);
    const chaveEnvio = `${dia}-${hora}`;
    if (enviadosToken.has(chaveEnvio)) return;

    console.log(`[${uid}] 🚀 Executando envio para dia ${dia}, hora ${hora}h (Brasil)`);
    const mensagem = await buscarMensagemToken(uid, dia);
    const grupos = await buscarGruposToken(uid);
    const media = await buscarImagemLocal(uid, dia);
    const client = await obterClientePronto(uid);

    if (!mensagem || !grupos.length || !media || !client) return;

    await realizarEnviosToken(uid, client, grupos, media, mensagem);
    enviadosToken.add(chaveEnvio);
    console.log(`[${uid}] ✅ Envios concluídos: ${chaveEnvio}`);
  } catch (error) {
    console.error(`[${uid}] ❌ Erro no envio:`, error.message);
  }
}

// ====== FUNÇÕES AUXILIARES COM CACHE ======

async function verificarMensagemToken(token, dia) {
  try {
    const dados = await fetchWithCache(
      'https://atentus.cloud/api/api.php/messagem',
      { method: 'GET', headers: { 'Authorization': 'Bearer 123456abcdef','Content-Type': 'application/json','Accept': 'application/json' }, timeout: 10000 },
      cacheMensagem,
      'mensagem_global'
    );
    const mensagemToken = dados.find(m => m.TOKEN?.toString() === token.toString() && m.DIA?.toLowerCase() === diaMap[dia]?.toLowerCase());
    return !!mensagemToken?.MESSAGE;
  } catch (error) {
    console.error(`[${token}] Erro verificar mensagem:`, error.message);
    return false;
  }
}

async function buscarMensagemToken(token, dia) {
  try {
    const dados = await fetchWithCache(
      'https://atentus.cloud/api/api.php/messagem',
      { method: 'GET', headers: { 'Authorization': 'Bearer 123456abcdef','Content-Type': 'application/json','Accept': 'application/json' }, timeout: 10000 },
      cacheMensagem,
      'mensagem_global'
    );
    const mensagemToken = dados.find(m => m.TOKEN?.toString() === token.toString() && m.DIA?.toLowerCase() === diaMap[dia]?.toLowerCase());
    return mensagemToken?.MESSAGE?.replace(/\\n/g, '\n') || null;
  } catch (error) {
    console.error(`[${token}] Erro buscar mensagem:`, error.message);
    return null;
  }
}

async function verificarGruposToken(token) {
  try {
    const dados = await fetchWithCache(
      'https://atentus.cloud/api/api.php/gruposcheck',
      { method: 'GET', headers: { 'Authorization': 'Bearer 123456abcdef','Content-Type': 'application/json','Accept': 'application/json' }, timeout: 10000 },
      cacheGrupos,
      'grupos_global'
    );
    const gruposToken = dados.filter(g => g.TOKEN?.toString() === token.toString());
    return gruposToken.length > 0;
  } catch (error) {
    console.error(`[${token}] Erro verificar grupos:`, error.message);
    return false;
  }
}

async function buscarGruposToken(token) {
  try {
    const dados = await fetchWithCache(
      'https://atentus.cloud/api/api.php/gruposcheck',
      { method: 'GET', headers: { 'Authorization': 'Bearer 123456abcdef','Content-Type': 'application/json','Accept': 'application/json' }, timeout: 10000 },
      cacheGrupos,
      'grupos_global'
    );
    return dados.filter(g => g.TOKEN?.toString() === token.toString()).map(g => ({ id: g.ID_GROUP, nome: g.NOME || 'Nome não disponível' }));
  } catch (error) {
    console.error(`[${token}] Erro buscar grupos:`, error.message);
    return [];
  }
}
async function buscarImagemLocal(token, dia) {
  try {
    const nomeImagem = imagemMap[dia];
    if (!nomeImagem) return null;
    const exts = ['jpg', 'png'];
    for (const ext of exts) {
      const caminho = path.join(__dirname, 'assets', token, `${nomeImagem}.${ext}`);
      if (fs.existsSync(caminho)) return MessageMedia.fromFilePath(caminho);
    }
    return null;
  } catch (error) {
    console.error(`[${token}] Erro ao buscar imagem:`, error.message);
    return null;
  }
}

async function garantirClientePronto(token) {
  const uid = String(token);
  try {
    const clienteExistente = clients.get(uid);
    const estadoExistente = clientStates.get(uid);
    if (clienteExistente && !clienteExistente.destroyed && estadoExistente?.connected) {
      console.log(`[${uid}] ✅ Cliente já está pronto`);
      return;
    }
    console.log(`[${uid}] 🔄 Inicializando cliente...`);
    await startClient(uid, clients, clientStates);
    await new Promise(resolve => setTimeout(resolve, 2000));
  } catch (error) {
    console.error(`[${uid}] ❌ Erro ao garantir cliente:`, error.message);
  }
}

async function obterClientePronto(token) {
  const uid = String(token);
  try {
    let client = clients.get(uid);
    let estado = clientStates.get(uid);
    if (!client || client.destroyed || !estado?.connected) {
      console.log(`[${uid}] 🔄 Cliente não pronto, inicializando...`);
      await startClient(uid, clients, clientStates);
      let tentativas = 0;
      while (tentativas < 30) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        client = clients.get(uid);
        estado = clientStates.get(uid);
        if (client && !client.destroyed && estado?.connected) {
          console.log(`[${uid}] ✅ Cliente pronto após ${tentativas * 2}s`);
          break;
        }
        tentativas++;
      }
    }
    if (client && !client.destroyed && estado?.connected) {
      try {
        const whatsappState = await client.getState();
        if (whatsappState === 'CONNECTED') return client;
      } catch (error) {
        console.log(`[${uid}] ⚠️ Erro ao verificar estado WhatsApp: ${error.message}`);
      }
    }
    return null;
  } catch (error) {
    console.error(`[${uid}] ❌ Erro ao obter cliente:`, error.message);
    return null;
  }
}

async function realizarEnviosToken(token, client, grupos, media, mensagem) {
  const uid = String(token);
  const salvarHistorico = async (dados) => {
    try {
      const caminhoArquivo = path.join(__dirname, `historico-envios-${uid}.json`);
      let historicoEnvios = [];
      try {
        const arquivoExistente = await fsPromises.readFile(caminhoArquivo, 'utf8');
        historicoEnvios = JSON.parse(arquivoExistente);
      } catch { historicoEnvios = []; }
      historicoEnvios.push(dados);
      await fsPromises.writeFile(caminhoArquivo, JSON.stringify(historicoEnvios, null, 2));
    } catch (erro) {
      console.error(`[${uid}] ❌ Erro ao salvar histórico:`, erro.message);
    }
  };

  console.log(`[${uid}] 📤 Iniciando envios para ${grupos.length} grupos...`);

  for (let i = 0; i < grupos.length; i++) {
    const grupo = grupos[i];
    const inicioEnvioBrasil = obterDataBrasil();
    const horaMsg = inicioEnvioBrasil.toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const dataMsg = inicioEnvioBrasil.toLocaleDateString('pt-BR');

    try {
      console.log(`[${uid}] ⏳ Enviando para grupo ${i+1}/${grupos.length}: ${grupo.nome || grupo.id}`);
      const state = await client.getState();
      if (state !== 'CONNECTED') throw new Error(`Cliente desconectado (${state})`);
      const chat = await client.getChatById(grupo.id);
      const nomeGrupo = chat.name || grupo.nome || 'Nome não disponível';

      await Promise.race([
        client.sendMessage(grupo.id, media, { caption: mensagem }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout no envio')), 30000))
      ]);

      console.log(`[${uid}] ✅ Sucesso: ${nomeGrupo}`);
      await salvarHistorico({
        id: Date.now() + Math.random(),
        grupoId: grupo.id,
        status: 'sucesso',
        hora: horaMsg,
        data: dataMsg,
        nome: nomeGrupo,
        timestamp: inicioEnvioBrasil.toISOString(),
        posicao: `${i+1}/${grupos.length}`,
        mensagem: `Mensagem enviada com sucesso para<br>${nomeGrupo}`
      });

    } catch (erroEnvio) {
      console.error(`[${uid}] ❌ Erro ao enviar para ${grupo.id}: ${erroEnvio.message}`);
      await salvarHistorico({
        id: Date.now() + Math.random(),
        grupoId: grupo.id,
        status: 'erro',
        hora: horaMsg,
        data: dataMsg,
        nome: grupo.nome || 'Nome não disponível',
        timestamp: inicioEnvioBrasil.toISOString(),
        posicao: `${i+1}/${grupos.length}`,
        mensagem: `Erro ao enviar para<br>${grupo.nome || grupo.id}:<br>${erroEnvio.message}`,
        erro: erroEnvio.message
      });
    }

    if (i < grupos.length - 1) {
      console.log(`[${uid}] ⏱️ Delay 5s...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log(`[${uid}] 🎉 Envios concluídos`);
}

function mostrarInfoTimezone() {
  const agora = new Date();
  const horaUTC = agora.getUTCHours();
  const horaBrasil = obterHoraBrasil();
  const dataBrasil = obterDataBrasil();
  console.log('⏰ DEBUG TIMEZONE:');
  console.log(`   UTC: ${horaUTC}h`);
  console.log(`   Brasil: ${horaBrasil}h`);
  console.log(`   Data Brasil: ${dataBrasil.toLocaleString('pt-BR')}`);
  console.log(`   Offset configurado: UTC${TIMEZONE_OFFSET}`);
}

//*****FIM AGENDAR ENVIOS NOVO COM TIMEZONE *****



// ROTAS ==================================================

app.get('/index', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// ==============================
// Iniciar sessão
// ==============================

// Rota para verificação manual do estado do cliente
app.get('/debug-auth/:userId', async (req, res) => {
  const uid = String(req.params.userId);
  const client = clients.get(uid);
  
  if (!client) {
    return res.json({ error: 'Cliente não encontrado' });
  }
  
  try {
    const debugInfo = {
      clientExists: !!client,
      destroyed: client.destroyed,
      readyFired: false, // Você precisará expor esta variável do startClient
      authCompleted: false, // Você precisará expor esta variável do startClient
      
      // Informações do objeto client
      clientType: typeof client,
      availableMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(client)),
      hasGetChats: typeof client.getChats,
      
      // Testes diretos
      getState: null,
      getStateError: null,
      clientInfo: null,
      chatsCount: null,
      chatsError: null
    };
    
    // Teste getState
    try {
      debugInfo.getState = await Promise.race([
        client.getState(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 5s')), 5000))
      ]);
    } catch (error) {
      debugInfo.getStateError = error.message;
    }
    
    // Teste client.info
    try {
      debugInfo.clientInfo = client.info;
    } catch (error) {
      debugInfo.clientInfoError = error.message;
    }
    
    // Teste getChats com verificação prévia
    try {
      // VERIFICAR SE O MÉTODO EXISTS ANTES DE CHAMAR
      if (typeof client.getChats === 'function') {
        const chats = await Promise.race([
          client.getChats(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 10s')), 10000))
        ]);
        debugInfo.chatsCount = chats ? chats.length : 0;
      } else {
        debugInfo.chatsError = `getChats não é uma função (tipo: ${typeof client.getChats})`;
      }
    } catch (error) {
      debugInfo.chatsError = error.message;
    }
    
    res.json(debugInfo);
    
  } catch (error) {
    res.json({ error: error.message });
  }
});


app.get('/client-state/:userId', async (req, res) => {
  const uid = String(req.params.userId);
  const estado = await verificarEstadoCliente(uid);
  res.json(estado);
});

app.post('/start/:userId', async (req, res) => {
  const uid = String(req.params.userId);
  try {
    console.log(`[${uid}] 📡 Recebida solicitação de start`);
    
    // Verificar estado atual
    const currentState = clientStates.get(uid);
    const existingClient = clients.get(uid);
    
    if (existingClient && !existingClient.destroyed && currentState?.connected) {
      console.log(`[${uid}] Cliente já conectado, retornando estado atual`);
      return res.json({ ok: true, userId: uid, state: currentState });
    }
    
    await startClient(uid, clients, clientStates);
    const state = clientStates.get(uid) || { connected: false, qr: null };
    res.json({ ok: true, userId: uid, state });
  } catch (e) {
    console.error(`[${uid}] Erro ao iniciar sessão:`, e);
    res.status(500).json({ ok: false, error: 'Falha ao iniciar sessão', details: e.message });
  }
});
// ==============================
// Status da sessão
// ==============================
// Adicione esta rota para debug
// Adicione estas rotas para testar o MongoDB:

// Rota para verificar status do MongoDB
app.get('/mongo-status', async (req, res) => {
  try {
    const status = {
      readyState: mongoose.connection.readyState,
      state: ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown',
      connected: mongoose.connection.readyState === 1,
      host: mongoose.connection.host,
      port: mongoose.connection.port,
      database: mongoose.connection.name,
      collections: []
    };

    if (status.connected) {
      const collections = await mongoose.connection.db.listCollections().toArray();
      status.collections = collections.map(c => c.name);
      
      // Verificar se a collection de sessões existe
      const sessionsCollection = mongoose.connection.db.collection('sessions');
      status.sessionCount = await sessionsCollection.countDocuments();
    }

    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rota para testar conexão MongoDB
app.get('/test-save/:userId', async (req, res) => {
  const uid = String(req.params.userId);
  const client = clients.get(uid);
  
  if (!client || !client.authStrategy) {
    return res.json({ error: 'Cliente ou authStrategy não encontrado' });
  }
  
  try {
    console.log(`[${uid}] TESTE: Tentando salvar sessão manualmente...`);
    const result = await client.authStrategy.saveSession();
    console.log(`[${uid}] TESTE: Resultado do saveSession:`, result);
    
    res.json({ 
      success: true, 
      saved: result,
      message: 'Teste de salvamento concluído'
    });
  } catch (error) {
    console.error(`[${uid}] TESTE: Erro no saveSession:`, error);
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// STATUS (multiusuário): igual ao antigo, mas com :userId
app.get('/status/:userId', (req, res) => {
  const uid = String(req.params.userId);
  const state = clientStates.get(uid) || { connected: false, qr: null };
  
  res.json(state);
});


// QR (útil pra front que queira buscar só o QR)
app.get('/qr/:userId', (req, res) => {
  const uid = String(req.params.userId);
  const st = clientStates.get(uid) || { qr: null };
  res.json({ qr: st.qr || null });
});


// RESTART (manual): destrói APENAS em memória e recria, preservando sessão no Mongo
app.post('/restart/:userId', async (req, res) => {
  const uid = String(req.params.userId);
  try {
    const old = clients.get(uid);
    if (old) {
      if (old.authStrategy?.saveSession) await old.authStrategy.saveSession();
      await old.destroy();
      clients.delete(uid);
      console.log(`[${uid}] Cliente antigo destruído`);
    }
    
    // Passe os maps como parâmetros
    await startClient(uid, clients, clientStates);
    res.json({ message: 'Reiniciado com sucesso.' });
  } catch (e) {
    res.status(500).json({ error: 'Falha no restart', details: e.message });
  }
});

// LOGOUT (front "sair do sistema"): NÃO apagar sessão. Só derruba em memória.
// o cron e o backend ainda podem subir/usar quando quiserem.
app.post('/logout/:userId', async (req, res) => {
  const uid = String(req.params.userId);
  try {
    const c = clients.get(uid);
    if (c) {
      if (c.authStrategy?.saveSession) await c.authStrategy.saveSession();
      await c.destroy();            // mantém sessão no Mongo
      clients.delete(uid);
      console.log(`[${uid}] Cliente destruído em memória; sessão preservada`);
    }
    clientStates.set(uid, { connected: false, qr: null, status: 'logged_out', message: 'Sessão ativa no servidor' });
    res.json({ message: 'Logout concluído. Sessão permanece ativa no servidor.' });
  } catch (e) {
    res.status(500).json({ error: 'Falha no logout', details: e.message });
  }
});



//ROTA PARA SALVAR IMAGENS
const upload = multer({ storage: multer.memoryStorage() });

/*app.post('/upload', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Nenhum arquivo enviado' });

  const diaSemana = req.body.diaSemana?.toLowerCase();
  const nomeBase = {
    segunda: 'diaum',
    terca: 'diadois',
    quarta: 'diatres',
    quinta: 'diaquatro',
    sexta: 'diacinco',
    sabado: 'diaseis'
  }[diaSemana] || 'desconhecido';

  const ext = path.extname(req.file.originalname);
  const nomeFinal = `${nomeBase}${ext}`;
  const caminhoFinal = path.join(assetsDir, nomeFinal);

  fs.writeFile(caminhoFinal, req.file.buffer, err => {
    if (err) return res.status(500).json({ message: 'Erro ao salvar' });
    res.json({ message: 'Arquivo salvo com sucesso', filename: nomeFinal });
  });
});
*/

// ROTA PARA SALVAR IMAGENS (COM COMPRESSÃO DIRETA OTIMIZADA)
app.post('/upload', upload.single('arquivo'), async (req, res) => {
  try {
        if (!req.file) {
            return res.status(400).json({ 
                success: false,
                message: 'Nenhum arquivo enviado' 
            });
        }

        const id = req.body.idSession;
        const diaSemana = req.body.diaSemana?.toLowerCase();
        const nomeBase = {
            segunda: 'diaum',
            terca: 'diadois',
            quarta: 'diatres',
            quinta: 'diaquatro',
            sexta: 'diacinco',
            sabado: 'diaseis'
        }[diaSemana];

        if (!nomeBase) {
            return res.status(400).json({ 
                success: false,
                message: 'Dia da semana inválido' 
            });
        }

        console.log(`📤 Processando imagem ${req.file.originalname} para ${diaSemana} (${formatBytes(req.file.size)})...`);

        // Comprimir diretamente
        const imagemComprimida = await comprimirLocalmente(
            req.file.buffer,
            0.7,   // qualidade
            800    // largura máxima
        );

        // Sempre salvar como JPG
        const nomeFinal = `${nomeBase}.jpg`;
        const pathId = path.join(__dirname, `assets/${id}`);
        if (!fs.existsSync(pathId)) fs.mkdirSync(pathId);
        const caminhoFinal = path.join(pathId, nomeFinal);

        await fs.promises.writeFile(caminhoFinal, imagemComprimida);
        
        const reducao = ((1 - imagemComprimida.length / req.file.size) * 100).toFixed(1);
        console.log(`💾 Imagem salva: ${nomeFinal} (${formatBytes(imagemComprimida.length)}, redução de ${reducao}%)`);
        
        res.json({ 
            success: true,
            message: 'Imagem comprimida e salva com sucesso', 
            filename: nomeFinal,
            originalSize: req.file.size,
            compressedSize: imagemComprimida.length,
            compressionRatio: reducao + '%',
            format: 'jpg'
        });

    } catch (error) {
        console.error('❌ Erro no upload:', error);
        res.status(500).json({ 
            success: false,
            message: 'Erro ao processar imagem',
            error: error.message 
        });
    }
});

// Função para formatar bytes em formato legível
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Função de compressão local otimizada
async function comprimirLocalmente(imagemBuffer, qualidade = 0.7, larguraMaxima = 800) {
    try {
        const sharp = require('sharp');
        
        let imagem = sharp(imagemBuffer);
        const metadata = await imagem.metadata();
        
        console.log(`🖼️ Metadados: ${metadata.format?.toUpperCase()}, ${metadata.width}x${metadata.height}`);
        
        // Ajustar qualidade baseado no formato original
        let qualidadeFinal = qualidade;
        if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
            qualidadeFinal = Math.min(qualidade + 0.1, 0.9); // JPEG pode ter qualidade um pouco maior
        }
        
        // Redimensionar apenas se necessário
        if (metadata.width > larguraMaxima) {
            imagem = imagem.resize(larguraMaxima, null, {
                fit: 'inside',
                withoutEnlargement: true,
                kernel: sharp.kernel.lanczos3
            });
            console.log(`📏 Redimensionando para largura máxima: ${larguraMaxima}px`);
        }
        
        // Processar imagem
        const imagemComprimida = await imagem
            .jpeg({ 
                quality: Math.floor(qualidadeFinal * 100),
                mozjpeg: true,
                progressive: true,
                optimizeScans: true,
                chromaSubsampling: '4:4:4',
                force: true // Forçar conversão para JPEG independente do input
            })
            .toBuffer();

        return imagemComprimida;

    } catch (error) {
        console.error('❌ Erro na compressão local:', error);
        
        // Fallback simples para PNG
        if (imagemBuffer.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {
            console.log('🔄 Usando fallback para PNG');
            try {
                const sharp = require('sharp');
                return await sharp(imagemBuffer)
                    .jpeg({ quality: 75 })
                    .toBuffer();
            } catch (fallbackError) {
                console.error('❌ Fallback falhou:', fallbackError);
            }
        }
        
        // Último recurso
        return imagemBuffer;
    }
}

//ROTA PARA SALVAR MENSAGENS
app.post('/salvar', async (req, res) => {
  try {
    const { mensagemSemana, mensagem, idSession } = req.body;
    
    // Validação dos campos obrigatórios
    if (!idSession || !mensagemSemana || !mensagem) {
      console.log('Campos recebidos:', { idSession, mensagemSemana, mensagem });
      return res.status(400).json({
        sucesso: false,
        mensagem: 'Campos obrigatórios: idSession, mensagemSemana, mensagem'
      });
    }
    
    const textoFormatado = mensagem.replace(/\r?\n/g, '\\n');
    
    console.log('Dados sendo enviados para API:');
    console.log({
      TOKEN: idSession.toString(), // Converter para string se necessário
      DIA: mensagemSemana,
      MESSAGE: textoFormatado
    });
    
    const response = await axios({
      method: 'POST',
      url: 'https://atentus.cloud/api/api.php/messagem',
      headers: {
        'Authorization': 'Bearer 123456abcdef',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      data: {
        TOKEN: idSession.toString(), // Garantir que seja string
        DIA: mensagemSemana,
        MESSAGE: textoFormatado
      }
    });
    
    res.status(response.status).json({
      sucesso: true,
      dados: response.data
    });
    
  } catch (error) {
    console.error('Erro no proxy da API externa:', error.message);
    
    if (error.response) {
      console.log('Dados do erro:', error.response.data);
      return res.status(error.response.status).json({
        sucesso: false,
        mensagem: error.response.data.message || 'Erro na API externa',
        detalhes: error.response.data
      });
    }
    
    return res.status(500).json({
      sucesso: false,
      mensagem: 'Erro interno do servidor'
    });
  }
});


//horarios
app.post('/horarios', async (req, res) => {
  const { horarios, idSession } = req.body;

  try{
    if (!Array.isArray(horarios) || horarios.length === 0) {
    return res.status(400).json({ message: 'Horários inválidos' });
  }

  const unicos = [...new Set(horarios.map(h => parseInt(h)).filter(h => !isNaN(h)))];
  const ordenados = unicos.sort((a, b) => a - b);

  const conferirAPI = await fetch ('https://atentus.cloud/api/api.php/horarios', {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer 123456abcdef',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });

  let dadosConferidos = null;
  let tokenExistente = false;
  let id = null;

  if (conferirAPI.ok) {
      const dados = await conferirAPI.json();      
     
      dadosConferidos = dados.find(item => 
        item.TOKEN.toString() === idSession.toString()
      );
      
      if (dadosConferidos) {
        tokenExistente = true;
        id = dadosConferidos.ID;
      }
    }
  

  if(!tokenExistente){
    
    const response = await fetch ('https://atentus.cloud/api/api.php/horarios', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer 123456abcdef',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      TOKEN: idSession.toString(), // Converter para string se necessário
      HORARIOS: ordenados.join(',')
    })
  })
  const resultado = await response.json();

  if (response.ok && (resultado.affected_rows > 0 || response.status === 201)) {
  res.status(200).json({ message: 'Horários inseridos com sucesso', horarios: ordenados });
} else {
  res.status(500).json({ message: 'Erro ao inserir horários' });
}

  }else{
    const response = await fetch (`https://atentus.cloud/api/api.php/horarios/${id}`, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer 123456abcdef',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        TOKEN: idSession.toString(), // Converter para string se necessário
        HORARIOS: ordenados.join(',')
      })      
    });
    const resultado = await response.json();

  if (response.ok && (resultado.affected_rows > 0 || response.status === 201)) {
  res.status(200).json({ message: 'Horários atualizados com sucesso', horarios: ordenados });
} else {
  res.status(500).json({ message: 'Erro ao atualizar horários' });
}
  
  } 
  

  
  }catch (error) {
    console.error('Erro no proxy da API externa:', error.message);
    
    if (error.response) {
      console.log('Dados do erro:', error.response.data);
      return res.status(error.response.status).json({
        sucesso: false,
        mensagem: error.response.data.message || 'Erro na API externa',
        detalhes: error.response.data
      });
    }
    
    return res.status(500).json({
      sucesso: false,
      mensagem: 'Erro interno do servidor'
    });
  }
});

app.get('/horariosEscolhidos', async (req, res) => {
  try{
    const response = await fetch ('https://atentus.cloud/api/api.php/horarios', {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer 123456abcdef',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });
  const resultado = await response.json();
  res.status(200).json({ dados: resultado });
  console.log(resultado);
}catch (error) {
  console.error('Erro no proxy da API externa:', error.message);
  
  if (error.response) {
    console.log('Dados do erro:', error.response.data);
    return res.status(error.response.status).json({
      sucesso: false,
      mensagem: error.response.data.message || 'Erro na API externa',
      detalhes: error.response.data
    });
  }
  
  return res.status(500).json({
    sucesso: false,
    mensagem: 'Erro interno do servidor'
  });
}
});

app.get('/grupos/:userId', async (req, res) => {
  const userId = req.params.userId;

  try {
    const response = await fetch('https://atentus.cloud/api/api.php/gruposcan', {
  method: 'GET',
  headers: {
    'Authorization': 'Bearer 123456abcdef', // 🔑 o mesmo token que você usa no POST
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
});


    if (!response.ok) {
      throw new Error(`Erro na API: ${response.status}`);
    }

    const dados = await response.json();

    // Filtra pelo TOKEN
    const gruposUsuario = dados.filter(item => item.TOKEN == userId);

    res.json(
      gruposUsuario.map(g => ({
        id: g.ID_GROUP,
        nome: g.NOME
      }))
    );
  } catch (err) {
    console.error(`[${userId}] ❌ Erro ao buscar grupos scan:`, err);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar grupos scan' });
  }
});


// POST /grupos – salva no grupos_check.txt
app.post('/grupos/:userId', (req, res) => {
  const userId = req.params.userId;
  const grupos = req.body;
  
  if (!Array.isArray(grupos)) {
    return res.status(400).json({ error: 'Dados de grupos inválidos' });
  }
  
  try {
    const texto = grupos.map(g => `${g.id}|${g.nome}`).join('\n');
    const arquivo = path.join(__dirname, `grupos_check_${userId}.txt`);
    
    fs.writeFileSync(arquivo, texto, 'utf-8');
    console.log(`📝 ${grupos.length} grupos salvos para usuário ${userId}`);
    
    res.json({ message: 'Grupos salvos com sucesso!' });
    
  } catch (error) {
    console.error(`Erro ao salvar grupos para ${userId}:`, error);
    res.status(500).json({ error: 'Erro ao salvar grupos' });
  }
});

//meusanuncios e rotas grupos check

// ==========================
// Rotas de GruposCheck (proxy para API externa)
// ==========================
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

/**
 * GET /gruposcheck/:userId
 * Lista todos os grupos incluídos de um usuário
 */
app.get('/gruposcheck/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const response = await fetch('https://atentus.cloud/api/api.php/gruposcheck', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer 123456abcdef',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) throw new Error(`Erro na API externa: ${response.status}`);
    const dados = await response.json();

    // Filtra apenas os grupos do usuário
    const gruposUsuario = dados.filter(item => item.TOKEN?.toString() === userId.toString());

    res.json(gruposUsuario.map(g => ({
      id: g.ID_GROUP,
      nome: g.NOME
    })));
  } catch (err) {
    console.error(`[${userId}] ❌ Erro ao buscar gruposcheck:`, err.message);
    res.status(500).json({ success: false, message: 'Erro ao buscar gruposcheck' });
  }
});

/**
 * POST /gruposcheck/:userId
 * Salva novos grupos para o usuário
 */
app.post('/gruposcheck/:userId', async (req, res) => {
  const { userId } = req.params;
  const grupos = req.body;

  try {
    const resultados = [];
    
    // Envia um grupo por vez
    for (const grupo of grupos) {
      const response = await fetch('https://atentus.cloud/api/api.php/gruposcheck', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer 123456abcdef',
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          TOKEN: userId,
          ID_GROUP: grupo.ID_GROUP,
          NOME: grupo.NOME
        })
      });

      const resultado = await response.json();
      resultados.push(resultado);
      
      if (!response.ok) {
        console.error(`Erro ao salvar grupo ${grupo.ID_GROUP}:`, resultado);
      }
    }

    res.json({ success: true, results: resultados });
  } catch (err) {
    console.error(`[${userId}] ❌ Erro ao salvar gruposcheck:`, err.message);
    res.status(500).json({ success: false, message: 'Erro ao salvar gruposcheck' });
  }
});

/**
 * DELETE /gruposcheck/:userId/:groupId
 * Apaga um grupo específico
 */
app.delete('/gruposcheck/:userId/:groupId', async (req, res) => {
  const { userId, groupId } = req.params;

  try {
    // 1. Primeiro fazer GET para obter a lista completa
    const getResponse = await fetch('https://atentus.cloud/api/api.php/gruposcheck', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer 123456abcdef',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (!getResponse.ok) {
      throw new Error(`Erro ao buscar lista de grupos: ${getResponse.status}`);
    }

    const gruposList = await getResponse.json();
    
    // 2. Encontrar o grupo que corresponde ao userId (TOKEN) e groupId (ID_GROUP)
    const grupoIndex = gruposList.findIndex(grupo => 
      grupo.TOKEN == userId && grupo.ID_GROUP === groupId
    );

    if (grupoIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: `Grupo ${groupId} não encontrado para o usuário ${userId}` 
      });
    }

    // 3. Pegar o ID da posição na tabela (campo ID do objeto encontrado)
    const posicaoId = gruposList[grupoIndex].ID;
    
    const deleteResponse = await fetch(`https://atentus.cloud/api/api.php/gruposcheck/${posicaoId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': 'Bearer 123456abcdef',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (!deleteResponse.ok) {
      throw new Error(`Erro na API externa ao deletar: ${deleteResponse.status}`);
    }

    const resultado = await deleteResponse.json();
    
    console.log(`✅ Grupo ${groupId} (ID ${posicaoId}) apagado para usuário ${userId}`);
    res.json({ 
      success: true, 
      message: `Grupo ${groupId} apagado com sucesso`,
      id: posicaoId 
    });

  } catch (err) {
    console.error(`❌ Erro ao apagar grupo ${groupId} do usuário ${userId}:`, err.message);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao apagar grupo',
      error: err.message 
    });
  }
});

/**
 * DELETE /gruposcheck/:userId
 * Apaga todos os grupos de um usuário
 */
app.delete('/gruposcheck/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const response = await fetch('https://atentus.cloud/api/api.php/gruposcheck', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer 123456abcdef',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) throw new Error(`Erro na API externa: ${response.status}`);
    const dados = await response.json();

    const gruposUsuario = dados.filter(item => item.TOKEN?.toString() === userId.toString());

    for (const g of gruposUsuario) {
      await fetch(`https://atentus.cloud/api/api.php/gruposcheck/${g.ID}`, {
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer 123456abcdef',
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });
    }

    res.json({ success: true, message: 'Todos os grupos apagados' });
  } catch (err) {
    console.error(`[${userId}] ❌ Erro ao apagar todos os gruposcheck:`, err.message);
    res.status(500).json({ success: false, message: 'Erro ao apagar todos os grupos' });
  }
});


//meusanuncios preview

app.post('/anuncio/:dia', (req, res) => {
  try{
    const nomesDias = {
      segunda: 'diaum',
      terca: 'diadois',
      quarta: 'diatres',
      quinta: 'diaquatro',
      sexta: 'diacinco',
      sabado: 'diaseis'
    };

    const id = req.body.idSession; // ✅ Mudança: res.body → req.body
    console.log(id);

    const dia = req.params.dia.toLowerCase();
    const nomeImagem = nomesDias[dia];
    if (!nomeImagem) return res.status(400).json({ error: 'Dia inválido' });

    const exts = ['jpg', 'png'];
    let imagemPath = null;
    for (const ext of exts) {
      const caminho = path.join(__dirname, `assets/${id}`, `${nomeImagem}.${ext}`);
      if (fs.existsSync(caminho)) {
        imagemPath = caminho;
        break;
      }
    }

    const imagemBase64 = imagemPath
      ? `data:image/${path.extname(imagemPath).substring(1)};base64,${fs.readFileSync(imagemPath, 'base64')}`
      : '';
  res.json({ imagemBase64 });
  }catch (error) {
    console.log('Erro ao carregar anuncio', error);
    res.status(500).json(error, 'Erro ao carregar anuncio');
  }
});

// Rota GET para buscar textos por dia
app.get('/anunciotexto/:dia', async (req, res) => {
    try {
        const { dia } = req.params;
        const { idSession } = req.query; // Pega do query parameter
        
        console.log(`Buscando textos para o dia: ${dia}, TOKEN: ${idSession}`);
        
        // Faz a requisição para a API externa
        const response = await fetch('https://atentus.cloud/api/api.php/messagem', {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer 123456abcdef',
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Erro na API externa: ${response.status}`);
        }
        
        const dados = await response.json();
        
        // Filtra os dados pelo dia E pelo TOKEN (que é o idSession)
        const textosDoDia = dados.filter(item => 
            item.DIA.toLowerCase() === dia.toLowerCase() && 
            item.TOKEN.toString() === idSession.toString()
        );
        
        console.log(`Encontrados ${textosDoDia.length} textos para o dia ${dia} e TOKEN ${idSession}`);
        
        res.json({
            success: true,
            dia: dia,
            token: idSession,
            textos: textosDoDia.map(item => ({
                id: item.ID,
                token: item.TOKEN,
                message: item.MESSAGE
            }))
        });
        
    } catch (error) {
        console.error('Erro ao buscar textos:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno do servidor',
            message: error.message
        });
    }
});
    
    
      // função para ler mensagens do data.txt
    /*const lerMensagensDataTxt = () => {
      const dataPath = path.join(__dirname, 'data.txt');
      const mapa = {};
      if (fs.existsSync(dataPath)) {
        const conteudo = fs.readFileSync(dataPath, 'utf-8');
        const linhas = conteudo.split('\n').filter(Boolean);
        for (const linha of linhas) {
          const [diaTxt, ...resto] = linha.split(':');
          if (diaTxt && resto.length) {
            mapa[diaTxt.trim()] = resto.join(':').replace(/\\n/g, '\n').trim();
          }
        }
      }
      return mapa;
    };

    const mapaMensagens = lerMensagensDataTxt();
    const texto = mapaMensagens[dia] || '';*/

    
//meusanuncios duplicar
app.post('/copiar-anuncio', async (req, res) => {
  try {
    const { diaOrigem, diasDestino, idSession } = req.body;

    if (!diaOrigem || !diasDestino || !Array.isArray(diasDestino) || !idSession) {
      return res.status(400).send('Parâmetros inválidos (diaOrigem, diasDestino, idSession são obrigatórios)');
    }

    const nomesDias = { 
      segunda: 'diaum', 
      terca: 'diadois', 
      quarta: 'diatres', 
      quinta: 'diaquatro', 
      sexta: 'diacinco', 
      sabado: 'diaseis' 
    };

    const nomeOrigem = nomesDias[diaOrigem];
    if (!nomeOrigem) return res.status(400).send('Dia de origem inválido');

    // === PARTE 1: COPIAR IMAGENS ===
    const exts = ['.jpg', '.png'];
    let imagemOrigemPath = null;
    let extensao = '';

    // Buscar imagem na pasta do usuário
    for (const ext of exts) {
      const caminho = path.join(__dirname, 'assets', idSession.toString(), `${nomeOrigem}${ext}`);
      if (fs.existsSync(caminho)) {
        imagemOrigemPath = caminho;
        extensao = ext;
        break;
      }
    }

    if (!imagemOrigemPath) {
      return res.status(404).send('Imagem de origem não encontrada');
    }

    // === PARTE 2: BUSCAR TEXTO DE ORIGEM ===
    let textoOrigem = null;
    try {
      const response = await fetch('https://atentus.cloud/api/api.php/messagem', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer 123456abcdef',
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const dados = await response.json();
        const textoEncontrado = dados.find(item => 
          item.DIA.toLowerCase() === diaOrigem.toLowerCase() && 
          item.TOKEN.toString() === idSession.toString()
        );
        
        if (textoEncontrado) {
          textoOrigem = textoEncontrado.MESSAGE;
        }
      }
    } catch (error) {
      console.error('Erro ao buscar texto de origem:', error);
      return res.status(500).send('Erro ao buscar texto de origem');
    }

    if (!textoOrigem) {
      return res.status(404).send('Texto de origem não encontrado');
    }

    // === PARTE 3: COPIAR PARA DIAS DESTINO ===
    const resultados = [];

    for (const diaDestino of diasDestino) {
      const nomeDestino = nomesDias[diaDestino];
      if (!nomeDestino) {
        resultados.push(`${diaDestino}: Dia inválido`);
        continue;
      }

      try {
        // 3.1: Copiar imagem
        const pastaUsuario = path.join(__dirname, 'assets', idSession.toString());
        if (!fs.existsSync(pastaUsuario)) {
          fs.mkdirSync(pastaUsuario, { recursive: true });
        }
        
        const destinoPath = path.join(pastaUsuario, `${nomeDestino}${extensao}`);
        fs.copyFileSync(imagemOrigemPath, destinoPath);

        // 3.2: Verificar se já existe texto para este dia
        const responseVerificar = await fetch('https://atentus.cloud/api/api.php/messagem', {
          method: 'GET',
          headers: {
            'Authorization': 'Bearer 123456abcdef',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });

        let textoExistente = null;
        if (responseVerificar.ok) {
          const dados = await responseVerificar.json();
          textoExistente = dados.find(item => 
            item.DIA.toLowerCase() === diaDestino.toLowerCase() && 
            item.TOKEN.toString() === idSession.toString()
          );
        }

        // 3.3: PUT (atualizar) ou POST (criar)
        let responseTexto;
        if (textoExistente) {
          // PUT - Atualizar texto existente
          responseTexto = await fetch(`https://atentus.cloud/api/api.php/messagem/${textoExistente.ID}`, {
            method: 'PUT',
            headers: {
              'Authorization': 'Bearer 123456abcdef',
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              TOKEN: idSession.toString(),
              DIA: diaDestino,
              MESSAGE: textoOrigem
            })
          });
        } else {
          // POST - Criar novo texto
          responseTexto = await fetch('https://atentus.cloud/api/api.php/messagem', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer 123456abcdef',
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              TOKEN: idSession.toString(),
              DIA: diaDestino,
              MESSAGE: textoOrigem
            })
          });
        }

        if (responseTexto.ok) {
          const acao = textoExistente ? 'atualizado' : 'criado';
          resultados.push(`${diaDestino}: Anúncio copiado e texto ${acao} com sucesso`);
        } else {
          resultados.push(`${diaDestino}: Imagem copiada, mas erro ao salvar texto`);
        }

      } catch (error) {
        console.error(`Erro ao copiar para ${diaDestino}:`, error);
        resultados.push(`${diaDestino}: Erro ao copiar anúncio`);
      }
    }

    res.send(`Resultados da cópia:\n${resultados.join('\n')}`);

  } catch (error) {
    console.error('Erro em /copiar-anuncio:', error);
    res.status(500).send('Erro interno no servidor');
  }
});

//apagar anuncio
app.post('/apagar-anuncio', async (req, res) => {
  try {
    const { dia, idSession } = req.body; // ✅ Corrigido: idSession (não idsession)

    if (!dia || !idSession) {
      return res.status(400).send('Dia e idSession são obrigatórios.');
    }

    const nomesDias = { 
      segunda: 'diaum', 
      terca: 'diadois', 
      quarta: 'diatres', 
      quinta: 'diaquatro', 
      sexta: 'diacinco', 
      sabado: 'diaseis' 
    };
    
    const nomeArquivo = nomesDias[dia];
    if (!nomeArquivo) {
      return res.status(400).send('Dia inválido.');
    }

    let imagemApagada = false;
    let textoApagado = false;

    // === PARTE 1: APAGAR IMAGEM ===
    const exts = ['.jpg', '.png'];
    for (const ext of exts) {
      const caminho = path.join(__dirname, 'assets', idSession.toString(), `${nomeArquivo}${ext}`);
      if (fs.existsSync(caminho)) {
        fs.unlinkSync(caminho);
        imagemApagada = true;
        console.log(`Imagem apagada: ${caminho}`);
        break; // Para no primeiro arquivo encontrado
      }
    }

    // === PARTE 2: APAGAR TEXTO ===
    try {
      // Buscar o texto no banco
      const responseVerificar = await fetch('https://atentus.cloud/api/api.php/messagem', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer 123456abcdef',
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      if (responseVerificar.ok) {
        const dados = await responseVerificar.json();
        const textoExistente = dados.find(item => 
          item.DIA.toLowerCase() === dia.toLowerCase() && 
          item.TOKEN.toString() === idSession.toString()
        );

        if (textoExistente) {
          // ✅ Corrigido: DELETE não deve ter body
          const responseDelete = await fetch(`https://atentus.cloud/api/api.php/messagem/${textoExistente.ID}`, {
            method: 'DELETE',
            headers: {
              'Authorization': 'Bearer 123456abcdef',
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            }
            // ❌ REMOVIDO: DELETE não deve ter body
          });

          if (responseDelete.ok) {
            textoApagado = true;
            console.log(`Texto apagado: ID ${textoExistente.ID}`);
          } else {
            console.error('Erro ao apagar texto:', responseDelete.status, await responseDelete.text());
          }
        } else {
          console.log('Nenhum texto encontrado para apagar');
        }
      }
    } catch (error) {
      console.error('Erro ao apagar texto:', error);
    }

    // === RESPOSTA FINAL ===
    let mensagem = 'Resultados: ';
    const resultados = [];
    
    if (imagemApagada) resultados.push('imagem apagada');
    if (textoApagado) resultados.push('texto apagado');
    
    if (resultados.length > 0) {
      mensagem += resultados.join(' e ') + ' com sucesso.';
    } else {
      mensagem += 'nenhum conteúdo encontrado para apagar.';
    }

    res.status(200).send(mensagem);

  } catch (error) {
    console.error('Erro em /apagar-anuncio:', error);
    res.status(500).send('Erro interno no servidor');
  }
});

//apagar todos
app.post('/apagar-todos-anuncios', async (req, res) => {
  try {
    const { idSession } = req.body;

    if (!idSession) {
      return res.status(400).send('idSession é obrigatório.');
    }

    const nomesDias = { 
      segunda: 'diaum', 
      terca: 'diadois', 
      quarta: 'diatres', 
      quinta: 'diaquatro', 
      sexta: 'diacinco', 
      sabado: 'diaseis' 
    };

    let imagensApagadas = 0;
    let textosApagados = 0;

    // === PARTE 1: APAGAR TODAS AS IMAGENS ===
    Object.values(nomesDias).forEach(nomeArquivo => {
      ['.jpg', '.png'].forEach(ext => {
        const caminho = path.join(__dirname, 'assets', idSession.toString(), `${nomeArquivo}${ext}`);
        if (fs.existsSync(caminho)) {
          fs.unlinkSync(caminho);
          imagensApagadas++;
          console.log(`Imagem apagada: ${caminho}`);
        }
      });
    });

    // === PARTE 2: APAGAR TODOS OS TEXTOS ===
    try {
      // Buscar todos os textos do usuário
      const responseVerificar = await fetch('https://atentus.cloud/api/api.php/messagem', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer 123456abcdef',
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      if (responseVerificar.ok) {
        const dados = await responseVerificar.json();
        
        // Filtrar apenas os textos do usuário atual
        const textosDoUsuario = dados.filter(item => 
          item.TOKEN.toString() === idSession.toString()
        );

        console.log(`Encontrados ${textosDoUsuario.length} textos para apagar do usuário ${idSession}`);

        // Apagar cada texto individualmente
        for (const texto of textosDoUsuario) {
          try {
            const responseDelete = await fetch(`https://atentus.cloud/api/api.php/messagem/${texto.ID}`, {
              method: 'DELETE',
              headers: {
                'Authorization': 'Bearer 123456abcdef',
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              }
            });

            if (responseDelete.ok) {
              textosApagados++;
              console.log(`Texto apagado: ID ${texto.ID}, Dia: ${texto.DIA}`);
            } else {
              console.error(`Erro ao apagar texto ID ${texto.ID}:`, responseDelete.status);
            }
          } catch (error) {
            console.error(`Erro ao apagar texto individual ID ${texto.ID}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Erro ao buscar/apagar textos:', error);
    }

    // === PARTE 3: TENTAR REMOVER PASTA SE ESTIVER VAZIA ===
    try {
      const pastaUsuario = path.join(__dirname, 'assets', idSession.toString());
      if (fs.existsSync(pastaUsuario)) {
        const arquivosRestantes = fs.readdirSync(pastaUsuario);
        if (arquivosRestantes.length === 0) {
          fs.rmdirSync(pastaUsuario);
          console.log(`Pasta vazia removida: ${pastaUsuario}`);
        }
      }
    } catch (error) {
      console.log('Pasta não pôde ser removida (pode conter outros arquivos)');
    }

    // === RESPOSTA FINAL ===
    const resultados = [];
    if (imagensApagadas > 0) resultados.push(`${imagensApagadas} imagem(ns)`);
    if (textosApagados > 0) resultados.push(`${textosApagados} texto(s)`);

    if (resultados.length > 0) {
      res.send(`Todos os anúncios foram apagados com sucesso! Removidos: ${resultados.join(' e ')}.`);
    } else {
      res.send('Nenhum anúncio encontrado para apagar.');
    }

  } catch (error) {
    console.error('Erro em /apagar-todos-anuncios:', error);
    res.status(500).send('Erro interno no servidor');
  }
});



//teste
/*app.get('/testar-envio-agora', async (req, res) => {
  const dia = new Date().getDay(); // dia atual
  const hora = new Date().getHours(); // hora atual
  const nomeImagemBase = imagemMap[dia];
  const nomeMensagem = diaMap[dia];

  if (!nomeImagemBase || !nomeMensagem) {
    return res.send('❌ Dia inválido');
  }

  const mensagemMap = lerMensagensDataTxt();
  const texto = mensagemMap[nomeMensagem];
  if (!texto) return res.send('❌ Texto não encontrado no data.txt');

  const exts = ['.jpg', '.png'];
  let caminhoImagem = null;

  for (const ext of exts) {
    const tentativa = path.join(assetsDir, `${nomeImagemBase}${ext}`);
    if (fs.existsSync(tentativa)) {
      caminhoImagem = tentativa;
      break;
    }
  }

  if (!caminhoImagem) return res.send('❌ Imagem não encontrada');

  try {
    const media = MessageMedia.fromFilePath(caminhoImagem);
    const grupos = lerGruposDestinatarios();

    for (const grupoId of grupos) {
      await client.sendMessage(grupoId, media, { caption: texto });
      console.log(`✅ Mensagem de teste enviada para ${grupoId}`);
    }

    res.send('✅ Teste de envio manual concluído.');
  } catch (erro) {
    console.error('❌ Erro no envio de teste:', erro);
    res.send('❌ Erro ao enviar mensagem de teste');
  }
});
*/

//cadastro
const LOGIN_FILE = 'login.txt';

// Inicializar o arquivo login.txt, se não existir
async function inicializarArquivoLogin() {
  try {
    await fsPromises.access(LOGIN_FILE);
    console.log('Arquivo login.txt encontrado');
  } catch (error) {
    await fsPromises.writeFile(LOGIN_FILE, '', 'utf8');
    console.log('Arquivo login.txt criado');
  }
}

// Função para ler usuários do arquivo
async function lerUsuarios() {
  try {
    const data = await fsPromises.readFile(LOGIN_FILE, 'utf8');
    if (!data.trim()) return [];

    return data.trim().split('\n').map(linha => {
      const [login, senha] = linha.split(':');
      return { login, senha };
    }).filter(user => user.login && user.senha);
  } catch (error) {
    console.error('Erro ao ler usuários:', error);
    return [];
  }
}

// Função para salvar um novo usuário
async function salvarUsuario(login, senha) {
  try {
    const novaLinha = `${login}:${senha}\n`;
    await fsPromises.appendFile(LOGIN_FILE, novaLinha, 'utf8');
    return true;
  } catch (error) {
    console.error('Erro ao salvar usuário:', error);
    return false;
  }
}

// Verifica se o login já existe
async function usuarioExiste(login) {
  const usuarios = await lerUsuarios();
  return usuarios.some(user => user.login === login);
}

// ROTAS DA API

// Rota para cadastrar usuário
app.post('/cadastrar', async (req, res) => {
  try {
    const { login, senha, email } = req.body;

    const response = await axios({
      'method': 'POST',
     url: 'https://atentus.cloud/api/create.php',
      headers: {
        'Authorization': 'Bearer 123456abcdef',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      data: {
        login: login,
        senha: senha,
        email: email
      }
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('Erro no proxy da API externa:', error.message);

    if (error.response) {
      return res.status(error.response.status).send(error.response.data);
    }

    res.status(500).json({ sucesso: false, mensagem: 'Erro ao conectar com a API externa' });
  }
});

// Rota para fazer login

app.post('/login', async (req, res) => {
  try {
    const { login, senha } = req.body;

    const response = await axios({
      'method': 'POST',
      url: 'https://atentus.cloud/api/read.php',
      headers: {
        'Authorization': 'Bearer 123456abcdef',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      data: {
        login: login,
        senha: senha
      }
    });
    
    console.log('Resposta da API externa:', response.data);

    const { token, expiracao, usuario_id } = response.data;
    
    if (token !== null && usuario_id) {
      // Retornar os dados que o frontend está esperando
      res.status(200).json({ 
        sucesso: true, 
        mensagem: 'Login realizado com sucesso',
        token: token,
        usuario_id: usuario_id,
        expiracao: expiracao
      });
    } else {
      res.status(401).json({ 
        sucesso: false, 
        mensagem: 'Usuário ou senha incorretos' 
      });
    }

  } catch (error) {
    console.error('Erro no login:', error.message);
    
    if (error.response) {
      console.error('Erro da API externa:', error.response.status, error.response.data);
      
      // Verificar se é erro de credenciais
      if (error.response.status === 401 || error.response.status === 400) {
        return res.status(401).json({ 
          sucesso: false, 
          mensagem: 'Usuário ou senha incorretos' 
        });
      }
      
      return res.status(error.response.status).json({ 
        sucesso: false, 
        mensagem: 'Erro na autenticação' 
      });
    }

    res.status(500).json({ 
      sucesso: false, 
      mensagem: 'Erro ao conectar com o servidor de autenticação' 
    });
  }
});
     
//rotas para alterar senha
// Rota para listar usuários (confirmação de email)
app.post('/listar-usuarios', async (req, res) => {
  try {
    const response = await axios({
      'method': 'GET',
      url: 'https://atentus.cloud/api/listarUsers.php',
      headers: {
        'Authorization': 'Bearer 123456abcdef',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    console.log('Usuários listados:', response.data);
    
    // Retorna os dados diretamente
    res.status(200).json(response.data);

  } catch (error) {
    if (error.response) {
      console.error('Erro da API externa:', error.response.status, error.response.data);
      return res.status(error.response.status).json(error.response.data);
    }

    console.error('Erro no proxy da API externa:', error.message);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao conectar com a API externa' });
  }
});

// Rota para alterar senha
app.post('/alterar-senha', async (req, res) => {
  try {
    const { id, login, senha, email } = req.body;

    const senhaCriptografada = await senhaHash(senha, 10);

    // Validação básica
    if (!id || !login || !senha || !email) {
      return res.status(400).json({ 
        sucesso: false, 
        mensagem: 'Dados obrigatórios: id, login, senha, email' 
      });
    }

    const response = await axios({
      'method': 'POST',
      url: 'https://atentus.cloud/api/update.php',
      headers: {
        'Authorization': 'Bearer 123456abcdef',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      data: {
        id: id,
        login: login,
        senha: senhaCriptografada,
        email: email
      }
    });
    
    console.log('Senha alterada:', response.data);
    
    // Verifica se a alteração foi bem-sucedida
    if (response.data.sucesso !== false) {
      res.status(200).json({ 
        sucesso: true, 
        mensagem: 'Senha alterada com sucesso',
        dados: response.data 
      });
    } else {
      res.status(400).json({ 
        sucesso: false, 
        mensagem: response.data.mensagem || 'Erro ao alterar senha' 
      });
    }

  } catch (error) {
    if (error.response) {
      console.error('Erro da API externa:', error.response.status, error.response.data);
      return res.status(error.response.status).json(error.response.data);
    }

    console.error('Erro no proxy da API externa:', error.message);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao conectar com a API externa' });
  }
});

// Rota para listar usuários (apenas para debug)
app.get('/usuarios', async (req, res) => {
  try {
    const usuarios = await lerUsuarios();
    // Não retornar senhas por segurança
    const usuariosSemSenha = usuarios.map(user => ({ login: user.login }));
    res.json(usuariosSemSenha);
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});


// No seu servidor (Express, por exemplo)
app.get('/historico-envios', async (req, res) => {
  //console.log('📡 Requisição recebida para /historico-envios');
  try {
    const caminhoArquivo = path.join(__dirname, 'historico-envios.json');
    //console.log('📁 Caminho do arquivo:', caminhoArquivo);
    
    // Verificar se arquivo existe usando fs.promises
    try {
      await fs.promises.access(caminhoArquivo);
      //console.log('📄 Arquivo existe');
    } catch {
      //console.log('📄 Arquivo não encontrado');
      return res.status(404).json({ erro: 'Arquivo de histórico não encontrado' });
    }
    
    // Ler arquivo
    const dados = await fs.promises.readFile(caminhoArquivo, 'utf8');
    //console.log('📊 Dados lidos:', dados.length, 'caracteres');
    
    // Parsear JSON
    const historico = JSON.parse(dados);
    //console.log('✅ JSON parseado com', historico.length, 'itens');
    
    // Enviar resposta
    res.json(historico);
  } catch (erro) {
    console.error('❌ Erro no servidor:', erro);
    res.status(500).json({ 
      erro: 'Erro ao carregar histórico',
      detalhes: erro.message 
    });
  }
});

// Limpar histórico antigo (opcional)
app.delete('/delete-historico-envios', async (req, res) => {
  try {
    const caminhoArquivo = path.join(__dirname, 'historico-envios.json');
    await fs.promises.writeFile(caminhoArquivo, JSON.stringify([]));
    res.json({ sucesso: true });
  } catch (erro) {
    console.error('❌ Erro ao apagar histórico:', erro);
    res.status(500).json({ erro: 'Erro ao limpar histórico' });
  }
});

// Adicionar essas rotas ao seu server.js após as rotas existentes

// Rota para listar todas as sessões
app.get('/sessions-list', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(500).json({ error: 'MongoDB não conectado' });
    }

    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'sessions'
    });

    // Buscar todos os arquivos e agrupar por clientId
    const cursor = bucket.find({});
    const files = await cursor.toArray();

    const sessionsMap = new Map();

    for (const file of files) {
      const clientId = file.metadata.clientId;
      
      if (!sessionsMap.has(clientId)) {
        sessionsMap.set(clientId, {
          clientId: clientId,
          fileCount: 0,
          totalSize: 0,
          lastModified: null,
          status: clientStates.get(clientId)?.status || 'unknown',
          connected: clientStates.get(clientId)?.connected || false
        });
      }

      const session = sessionsMap.get(clientId);
      session.fileCount++;
      session.totalSize += file.length;
      
      const fileDate = file.metadata.sessionVersion || file.uploadDate;
      if (!session.lastModified || fileDate > session.lastModified) {
        session.lastModified = fileDate;
      }
    }

    const sessions = Array.from(sessionsMap.values()).map(session => ({
      ...session,
      totalSizeMB: (session.totalSize / (1024 * 1024)).toFixed(2),
      lastModified: session.lastModified ? new Date(session.lastModified).toISOString() : null
    }));

    res.json({
      success: true,
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.connected).length,
      sessions: sessions
    });

  } catch (error) {
    console.error('Erro ao listar sessões:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro ao listar sessões',
      details: error.message 
    });
  }
});

// Rota para obter informações detalhadas de uma sessão
app.get('/session-info/:userId', async (req, res) => {
  try {
    const uid = String(req.params.userId);
    const client = clients.get(uid);
    
    let authStrategy = null;
    if (client && client.authStrategy) {
      authStrategy = client.authStrategy;
    } else {
      // Criar uma instância temporária para consulta
      authStrategy = new GridFSAuthStrategy({
        clientId: uid,
        dataPath: path.join(__dirname, '.wwebjs_gridfs')
      });
    }

    const sessionInfo = await authStrategy.getSessionInfo();
    const clientState = clientStates.get(uid) || {};
    const sessionExists = await authStrategy.sessionExists();

    res.json({
      success: true,
      userId: uid,
      sessionExists: sessionExists,
      clientConnected: !!client && !client.destroyed,
      state: clientState,
      sessionInfo: sessionInfo
    });

  } catch (error) {
    console.error(`Erro ao obter info da sessão ${req.params.userId}:`, error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro ao obter informações da sessão',
      details: error.message 
    });
  }
});

// Rota para deletar sessão permanentemente
app.delete('/session/:userId', async (req, res) => {
  const uid = String(req.params.userId);
  
  try {
    // Primeiro fazer logout se cliente estiver ativo
    const client = clients.get(uid);
    if (client && !client.destroyed) {
      await client.destroy();
      clients.delete(uid);
    }

    // Criar instância temporária para deletar
    const authStrategy = new GridFSAuthStrategy({
      clientId: uid,
      dataPath: path.join(__dirname, '.wwebjs_gridfs')
    });

    const deleted = await authStrategy.deletePermanently();
    
    // Limpar estado
    clientStates.delete(uid);

    if (deleted) {
      res.json({ 
        success: true, 
        message: `Sessão ${uid} deletada permanentemente` 
      });
    } else {
      res.status(404).json({ 
        success: false, 
        message: 'Sessão não encontrada ou erro ao deletar' 
      });
    }

  } catch (error) {
    console.error(`Erro ao deletar sessão ${uid}:`, error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro ao deletar sessão',
      details: error.message 
    });
  }
});

// Rota para limpeza de sessões órfãs (sem cliente ativo)
app.post('/cleanup-sessions', async (req, res) => {
  try {
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'sessions'
    });

    // Buscar todas as sessões
    const cursor = bucket.find({});
    const files = await cursor.toArray();

    const clientIds = new Set();
    files.forEach(file => {
      if (file.metadata.clientId) {
        clientIds.add(file.metadata.clientId);
      }
    });

    let cleaned = 0;
    const maxAge = req.body.maxAgeDays || 30; // Padrão 30 dias
    const cutoffDate = new Date(Date.now() - (maxAge * 24 * 60 * 60 * 1000));

    for (const clientId of clientIds) {
      const client = clients.get(clientId);
      const state = clientStates.get(clientId);

      // Verificar se é uma sessão órfã (sem cliente ativo há mais de X dias)
      const isOrphan = !client || client.destroyed || 
        (!state?.connected && state?.timestamp && new Date(state.timestamp) < cutoffDate);

      if (isOrphan) {
        try {
          const authStrategy = new GridFSAuthStrategy({
            clientId: clientId,
            dataPath: path.join(__dirname, '.wwebjs_gridfs')
          });

          await authStrategy.deletePermanently();
          clientStates.delete(clientId);
          clients.delete(clientId);
          cleaned++;
          
          console.log(`Sessão órfã removida: ${clientId}`);
        } catch (error) {
          console.error(`Erro ao remover sessão ${clientId}:`, error);
        }
      }
    }

    res.json({
      success: true,
      message: `Limpeza concluída. ${cleaned} sessões órfãs removidas`,
      cleaned: cleaned,
      maxAgeDays: maxAge
    });

  } catch (error) {
    console.error('Erro na limpeza de sessões:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro na limpeza de sessões',
      details: error.message 
    });
  }
});

// Rota para forçar backup de uma sessão
app.post('/backup-session/:userId', async (req, res) => {
  const uid = String(req.params.userId);
  
  try {
    const client = clients.get(uid);
    
    if (!client || client.destroyed) {
      return res.status(404).json({ 
        success: false, 
        message: 'Cliente não encontrado ou não está ativo' 
      });
    }

    if (!client.authStrategy) {
      return res.status(500).json({ 
        success: false, 
        message: 'Estratégia de autenticação não encontrada' 
      });
    }

    console.log(`[${uid}] Iniciando backup forçado...`);
    const success = await client.authStrategy.saveSession();

    if (success) {
      res.json({ 
        success: true, 
        message: `Backup da sessão ${uid} realizado com sucesso` 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        message: 'Falha ao realizar backup' 
      });
    }

  } catch (error) {
    console.error(`Erro no backup da sessão ${uid}:`, error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro ao fazer backup da sessão',
      details: error.message 
    });
  }
});

// Rota para estatísticas do GridFS
app.get('/gridfs-stats', async (req, res) => {
  try {
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'sessions'
    });

    const cursor = bucket.find({});
    const files = await cursor.toArray();

    const stats = {
      totalFiles: files.length,
      totalSize: files.reduce((sum, file) => sum + file.length, 0),
      uniqueSessions: new Set(files.map(f => f.metadata.clientId)).size,
      averageFileSize: 0,
      oldestFile: null,
      newestFile: null
    };

    if (files.length > 0) {
      stats.averageFileSize = stats.totalSize / files.length;
      
      const dates = files.map(f => f.uploadDate).sort();
      stats.oldestFile = dates[0];
      stats.newestFile = dates[dates.length - 1];
    }

    // Converter para formato legível
    stats.totalSizeMB = (stats.totalSize / (1024 * 1024)).toFixed(2);
    stats.averageFileSizeKB = (stats.averageFileSize / 1024).toFixed(2);

    res.json({
      success: true,
      stats: stats
    });

  } catch (error) {
    console.error('Erro ao obter estatísticas do GridFS:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro ao obter estatísticas',
      details: error.message 
    });
  }
});

// Middleware para verificar saúde das sessões
app.get('/health-check', async (req, res) => {
  try {
    const activeClients = Array.from(clients.keys());
    const connectedClients = activeClients.filter(uid => 
      clientStates.get(uid)?.connected === true
    );

    const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    
    const health = {
      timestamp: new Date().toISOString(),
      mongodb: {
        status: mongoStatus,
        readyState: mongoose.connection.readyState
      },
      sessions: {
        total: activeClients.length,
        connected: connectedClients.length,
        disconnected: activeClients.length - connectedClients.length
      },
      memory: {
        used: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
        heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
      }
    };

    const isHealthy = mongoStatus === 'connected' && activeClients.length < 1000; // máximo 1000 clientes

    res.status(isHealthy ? 200 : 503).json({
      healthy: isHealthy,
      ...health
    });

  } catch (error) {
    res.status(500).json({
      healthy: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ========== ROTA DE DEBUG MELHORADA ==========
app.get('/force-ready/:userId', async (req, res) => {
  const uid = String(req.params.userId);
  const client = clients.get(uid);
  
  if (!client) {
    return res.json({ success: false, message: 'Cliente não encontrado' });
  }
  
  try {
    console.log(`[${uid}] 🔧 Forçando verificação de ready...`);
    
    // Tentar obter chats para verificar se está funcional
    const chats = await client.getChats();
    const state = await client.getState();
    
    if (chats && state === 'CONNECTED') {
      console.log(`[${uid}] 🎯 Cliente funcional, disparando ready`);
      client.emit('ready');
      
      res.json({ 
        success: true, 
        message: 'Ready disparado manualmente',
        chatsCount: chats.length,
        state: state
      });
    } else {
      res.json({ 
        success: false, 
        message: 'Cliente não está pronto',
        state: state,
        chatsCount: chats ? chats.length : 0
      });
    }
  } catch (error) {
    res.json({ 
      success: false, 
      message: 'Erro ao verificar cliente',
      error: error.message
    });
  }
});

app.get('/debug-session/:userId', async (req, res) => {
  const uid = String(req.params.userId);
  const userDataDir = path.join(__dirname, '.wwebjs_gridfs', uid);
  
  console.log(`📁 Verificando diretório: ${userDataDir}`);
  console.log(`📁 Existe: ${fs.existsSync(userDataDir)}`);
  
  if (fs.existsSync(userDataDir)) {
    const files = [];
    function scanDir(dirPath) {
      const items = fs.readdirSync(dirPath);
      for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const stat = fs.statSync(fullPath);
        files.push({
          name: item,
          path: fullPath,
          isDirectory: stat.isDirectory(),
          size: stat.size,
          modified: stat.mtime
        });
      }
    }
    
    scanDir(userDataDir);
    console.log('📄 Arquivos encontrados:', files);
  }
  
  res.json({ directory: userDataDir, exists: fs.existsSync(userDataDir) });
});

async function restoreClientID() {
  try {
    console.log('🔄 Tentando restaurar sessões existentes...');
    
    const response = await fetch('https://atentus.com.br:5000/sessions-list', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const resposta = await response.json();
    console.log('📋 Sessões encontradas:', resposta);
    
    if (resposta.success && resposta.sessions && resposta.sessions.length > 0) {
      console.log(`🎯 Encontradas ${resposta.sessions.length} sessões para restaurar`);
      
      // Restaurar cada sessão encontrada
      for (const session of resposta.sessions) {
        const userId = session.clientId;
        
        // Só restaurar se não estiver já ativa
        if (!clients.has(userId)) {
          try {
            console.log(`🔧 Restaurando sessão: ${userId}`);
            await startClient(userId, clients, clientStates);
          } catch (error) {
            console.error(`❌ Erro ao restaurar sessão ${userId}:`, error.message);
          }
        } else {
          console.log(`⚡ Sessão ${userId} já está ativa`);
        }
      }
    } else {
      console.log('ℹ️ Nenhuma sessão encontrada para restaurar');
    }
    
  } catch (error) {
    console.error('❌ Erro ao restaurar sessões:', error.message);
    throw error;
  }
}

const httpsServer = https.createServer(credentials, app);
async function iniciarServidor() {
  try {
    await inicializarMongoDB();
    
    httpsServer.listen(PORT, async () => {
      console.log(`🟢 Servidor rodando em http://localhost:${PORT}/index.html`);
      console.log('✅ MongoDB conectado e GridFS configurado');
      
      // 🔔 Iniciar o agendamento de envios
      agendarEnvios();
      
      // Tentar restaurar sessões após 5 segundos
      setTimeout(async () => {
        try {
          await restoreClientID();
        } catch (error) {
          console.log('⚠️ Primeira tentativa de restauração falhou, tentando periodicamente...');
          setInterval(async () => {
            try {
              await restoreClientID();
            } catch (err) {
              console.log('🔄 Tentativa de restauração falhou, tentando novamente...');
            }
          }, 30000); // A cada 30 segundos
        }
      }, 5000);
    });
    
  } catch (error) {
    console.error('❌ Servidor não pode iniciar sem MongoDB:', error);
    process.exit(1);
  }
}

// ==============================
// Monitor simples de saúde (CPU / Memória)
// ==============================
setInterval(() => {
  const mem = process.memoryUsage();
  const cpuLoad = process.cpuUsage();

  console.log("📊 Monitor de Recursos:");
  console.log(`   Memória RSS: ${Math.round(mem.rss / 1024 / 1024)} MB`);
  console.log(`   Heap usado: ${Math.round(mem.heapUsed / 1024 / 1024)} MB`);
  console.log(`   Heap total: ${Math.round(mem.heapTotal / 1024 / 1024)} MB`);
  console.log(`   CPU user: ${(cpuLoad.user / 1000000).toFixed(2)}s`);
  console.log(`   CPU system: ${(cpuLoad.system / 1000000).toFixed(2)}s`);
}, 60000); // a cada 60s


// Chamar a função em vez de app.listen direto
iniciarServidor();

