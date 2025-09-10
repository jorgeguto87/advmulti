const axios = require('axios');
const fs = require('fs');
const path = require('path');

function escutarGrupos(client, userId) {
  console.log(`[${userId}] 📱 Iniciando escuta de grupos para usuário`);

  // Caminho do cache em JSON por usuário
  const cachePath = path.join(__dirname, `grupos_cache_${userId}.json`);

  // Carregar cache existente (se houver)
  let gruposCache = new Set(); // Usar Set para busca mais rápida
  if (fs.existsSync(cachePath)) {
    try {
      const cacheArray = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      gruposCache = new Set(cacheArray.map(g => g.ID_GROUP));
    } catch (err) {
      console.error(`[${userId}] ⚠️ Erro ao ler cache JSON, iniciando vazio`);
      gruposCache = new Set();
    }
  }

  // Set para controle de grupos sendo processados no momento (evita duplicatas simultâneas)
  const processandoGrupos = new Set();

  function salvarCache() {
    try {
      const cacheArray = Array.from(gruposCache).map(id => ({ ID_GROUP: id }));
      fs.writeFileSync(cachePath, JSON.stringify(cacheArray, null, 2));
    } catch (error) {
      console.error(`[${userId}] ❌ Erro ao salvar cache: ${error.message}`);
    }
  }

  async function processarGrupo(msg) {
    try {
      const isFromGroup = typeof msg.from === 'string' && msg.from.endsWith('@g.us');
      const isToGroup = typeof msg.to === 'string' && msg.to.endsWith('@g.us');

      if (!(isFromGroup || isToGroup)) return;

      const grupoId = isFromGroup ? msg.from : msg.to;

      // ✅ Verifica se já está no cache (busca O(1) com Set)
      if (gruposCache.has(grupoId)) {
        return;
      }

      // ✅ Verifica se já está sendo processado no momento
      if (processandoGrupos.has(grupoId)) {
        console.log(`[${userId}] ⏳ Grupo já está sendo processado: ${grupoId}`);
        return;
      }

      // Marca como sendo processado
      processandoGrupos.add(grupoId);

      try {
        // Obter informações do chat
        let nomeGrupo;
        try {
          const chat = await msg.getChat();
          nomeGrupo = chat?.name || 'Nome não disponível';
        } catch (chatError) {
          console.error(`[${userId}] ⚠️ Erro ao obter informações do chat ${grupoId}:`, chatError.message);
          nomeGrupo = 'Erro ao obter nome';
        }

        // Envia para a API
        await axios.post(
          'https://atentus.cloud/api/api.php/gruposcan',
          {
            TOKEN: userId.toString(),
            ID_GROUP: grupoId,
            NOME: nomeGrupo
          },
          {
            headers: {
              'Authorization': 'Bearer 123456abcdef',
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            timeout: 10000 // Timeout de 10 segundos
          }
        );

        // ✅ Só adiciona ao cache APÓS sucesso na API
        gruposCache.add(grupoId);
        salvarCache();

        console.log(`[${userId}] ✅ Grupo enviado e salvo no cache: ${grupoId} | ${nomeGrupo}`);

      } catch (apiError) {
        console.error(`[${userId}] ❌ Erro ao enviar grupo para API ${grupoId}:`, apiError.message);
        
        // ✅ Em caso de erro na API, NÃO adiciona ao cache
        // Assim tentará enviar novamente na próxima mensagem do grupo
      } finally {
        // Remove da lista de processamento
        processandoGrupos.delete(grupoId);
      }

    } catch (error) {
      console.error(`[${userId}] ❌ Erro geral ao processar mensagem do grupo:`, error.message);
      // Remove da lista de processamento em caso de erro
      const grupoId = (typeof msg.from === 'string' && msg.from.endsWith('@g.us')) ? msg.from : msg.to;
      if (processandoGrupos.has(grupoId)) {
        processandoGrupos.delete(grupoId);
      }
    }
  }

  client.on('message', processarGrupo);
  client.on('message_create', processarGrupo);

  return function stopListening() {
    try {
      client.removeAllListeners('message');
      client.removeAllListeners('message_create');
      processandoGrupos.clear();
      console.log(`[${userId}] 🛑 Listeners de grupos removidos`);
    } catch (e) {
      console.error(`[${userId}] Erro ao remover listeners:`, e);
    }
  };
}

module.exports = escutarGrupos;