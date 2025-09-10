let usuarioLogado = false;
let sessionToken = null;
let loginUsuario = null;

// Páginas que não requerem login
const paginasPublicas = ['login', 'cadastro', 'confirm', 'senha'];



// Função para verificar se o usuário está logado
function verificarAutenticacao() {
  // Verifica se existe um token de sessão válido
  const token = sessionStorage.getItem('sessionToken');
  const loginStatus = sessionStorage.getItem('usuarioLogado');
  const userId = sessionStorage.getItem('userId');
  
  if (token && loginStatus === 'true' && userId) {
    usuarioLogado = true;
    sessionToken = token;
    loginUsuario = parseInt(userId); // Converter para número
    
    console.log('Autenticação verificada:');
    console.log('loginUsuario recuperado:', loginUsuario);
    
    return true;
  }
  return false;
}

// Função para fazer login (agora usando API)
async function realizarLogin(username, password) {
  try {
    const response = await fetch('https://atentus.com.br:5000/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        login: username,
        senha: password
      })
    });
    
    const resultado = await response.json();
    
    if (resultado.sucesso) {
      usuarioLogado = true;
      sessionToken = resultado.token;
      loginUsuario = resultado.usuario_id; // Usar o usuario_id retornado pela API
      
      // Salvar estado de login na sessão
      sessionStorage.setItem('usuarioLogado', 'true');
      sessionStorage.setItem('sessionToken', sessionToken);
      sessionStorage.setItem('loginUsuario', username);
      sessionStorage.setItem('userId', resultado.usuario_id.toString()); // Salvar o usuario_id
      
      // Debug - verificar os valores
      console.log('Login realizado:');
      console.log('sessionToken:', sessionToken);
      console.log('loginUsuario (usuario_id):', loginUsuario);
      console.log('Data completa:', resultado);
      
      // Mostrar/esconder elementos baseado no login
      atualizarInterfaceLogin();
      
      return { sucesso: true, mensagem: resultado.mensagem };
      
    } else {
      return { sucesso: false, mensagem: resultado.mensagem };
    }
    
  } catch (error) {
    console.error('Erro no login:', error);
    return { sucesso: false, mensagem: 'Erro de conexão com o servidor' };
  }
}

// Função para cadastrar usuário (agora usando API)
async function realizarCadastroUsuario(login, senha, email) {
  
  try {
    const response = await fetch('https://atentus.com.br:5000/cadastrar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        login: login,
        senha: senha,
        email: email
      })
    });
    
    const resultado = await response.json();
    
    alert('Resposta do servidor:', resultado);
    
    return {
      sucesso: resultado.sucesso,
      mensagem: resultado.mensagem
    };
    
  } catch (error) {
    console.error('Erro no cadastro:', error);
    return {
      sucesso: false,
      mensagem: 'Erro de conexão com o servidor'
    };
  }
}

// Função para fazer logout
function realizarLogout() {
  usuarioLogado = false;
  sessionToken = null;
  loginUsuario = null;
  
  // Limpar dados da sessão
  sessionStorage.removeItem('usuarioLogado');
  sessionStorage.removeItem('sessionToken');
  sessionStorage.removeItem('loginUsuario');
  
  // Atualizar interface
  atualizarInterfaceLogin();
  
  // Redirecionar para login
  carregarPagina('login');
}

// Função para atualizar a interface baseada no status de login
function atualizarInterfaceLogin() {
  const navLinks = document.querySelectorAll('[data-page]');
  
  navLinks.forEach(link => {
    const pagina = link.getAttribute('data-page');
    
    if (!paginasPublicas.includes(pagina)) {
      if (usuarioLogado) {
        link.style.display = 'block';
        link.style.pointerEvents = 'auto';
        link.style.opacity = '1';
      } else {
        link.style.display = 'none';
      }
    }
  });
  
  // Mostrar nome do usuário logado se houver elemento para isso
  const userDisplay = document.getElementById('usuarioLogado');
  if (userDisplay) {
    const nomeUsuario = sessionStorage.getItem('loginUsuario');
    if (usuarioLogado && nomeUsuario) {
      userDisplay.textContent = `Bem-vindo, ${nomeUsuario}!`;
      userDisplay.style.display = 'block';
    } else {
      userDisplay.style.display = 'none';
    }
  }
}

function carregarPagina(pagina) {
  // Verificar se a página requer autenticação
  if (!paginasPublicas.includes(pagina) && !verificarAutenticacao()) {
    alert('Você precisa fazer login para acessar esta página!');
    carregarPagina('login');
    return;
  }
  

if (pagina !== 'sair') {
  // Debug: verificar se o arquivo existe
  console.log(`Tentando carregar: pages/${pagina}.html`);
  
  fetch(`https://atentus.com.br:5000/pages/${pagina}.html`)
    .then(response => {
      if (!response.ok) {
        throw new Error(`Arquivo não encontrado: pages/${pagina}.html (${response.status})`);
      }
      return response.text();
    })
    .then(html => {
      const main = document.querySelector('main') || document.getElementById('main');
      if (main) {
        main.innerHTML = html;
      }
      
      // Atualizar navegação ativa
      const activeLinks = document.querySelectorAll('.nav-link.active');
      activeLinks.forEach(link => link.classList.remove('active'));
      
      const currentLink = document.querySelector(`[data-page="${pagina}"]`);
      if (currentLink) {
        currentLink.classList.add('active');
      }else if (pagina === 'historico') {
  iniciarAtualizacaoAutomatica(); // Inicia o carregamento automático
}
      
      // Inicializar funcionalidades específicas da página
      if (pagina === 'login') {
  inicializarLogin();
} else if (pagina === 'cadastro') {
  botaoLogin();
  inicializarElementosPagina();
  inicializarCadastro();
} else {
  inicializarElementosPagina();

  if (pagina === 'confirm') {
    inicializarPaginaConfirm();
  } else if (pagina === 'senha') {
    inicializarPaginaSenha();
  } 

  
}

      
      // Atualizar interface baseada no login
      atualizarInterfaceLogin();
      
      console.log(`Página ${pagina} carregada com sucesso`);
    })
    .catch((error) => {
      console.error('Erro detalhado:', error);
      const main = document.querySelector('main') || document.getElementById('main');
      if (main) {
        if (pagina === 'anuncios') {
          const nomeUsuario = sessionStorage.getItem('loginUsuario') || 'Usuário';
          main.innerHTML = `
            <div style="text-align: center; padding: 2rem;">
              <h2>Bem-vindo, ${nomeUsuario}!</h2>
              <p>Login realizado com sucesso.</p>
              <p><small>Arquivo pages/anuncios.html não encontrado.</small></p>
              <button onclick="realizarLogout()" style="background: #dc3545; color: white; border: none; border-radius: 4px;">
                Fazer Logout
              </button>
            </div>
          `;
        } else {
          main.innerHTML = `
            <div style="text-align: center; padding: 2rem;">
              <h2>Erro ao carregar página</h2>
              <p>Não foi possível carregar: <strong>${pagina}.html</strong></p>
              <p><small>${error.message}</small></p>
              <button onclick="carregarPagina('login')">
                Voltar ao Login
              </button>
            </div>
          `;
        }
      }
    });
}
}
// Função para inicializar o cadastro
function inicializarCadastro() {
  const btncadastrarUser = document.getElementById('btnCadastrar');
  const loginCadastro = document.getElementById('loginCadastro');
  const senhaCadastro = document.getElementById('senhaCadastro');
  const emailCadastro = document.getElementById('emailCadastro');
  const statusCadastro = document.getElementById('statusCadastro');

  if (btncadastrarUser) {
    btncadastrarUser.addEventListener('click', async (e) => {
      e.preventDefault();
      
      if (!loginCadastro || !senhaCadastro || !emailCadastro) {
        console.error('Elementos de cadastro não encontrados');
        return;
      }
      
      // Mostrar loading
      btncadastrarUser.disabled = true;
      btncadastrarUser.textContent = 'Cadastrando...';
      
      if (statusCadastro) {
        statusCadastro.textContent = 'Processando...';
        statusCadastro.style.color = 'blue';
      }
      
      const resultado = await realizarCadastroUsuario(
        loginCadastro.value.trim(),
        senhaCadastro.value.trim(),
        emailCadastro.value
      );
      console.log('Resultado do cadastro:', resultado);
      // Restaurar botão
      btncadastrarUser.disabled = false;
      btncadastrarUser.textContent = 'Cadastrar';
      
      if (statusCadastro) {
        statusCadastro.textContent = resultado.mensagem;
        statusCadastro.style.color = resultado.sucesso ? 'green' : 'red';
      }
      
      if (resultado.sucesso) {
        loginCadastro.value = '';
        senhaCadastro.value = '';
        emailCadastro.value = '';
        
        // Redirecionar para login após cadastro bem-sucedido
        setTimeout(() => {
          carregarPagina('login');
        }, 1500);
      }
    });
  } else {
    console.error('Botão de cadastro não encontrado');
  }
}

function botaoLogin(){
  const btnLogin = document.getElementById('linkLogin');
  if (btnLogin) {
    btnLogin.addEventListener('click', (e) => {
      e.preventDefault();
      carregarPagina('login');
    });
  }
}

function botaoCadastrar(){
  const btnCadastro = document.getElementById('linkCadastro');
  if (btnCadastro) {
    btnCadastro.addEventListener('click', (e) => {
      e.preventDefault();
      carregarPagina('cadastro');
    });
  }
}

function botaoEsqueciSenha(){
  const btnSenha = document.getElementById('linkSenha');
  if (btnSenha) {
    btnSenha.addEventListener('click', (e) => {
      e.preventDefault();
      carregarPagina('confirm');
    });
  }
}

function inicializarLogin() {
  const btnEntrar = document.getElementById('btnEntrar');
  
  if (btnEntrar) {
    btnEntrar.addEventListener('click', async (e) => {
      e.preventDefault();
      
      const login = document.getElementById('login');
      const senha = document.getElementById('senha');
      const statusLogin = document.getElementById('statusLogin');
      
      // Limpar status anterior
      if (statusLogin) {
        statusLogin.textContent = '';
        statusLogin.style.color = '';
      }
      
      if (login && senha) {
        // Mostrar loading
        btnEntrar.disabled = true;
        btnEntrar.textContent = 'Entrando...';
        
        if (statusLogin) {
          statusLogin.textContent = 'Verificando credenciais...';
          statusLogin.style.color = 'blue';
        }
        
        const resultado = await realizarLogin(login.value.trim(), senha.value);
        
        // Restaurar botão
        btnEntrar.disabled = false;
        btnEntrar.textContent = 'Entrar';
        
        if (resultado.sucesso) {
          // Login bem-sucedido
          if (statusLogin) {
            statusLogin.textContent = resultado.mensagem;
            statusLogin.style.color = 'green';
          }
          
          // Redirecionar para página principal após login
          setTimeout(() => {
            carregarPagina('anuncios');
          }, 500);
          
        } else {
          // Login falhou
          if (statusLogin) {
            statusLogin.textContent = resultado.mensagem;
            statusLogin.style.color = 'red';
          }
          login.value = '';
          senha.value = '';
        }
      }
    });
  }
  
  // Inicializar botão de cadastro se estiver na página de login
  botaoCadastrar();
}

// Alterar senha
// Array provisório para armazenar dados do usuário confirmado
let dadosUsuarioProvisorio = [];

// Função para confirmar email (confirm.html)
function configurarConfirmacaoEmail() {
  const btnEntrar = document.getElementById('btnConfirmar');
  const emailLogin = document.getElementById('emailLogin');
  const statusEmailConfrim = document.getElementById('statusEmailConfrim');
  
  if (btnEntrar && emailLogin && statusEmailConfrim) {
    btnEntrar.addEventListener('click', async () => {
      const email = emailLogin.value.trim();
      
      if (!email) {
        statusEmailConfrim.textContent = 'Por favor, digite um email válido';
        statusEmailConfrim.style.color = 'red';
        return;
      }
      
      // Desabilitar botão durante o processo
      btnEntrar.disabled = true;
      btnEntrar.textContent = 'Verificando...';
      statusEmailConfrim.textContent = 'Buscando usuários...';
      statusEmailConfrim.style.color = 'blue';
      
      try {
        // Buscar usuários via servidor
        const response = await fetch('https://atentus.com.br:5000/listar-usuarios', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        });
        
        if (!response.ok) {
          throw new Error(`Erro na requisição: ${response.status}`);
        }
        
        const dados = await response.json();
        console.log('Dados recebidos do servidor:', dados);
        
        // Procurar usuário pelo email
        const usuarioEncontrado = dados.usuarios.find(usuario => 
          usuario.email.toLowerCase() === email.toLowerCase()
        );
        
        if (usuarioEncontrado) {
          // Salvar dados no array provisório
          dadosUsuarioProvisorio = [{
            id: usuarioEncontrado.id,
            login: usuarioEncontrado.login,
            email: usuarioEncontrado.email,
            senha: usuarioEncontrado.senha,
            timestampConfirmacao: new Date().toISOString()
          }];
          
          statusEmailConfrim.textContent = 'Email confirmado com sucesso!';
          statusEmailConfrim.style.color = 'green';
          
          console.log('Dados salvos no array provisório:', dadosUsuarioProvisorio);
          
          // Redirecionar para página de alteração de senha após 1 segundo
          setTimeout(() => {
            carregarPagina('senha');
          }, 1000);
          
        } else {
          statusEmailConfrim.textContent = 'Email não encontrado no sistema';
          statusEmailConfrim.style.color = 'red';
          dadosUsuarioProvisorio = [];
        }
        
      } catch (error) {
        console.error('Erro ao confirmar email:', error);
        statusEmailConfrim.textContent = 'Erro ao conectar com o servidor';
        statusEmailConfrim.style.color = 'red';
        dadosUsuarioProvisorio = [];
      } finally {
        btnEntrar.disabled = false;
        btnEntrar.textContent = 'Confirmar';
      }
    });
    
    // Event listener para Enter no input
    emailLogin.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        btnEntrar.click();
      }
    });
  }
}

// Função para alterar senha (senha.html)
function configurarAlteracaoSenha() {
  const btnAlterar = document.getElementById('btnAlterar');
  const senhaOne = document.getElementById('senhaOne');
  const Newsenha = document.getElementById('Newsenha');
  const statusNewSenha = document.getElementById('statusNewSenha');
  
  if (btnAlterar && senhaOne && Newsenha && statusNewSenha) {
    btnAlterar.addEventListener('click', async () => {
      const novaSenha = senhaOne.value.trim();
      const confirmarSenha = Newsenha.value.trim();
      
      // Validações
      if (!novaSenha || !confirmarSenha) {
        statusNewSenha.textContent = 'Por favor, preencha todos os campos';
        statusNewSenha.style.color = 'red';
        return;
      }
      
      if (novaSenha !== confirmarSenha) {
        statusNewSenha.textContent = 'As senhas não coincidem';
        statusNewSenha.style.color = 'red';
        return;
      }
      
      if (novaSenha.length < 4) {
        statusNewSenha.textContent = 'A senha deve ter pelo menos 4 caracteres';
        statusNewSenha.style.color = 'red';
        return;
      }
      
      // Verificar se tem dados do usuário confirmado
      if (dadosUsuarioProvisorio.length === 0) {
        statusNewSenha.textContent = 'Erro: Confirme o email primeiro';
        statusNewSenha.style.color = 'red';
        setTimeout(() => {
          carregarPagina('confirm');
        }, 2000);
        return;
      }
      
      // Desabilitar botão durante o processo
      btnAlterar.disabled = true;
      btnAlterar.textContent = 'Alterando...';
      statusNewSenha.textContent = 'Alterando senha...';
      statusNewSenha.style.color = 'blue';
      
      const usuario = dadosUsuarioProvisorio[0];
      
      try {
        // Alterar senha via servidor
        const response = await fetch('https://atentus.com.br:5000/alterar-senha', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: usuario.id,
            login: usuario.login,
            senha: novaSenha,
            email: usuario.email
          })
        });
        
        if (!response.ok) {
          throw new Error(`Erro na requisição: ${response.status}`);
        }
        
        const result = await response.json();
        console.log('Resposta do servidor:', result);
        
        if (result.sucesso !== false) {
          statusNewSenha.textContent = 'Senha alterada com sucesso!';
          statusNewSenha.style.color = 'green';
          
          // Limpar dados provisórios
          dadosUsuarioProvisorio = [];
          
          // Redirecionar para login após 2 segundos
          setTimeout(() => {
            carregarPagina('login');
          }, 2000);
          
        } else {
          statusNewSenha.textContent = 'Erro ao alterar senha: ' + (result.mensagem || 'Erro desconhecido');
          statusNewSenha.style.color = 'red';
        }
        
      } catch (error) {
        console.error('Erro ao alterar senha:', error);
        statusNewSenha.textContent = 'Erro ao conectar com o servidor';
        statusNewSenha.style.color = 'red';
      } finally {
        btnAlterar.disabled = false;
        btnAlterar.textContent = 'Alterar';
      }
    });
    
    // Event listeners para Enter nos inputs
    senhaOne.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        Newsenha.focus();
      }
    });
    
    Newsenha.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        btnAlterar.click();
      }
    });
  }
}

// Função para limpar dados provisórios (utilitária)
function limparDadosProvisorio() {
  dadosUsuarioProvisorio = [];
  console.log('Dados provisórios limpos');
}

// Chamar as funções quando as páginas carregarem
// Adicione essas chamadas na sua função carregarPagina() ou onde for apropriado
function inicializarPaginaConfirm() {
  configurarConfirmacaoEmail();
}

function inicializarPaginaSenha() {
  configurarAlteracaoSenha();
}

//historico
let intervaloBusca = null;

const carregarHistorico = async () => {
  try {
    console.log('[Histórico] Buscando dados...');
    const response = await fetch('https://atentus.com.br:5000/historico-envios');
    
    if (!response.ok) {
      throw new Error(`Erro na requisição: ${response.status}`);
    }
    
    const historico = await response.json();
    console.log('[Histórico] Dados recebidos:', historico.length, 'registros');
    
    preencherFiltroData(historico);
    preencherTabela(historico);
    atualizarUltimaAtualizacao();
    
  } catch (erro) {
    console.error('[Histórico] Erro:', erro);
    mostrarMensagemErro('Erro ao carregar histórico. Tente recarregar a página.');
  }
};

const preencherFiltroData = (dados) => {
  const selectFiltro = document.getElementById('historico__filtro__data');
  if (!selectFiltro) return;

  // Limpa o select
  selectFiltro.innerHTML = '';

  // Adiciona opção padrão (ver tudo)
  const opcaoTodos = document.createElement('option');
  opcaoTodos.value = '';
  opcaoTodos.textContent = 'Todas as datas';
  selectFiltro.appendChild(opcaoTodos);

  // Extrai e ordena datas únicas (mais recentes primeiro)
  const datasUnicas = [...new Set(dados.map(item => item.data))].sort((a, b) => {
    const [diaA, mesA, anoA] = a.split('/').map(Number);
    const [diaB, mesB, anoB] = b.split('/').map(Number);
    return new Date(anoB, mesB - 1, diaB) - new Date(anoA, mesA - 1, diaA);
  });

  // Adiciona as opções ao select
  datasUnicas.forEach(data => {
    const opcao = document.createElement('option');
    opcao.value = data;
    opcao.textContent = data;
    selectFiltro.appendChild(opcao);
  });

  // Evento de mudança: filtrar a tabela quando mudar a data
  selectFiltro.addEventListener('change', () => {
    const dataSelecionada = selectFiltro.value;
    const dadosFiltrados = dataSelecionada
      ? dados.filter(item => item.data === dataSelecionada)
      : dados;

    preencherTabela(dadosFiltrados);
  });
};

const preencherTabela = (dados) => {
  const tbody = document.getElementById('tabela_historico_envios');
  
  if (!tbody) {
    console.error('[Histórico] Tabela não encontrada no DOM');
    return;
  }

  tbody.innerHTML = '';
  
  if (!dados || dados.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3">Nenhum envio registrado</td></tr>';
    return;
  }

  // Ordenar por data (mais recente primeiro)
  dados.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Preencher tabela
  dados.forEach(item => {
    const linha = document.createElement('tr');
    linha.innerHTML = `
      <td>${item.data || '--/--/----'}</td>
      <td>${item.hora || '--:--'}</td>
      <td>
        <span class="status">${item.status === 'sucesso' ? '✅' : '❌'}</span>
        ${item.posicao ? `<span class="posicao">(${item.posicao})</span>` : ''}
        <div class="mensagem">${item.mensagem || ''}</div>
      </td>
    `;
    tbody.appendChild(linha);
  });
};

const mostrarMensagemErro = (mensagem) => {
  const tbody = document.getElementById('tabela_historico_envios');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="3" class="erro">${mensagem}</td></tr>`;
  }
};

const iniciarAtualizacaoAutomatica = () => {
  pararAtualizacaoAutomatica();
  intervaloBusca = setInterval(carregarHistorico, 30000); // 30 segundos
  console.log('[Histórico] Atualização automática iniciada');
};

const pararAtualizacaoAutomatica = () => {
  if (intervaloBusca) {
    clearInterval(intervaloBusca);
    intervaloBusca = null;
  }
};

const atualizarUltimaAtualizacao = () => {
  const elemento = document.getElementById('ultima-atualizacao');
  if (elemento) {
    elemento.textContent = `Última atualização: ${new Date().toLocaleTimeString()}`;
  }
};

// Inicilizar Elementos da página
function inicializarElementosPagina() {
  if (!verificarAutenticacao() && !paginasPublicas.includes(getCurrentPage())) {
    carregarPagina('login');
    return;
  }

  const button = document.getElementById('emoji-button');
  const picker = document.getElementById('emoji-picker');
  const textarea = document.getElementById('input_text');

  const emojis = [
    '😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇',
    '🙂','🙃','😉','😍','🥰','😘','😗','😙','😚','😎',
    '🤩','🥳','😏','😋','😜','🤪','😝','🤑','🤗','👍',
    '👎','👌','✌️','🤞','🤟','🤘','🤙','👋','👏','🙏','👇',
    '👆','👂','👃','👄','👶','👦','👧','👨','👩','👪',
    '👫','👬','👭','👮','👯','👰','👱','👲','👳','👴',
    '👵','👶','👷','👸','👹','👺','👻','👼','👽','👾',
    '👿','💀','💂','💃','💄','💅','💆','💇','💈','💉',
    '💊','💋','💌','💍','💎','💏','💐','💑','💒','💓',
    '💔','💕','💖','💗','💘','💙','💚','💛','💜','💝',
    '💞','💟','💠','💡','💢','💣','💤','💥','💦','💧',
    '💨','💩','💪','💫','💬','💭','💮','💯','💰','💱',
    '💲','💳','💴','💵','💶','💷','💸','💹','💺','💻',
    '💼','💽','💾','💿','📀','📁','📂','📃','📄','📅',
    '📆','📇','📈','📉','📊','📋','📌','📍','📎','📏',
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔',
    '🔥','✨','⚡','💥','⭐','🎉','🎊','🎈','🥳','🎂',
    '🍾','🥂','🍻','🍹','🍕','🍔','🍟','🌮','🍩','🍪',
    '💼','📈','📉','📊','💰','💵','💳','🧾','📜','📝',
    '📅','⏰','📢','📞','📱','✔️','❌','⚠️','🚫','✅',
    '❗','❓','💡','🔔','🎯','🚀'
  ];

  if (button && picker && textarea) {
    function criarPicker() {
      picker.innerHTML = '';
      emojis.forEach(emoji => {
        const span = document.createElement('span');
        span.textContent = emoji;
        span.addEventListener('click', () => {
          const start = textarea.selectionStart;
          const end = textarea.selectionEnd;
          const text = textarea.value;
          textarea.value = text.slice(0, start) + emoji + text.slice(end);
          textarea.focus();
          textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
          picker.style.display = 'none';
        });
        picker.appendChild(span);
      });
    }

    button.addEventListener('click', () => {
      if (picker.style.display === 'none') {
        criarPicker();
        const rect = button.getBoundingClientRect();
        picker.style.position = 'absolute';
        picker.style.top = (rect.bottom + window.scrollY) + 'px';
        picker.style.left = (rect.left + window.scrollX) + 'px';
        picker.style.display = 'flex';
      } else {
        picker.style.display = 'none';
      }
    });

    document.addEventListener('click', (e) => {
      if (!picker.contains(e.target) && e.target !== button) {
        picker.style.display = 'none';
      }
    });
  }

const uploadButton = document.getElementById('upload-button');
if (uploadButton) {
  uploadButton.addEventListener('click', async () => {
    const fileInput = document.getElementById('file-input');
    const file = fileInput?.files[0];
    const diaSemana = document.getElementById('diaSemana')?.value;
    const idSession = loginUsuario;

    function exibirStatus(id, texto) {
      const campo = document.getElementById(id);
      if (campo) campo.innerHTML = texto;
    }

    if (!file) {
      exibirStatus('status_documents', 'Nenhum arquivo selecionado');
      return;
    }

    const formData = new FormData();
    formData.append('arquivo', file);
    formData.append('diaSemana', diaSemana);
    formData.append('idSession', idSession);

    const response = await fetch('https://atentus.com.br:5000/upload', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    exibirStatus('status_documents', data.message);
  });
}

const fileInput = document.getElementById('file-input');
const imagem = document.getElementById('previewImagem');
if (fileInput && imagem) {
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => imagem.src = reader.result;
      reader.readAsDataURL(file);
    }
  });
}

const campoMensagem = document.getElementById('input_text');
const uploadText = document.getElementById('upload_text');
const previewText = document.getElementById('previewText');

if (campoMensagem && uploadText && previewText) {
  uploadText.addEventListener('click', () => {
    const semanaMensagem = document.getElementById('diaSemana');
    let mensagem;
    if (semanaMensagem) {
      const valor = semanaMensagem.value;
      mensagem = valor;
    }

    // Recuperar idSession (mantendo a lógica necessária)
    let idSessao = loginUsuario;
    if (!idSessao) {
      const userIdStorage = sessionStorage.getItem('userId');
      idSessao = userIdStorage ? parseInt(userIdStorage) : null;
    }

    const dados = { 
      mensagemSemana: mensagem, 
      mensagem: campoMensagem.value,
      idSession: idSessao 
    };

    function exibirStatus(id, texto) {
      const campo = document.getElementById(id);
      if (campo) campo.textContent = texto;
    }

    // Verificar se idSession está disponível antes de enviar
    if (!idSessao) {
      exibirStatus('status_text', 'Erro: Token de sessão não encontrado. Faça login novamente.');
      return;
    }

    fetch('https://atentus.com.br:5000/salvar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados)
    })
      .then(res => res.json())
      .then(resultado => {
        if (resultado.sucesso !== false) {
          exibirStatus('status_text', 'Dados salvos com sucesso');
        } else {
          exibirStatus('status_text', resultado.mensagem || 'Erro ao salvar dados');
        }
      })
      .catch(err => {
        console.error('Erro:', err);
        exibirStatus('status_text', 'Erro de conexão com o servidor');
      });
  });

  campoMensagem.addEventListener('input', () => {
    const textoComQuebras = campoMensagem.value.replace(/\n/g, '<br>');
    previewText.innerHTML = textoComQuebras;
  });
}

  const sair = document.getElementById('btnSair');
  if (sair) {
    sair.addEventListener('click', () => {
      usuarioLogado = false;
      sessionToken = null;
      sessionStorage.removeItem('usuarioLogado');
      sessionStorage.removeItem('sessionToken');
      sessionStorage.removeItem('loginUsuario');
      atualizarInterfaceLogin();
      carregarPagina('login');
    });
  }


  const diaSemanaSelect = document.getElementById('diaSemana');
  if (diaSemanaSelect) {
    diaSemanaSelect.addEventListener('change', () => {
      const statusDocs = document.getElementById('status_documents');
      const statusText = document.getElementById('status_text');
      const previewImagem = document.getElementById('previewImagem');
      const inputText = document.getElementById('input_text');
      const previewText = document.getElementById('previewText');

      if (statusDocs) statusDocs.innerHTML = '';
      if (statusText) statusText.innerHTML = '';
      if (fileInput) fileInput.value = '';
      if (previewImagem) previewImagem.src = 'default_preview.jpg';
      if (inputText) inputText.value = '';
      if (previewText) previewText.innerHTML = '';
    });
  }
  // Gerador de Links do WhatsApp
  const inputNumero = document.getElementById('input_gen_number');
  const inputTexto = document.getElementById('input_gen_text');
  const botaoGerar = document.getElementById('gerar_link');
  const statusLink = document.getElementById('status_link');

  if (inputNumero && inputTexto && botaoGerar && statusLink) {
    botaoGerar.addEventListener('click', () => {
      const numero = inputNumero.value.trim();
      const texto = inputTexto.value.trim();

      if (!numero || !/^55\d{11}$/.test(numero)) {
        statusLink.innerText = '❌ Número inválido. Use o formato 55DD9XXXXXXXX.';
        return;
      }

      const textoCodificado = encodeURIComponent(texto);
      const link = `https://wa.me/${numero}?text=${textoCodificado}`;
      statusLink.innerHTML = `<a href="${link}" target="_blank">${link}</a>`;
    });
  }

  // Scripts específicos de páginas futuras podem ir aqui:
    // Scripts específicos de páginas futuras podem ir aqui:
 let isRestarting = false;
let isLoggingOut = false;
let intervalId = null;

if (document.getElementById('qrcode')) {
  const qrcodeImg = document.getElementById('qrcode');
  const title = document.getElementById('title');
  const subtitle = document.getElementById('subtitle');
  const loading = document.getElementById('loading');
  const statusText = document.getElementById('status');

  // 🚀 Iniciar sessão assim que abrir a tela
  async function startSession() {
    const idSession = loginUsuario;
    try {
      await fetch(`https://atentus.com.br:5000/start/${idSession}`, { method: 'POST' });
      console.log(`Sessão iniciada para usuário ${idSession}`);
    } catch (err) {
      console.error('Erro ao iniciar sessão:', err);
    }
  }

 async function checkStatus() {
  const idSession = loginUsuario;
  try {
    const res = await fetch(`https://atentus.com.br:5000/status/${idSession}`);
    const data = await res.json();
    
    // Debug log
    console.log(`Status check - Connected: ${data.connected}, Has QR: ${!!data.qr}`);

    if (data.connected) {
      qrcodeImg.style.display = 'none';
      loading.style.display = 'none';
      title.textContent = '✅ Conectado com Sucesso!';
      subtitle.textContent = 'Você já pode fechar esta página.';

      if (isRestarting || isLoggingOut) {
        statusText.textContent = '✅ Conectado com sucesso!';
      } else {
        statusText.textContent = '';
      }

      isRestarting = false;
      isLoggingOut = false;
      restartCheckStatusInterval();

    } else {
      if (data.qr) {
        qrcodeImg.src = data.qr;
        qrcodeImg.style.display = 'block';
        title.textContent = '📱 Escaneie o QR Code';
        subtitle.textContent = 'Use seu WhatsApp para escanear o código.';
      } else {
        qrcodeImg.style.display = 'none';
        title.textContent = '⏳ Gerando QR Code...';
        subtitle.textContent = 'Aguarde um momento.';
      }
      loading.style.display = 'block';

      if (!isRestarting && !isLoggingOut) {
        statusText.textContent = 'Aguardando conexão com o WhatsApp...';
      }
    }
  } catch (err) {
    console.error('Erro ao verificar status:', err);
    statusText.textContent = '❌ Erro ao verificar status. Verifique a conexão.';
  }
}

  function startCheckStatusInterval() {
    if (!intervalId) {
      intervalId = setInterval(checkStatus, 3000);
    }
  }

  function stopCheckStatusInterval() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function restartCheckStatusInterval() {
    stopCheckStatusInterval();
    startCheckStatusInterval();
  }

  async function restartBot() {
  stopCheckStatusInterval();
  isRestarting = true;
  statusText.textContent = "♻️ Reiniciando, aguarde por favor...";
  loading.style.display = 'block';
  
  // Esconder QR durante restart
  qrcodeImg.style.display = 'none';
  title.textContent = '🔄 Reiniciando...';
  subtitle.textContent = 'Aguarde enquanto reconectamos.';

  try {
    const idSession = loginUsuario;
    const res = await fetch(`https://atentus.com.br:5000/restart/${idSession}`, { method: 'POST' });
    
    if (res.ok) {
      statusText.textContent = "♻️ Reinicializado! Aguarde nova conexão...";
      // Restart do check status após 3 segundos
      setTimeout(() => {
        startCheckStatusInterval();
      }, 3000);
    } else {
      statusText.textContent = "❌ Erro ao reiniciar. Tente novamente.";
      isRestarting = false;
    }
  } catch (error) {
    console.error('Erro ao reiniciar:', error);
    statusText.textContent = "❌ Erro ao reiniciar. Tente novamente.";
    isRestarting = false;
  }
}

async function logoutBot() {
  stopCheckStatusInterval();
  isLoggingOut = true;
  statusText.textContent = "🚪 Desconectando, aguarde...";
  loading.style.display = 'block';
  
  // Esconder QR durante logout
  qrcodeImg.style.display = 'none';
  title.textContent = '🚪 Desconectando...';
  subtitle.textContent = 'Encerrando sessão atual.';

  try {
    const idSession = loginUsuario;
    const res = await fetch(`https://atentus.com.br:5000/logout/${idSession}`, { method: 'POST' });
    
    if (res.ok) {
      statusText.textContent = "🚪 Desconectado! Escaneie o QR para reconectar.";
      title.textContent = '📱 Escaneie o QR Code';
      subtitle.textContent = 'Use seu WhatsApp para escanear o código.';
      // Restart do check status após 2 segundos para pegar novo QR
      setTimeout(() => {
        isLoggingOut = false;
        startCheckStatusInterval();
      }, 2000);
    } else {
      statusText.textContent = "❌ Erro ao desconectar. Tente novamente.";
      isLoggingOut = false;
    }
  } catch (error) {
    console.error('Erro ao desconectar:', error);
    statusText.textContent = "❌ Erro ao desconectar. Tente novamente.";
    isLoggingOut = false;
  }
}

  // Botões
  const btnReconnect = document.getElementById('reconnect');
  const btnLogout = document.getElementById('logout');

  if (btnReconnect) btnReconnect.addEventListener('click', restartBot);
  if (btnLogout) btnLogout.addEventListener('click', logoutBot);

  // 🚀 Inicialização
  startSession().then(() => {
    checkStatus();
    startCheckStatusInterval();
  });
}


// ⏰ Horários (incluir dentro da função inicializarElementosPagina)
const selects = [
  'chooseHours1', 'chooseHours2', 'chooseHours3',
  'chooseHours4', 'chooseHours5', 'chooseHours6'
];

const statusEl = document.getElementById('statushorarios');
const listaEl = document.getElementById('horarios_escolhidos');
const btnConfirmar = document.getElementById('confirmar_horas');

if (btnConfirmar && listaEl && statusEl) {
  const textoOriginalBotao = btnConfirmar.innerText;

  /*function carregarHorarios() {
    fetch('/horarios')
      .then(res => {
        console.log('GET Status:', res.status);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        console.log('GET Data:', data);
        const lista = data.horarios || [];
        listaEl.innerText = lista.map(h => `${h}:00`).join(' | ');
      })
      .catch((error) => {
        console.error('GET Error:', error);
        listaEl.innerText = 'Erro ao carregar horários';
      });
  }*/

  btnConfirmar.addEventListener('click', () => {
    const valores = selects.map(id => {
      const el = document.getElementById(id);
      return el ? el.value : null;
    }).filter(v => v !== 'null' && v !== null);

    const unicos = [...new Set(valores.map(Number))].sort((a, b) => a - b);

    if (unicos.length === 0) {
      statusEl.innerText = '⚠️ Selecione pelo menos um horário';
      return;
    }

    btnConfirmar.disabled = true;
    btnConfirmar.innerText = 'Salvando...';

    fetch('https://atentus.com.br:5000/horarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ horarios: unicos, idSession: loginUsuario })
    })
      .then(res => {
        console.log('POST Status:', res.status);
        console.log('POST OK:', res.ok);
        return res.json().then(data => ({
          status: res.status,
          ok: res.ok,
          data: data
        }));
      })
      .then(response => {
        console.log('POST Response completa:', response);
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.data.message || 'Erro desconhecido'}`);
        }
        
        statusEl.innerText = '✅ Horários salvos com sucesso!';
        listaEl.innerText = response.data.horarios.map(h => `${h}:00`).join(' | ');
      })
      .catch((error) => {
        console.error('POST Error:', error);
        statusEl.innerText = '❌ Erro ao salvar os horários';
      })
      .finally(() => {
        btnConfirmar.disabled = false;
        btnConfirmar.innerText = textoOriginalBotao;
      });
  });

     // Verificar se estamos na página de horários
if (window.location.href.includes('horarios') || document.querySelector('main').innerHTML.includes('confirmar_horas')) {
  // Fazer GET para obter os horários existentes
  const idSession = loginUsuario;
  
  fetch('https://atentus.com.br:5000/horariosEscolhidos', {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  })
    .then(res => {
      console.log('GET Status:', res.status);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json();
    })
    .then(data => {
      console.log('GET Data:', data);
      
      // Procurar o usuário pelo TOKEN que corresponde ao idSession
      const usuarioEncontrado = data.dados.find(item => item.TOKEN == idSession);
      
      if (usuarioEncontrado) {
        // Usuário encontrado - processar os horários
        const horariosString = usuarioEncontrado.HORARIOS;
        let lista = [];
        
        // Verificar se é no formato "08:00-13:00" ou "7,12,14,21"
        if (horariosString.includes('-')) {
          // Formato de intervalo (08:00-13:00)
          lista = [horariosString];
        } else if (horariosString.includes(',')) {
          // Formato de lista separada por vírgula (7,12,14,21)
          lista = horariosString.split(',');
        } else {
          // Horário único
          lista = [horariosString];
        }
        
        // Preencher os selects se existirem
        if (typeof selects !== 'undefined') {
          selects.forEach((id, index) => {
            const el = document.getElementById(id);
            if (el) {
              el.value = lista[index] || 'null';
            }
          });
        }
        
        // Atualizar a exibição
        if (listaEl) {
          if (lista.length > 0) {
            // Formatear a exibição baseado no tipo de horário
            if (horariosString.includes('-')) {
              listaEl.innerText = horariosString;
            } else {
              listaEl.innerText = lista.map(h => `${h}:00`).join(' | ');
            }
            if (statusEl) statusEl.innerText = '⏰ Horários agendados!';
          } else {
            listaEl.innerText = 'Nenhum horário agendado';
            if (statusEl) statusEl.innerText = 'Adicione horários para salvar';
          }
        }
      } else {
        // Usuário não encontrado - mostrar mensagem padrão
        if (listaEl) {
          listaEl.innerText = 'Nenhum horário agendado';
        }
        if (statusEl) {
          statusEl.innerText = 'Adicione horários para salvar';
        }
        
        // Limpar os selects se existirem
        if (typeof selects !== 'undefined') {
          selects.forEach((id) => {
            const el = document.getElementById(id);
            if (el) {
              el.value = 'null';
            }
          });
        }
      }
    })
    .catch((error) => {
      console.error('GET Error:', error);
      if (listaEl) listaEl.innerText = 'Erro ao carregar horários';
      if (statusEl) statusEl.innerText = 'Tente novamente';
    });
}
}

// === Aba Grupos ===
if (document.getElementById('confirmar_grupos')) {
  const tabelaEsquerda = document.getElementById('tabela_grupos_esquerda');
  const tabelaDireita = document.getElementById('tabela_grupos_direita');
  const btnConfirmarGrupos = document.getElementById('confirmar_grupos');
  const status = document.getElementById('status_grupos');

  tabelaEsquerda.innerHTML = '';
  tabelaDireita.innerHTML = '';

  const idSession = loginUsuario; // ou sessionStorage.getItem('userId')

  // === Carregar grupos scan (esquerda) ===
  fetch(`https://atentus.com.br:5000/grupos/${idSession}`)
    .then(res => res.json())
    .then(grupos => {
      tabelaEsquerda.innerHTML = '';
      grupos.forEach(grupo => {
        const tr = document.createElement('tr');

        const tdId = document.createElement('td');
        tdId.textContent = grupo.id;

        const tdNome = document.createElement('td');
        tdNome.textContent = grupo.nome;

        const tdCheck = document.createElement('td');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.addEventListener('change', atualizarGruposSelecionados);

        tdCheck.appendChild(checkbox);

        tr.appendChild(tdId);
        tr.appendChild(tdNome);
        tr.appendChild(tdCheck);

        tabelaEsquerda.appendChild(tr);
      });
    })
    .catch(err => console.error('Erro ao carregar grupos scan:', err));

  // === Atualizar tabela da direita (grupos incluídos) ===
  function atualizarGruposSelecionados() {
    tabelaDireita.innerHTML = '';

    const linhas = tabelaEsquerda.querySelectorAll('tr');
    linhas.forEach(tr => {
      const checkbox = tr.querySelector('input[type="checkbox"]');
      if (checkbox && checkbox.checked) {
        const trNovo = document.createElement('tr');

        const tdId = document.createElement('td');
        tdId.textContent = tr.children[0].textContent;

        const tdNome = document.createElement('td');
        tdNome.textContent = tr.children[1].textContent;

        trNovo.appendChild(tdId);
        trNovo.appendChild(tdNome);

        tabelaDireita.appendChild(trNovo);
      }
    });
  }

  // === Confirmar inclusão no banco ===
  btnConfirmarGrupos.addEventListener('click', () => {
    const linhasSelecionadas = tabelaDireita.querySelectorAll('tr');
    const gruposSelecionados = Array.from(linhasSelecionadas).map(tr => ({
      TOKEN: idSession,
      ID_GROUP: tr.children[0].textContent,
      NOME: tr.children[1].textContent
    }));

    if (gruposSelecionados.length === 0) {
      Swal.fire('Aviso', 'Nenhum grupo selecionado para incluir', 'warning');
      return;
    }

    fetch(`https://atentus.com.br:5000/gruposcheck/${idSession}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(gruposSelecionados)
    })
      .then(res => res.json())
      .then(data => {
        Swal.fire('Sucesso', 'Grupos confirmados com sucesso!', 'success');
        status.textContent = data.message || 'Grupos salvos';
        
        // Limpar tabela da direita após confirmar
        tabelaDireita.innerHTML = '';
        
        // Desmarcar checkboxes da esquerda
        const checkboxes = tabelaEsquerda.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = false);
      })
      .catch(err => {
        Swal.fire('Erro', 'Erro ao salvar os grupos', 'error');
        console.error(err);
      });
    console.log(gruposSelecionados);
  });
}

// === Aba Meus Anúncios ===
if (document.getElementById('tabela_grupos_check')) {
  const tbody = document.getElementById('tabela_grupos_check');
  const btnApagarSelecionados = document.getElementById('btn_apagar_grupos');
  const btnApagarTodos = document.getElementById('btn_apagar_todos_grupos');
  const idSession = loginUsuario;

  carregarGruposCheck();

  function carregarGruposCheck() {
    fetch(`https://atentus.com.br:5000/gruposcheck/${idSession}`)
      .then(res => res.json())
      .then(grupos => {
        tbody.innerHTML = '';
        grupos.forEach(grupo => {
          const tr = document.createElement('tr');

          const tdId = document.createElement('td');
          tdId.textContent = grupo.id;

          const tdNome = document.createElement('td');
          tdNome.textContent = grupo.nome;

          // ✅ NOVA COLUNA: Checkbox para seleção
          const tdCheck = document.createElement('td');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.dataset.id = grupo.id; // Para identificar o grupo
          tdCheck.appendChild(checkbox);

          tr.appendChild(tdId);
          tr.appendChild(tdNome);
          tr.appendChild(tdCheck); // ✅ Adicionar coluna checkbox

          tbody.appendChild(tr);
        });
      })
      .catch(error => {
        console.error('Erro ao carregar os gruposcheck:', error);
      });
  }

  // === Apagar selecionados ===
  btnApagarSelecionados.addEventListener('click', async () => {
    const selecionados = tbody.querySelectorAll('input[type="checkbox"]:checked');
    if (selecionados.length === 0) {
      Swal.fire('Aviso', 'Selecione pelo menos um grupo para apagar', 'warning');
      return;
    }

    const confirm = await Swal.fire({
      title: 'Tem certeza?',
      text: `Você vai apagar ${selecionados.length} grupo(s) incluído(s).`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Sim, apagar',
      cancelButtonText: 'Cancelar'
    });

    if (!confirm.isConfirmed) return;

    for (const chk of selecionados) {
      const id = chk.dataset.id;
      try {
        await fetch(`https://atentus.com.br:5000/gruposcheck/${idSession}/${id}`, { method: 'DELETE' });
      } catch (err) {
        console.error(`Erro ao apagar grupo ${id}:`, err);
      }
    }

    Swal.fire('Sucesso', 'Grupos selecionados apagados!', 'success');
    carregarGruposCheck(); // ✅ Recarregar tabela
  });

  // === Apagar todos ===
  btnApagarTodos.addEventListener('click', async () => {
    const linhas = tbody.querySelectorAll('tr');
    if (linhas.length === 0) {
      Swal.fire('Aviso', 'Nenhum grupo incluído para apagar', 'warning');
      return;
    }

    const confirm = await Swal.fire({
      title: 'Tem certeza?',
      text: 'Todos os grupos incluídos serão apagados!',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Sim, apagar todos',
      cancelButtonText: 'Cancelar'
    });

    if (!confirm.isConfirmed) return;

    await fetch(`https://atentus.com.br:5000/gruposcheck/${idSession}`, { method: 'DELETE' });

    Swal.fire('Sucesso', 'Todos os grupos foram apagados!', 'success');
    carregarGruposCheck(); // ✅ Recarregar tabela
  });
}

// preview front
if (document.getElementById('previewImagem_chk')) {
  const selectDia = document.getElementById('diaSemana_chk');
  const imagem = document.getElementById('previewImagem_chk');
  const texto = document.getElementById('previewText_chk');
  const idSession = loginUsuario;
  

  if (selectDia && imagem && texto) {
    // Função para carregar prévia
    const carregarPreview = async (dia) => {
        const obterImagem = fetch(`https://atentus.com.br:5000/anuncio/${dia}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ idSession: idSession })
        })
        .then(res => res.json())
        .catch(err => {
            console.error('Erro ao carregar imagem:', err);
            return null;
        });

        // ✅ CORREÇÃO: GET usa query parameter, não body
        const obterTexto = fetch(`https://atentus.com.br:5000/anunciotexto/${dia}?idSession=${idSession}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
            // ❌ REMOVIDO: GET não pode ter body
        })
        .then(res => res.json())
        .catch(err => {
            console.error('Erro ao carregar texto:', err);
            return null;
        });

        const [obterImagemResult, obterTextoResult] = await Promise.all([
            obterImagem,
            obterTexto
        ]);

        // Processa imagem
        if (obterImagemResult) {
            imagem.src = obterImagemResult.imagemBase64 || 'default_preview.jpg';
        } else {
            imagem.src = 'default_preview.jpg';
        }
        
        // ✅ ADICIONADO: Processa texto
        if (obterTextoResult && obterTextoResult.success && obterTextoResult.textos && obterTextoResult.textos.length > 0) {
            // Pega o primeiro texto encontrado para o TOKEN
            texto.innerHTML = obterTextoResult.textos[0].message.replace(/\n/g, '<br>');
        } else {
            texto.textContent = 'Nenhum texto encontrado para este dia';
        }
    };

    // Carrega a primeira vez
    carregarPreview(selectDia.value);

    // Atualiza ao mudar
    selectDia.addEventListener('change', () => {
        carregarPreview(selectDia.value);
    });
}
}

//duplicar anuncios meusanuncios

//document.addEventListener('DOMContentLoaded', () => {
  
  if (document.getElementById('confirmar_checkbox')) {
    const btnConfirmar = document.getElementById('confirmar_checkbox');
    btnConfirmar.addEventListener('click', () => {
      const selectDia = document.getElementById('diaSemana_chk');
      const diaOrigem = selectDia.value;
      const statuschk = document.getElementById('status_checkbox');
      const idSession = loginUsuario; // Adicionar o ID da sessão

      // Verificar se idSession está disponível
      if (!idSession) {
        statuschk.textContent = 'Erro: Token de sessão não encontrado. Faça login novamente.';
        return;
      }

      // Pegar todos os checkboxes marcados
      const checkboxes = document.querySelectorAll('.main__checkbox');
      const diasDestino = [];

      checkboxes.forEach(checkbox => {
        if (checkbox.checked) {
          // Extrair o dia do id, que está no formato checkbox_segunda, checkbox_terca, etc
          const dia = checkbox.id.replace('checkbox_', '');
          // Evita copiar para o mesmo dia origem
          if (dia !== diaOrigem) diasDestino.push(dia);
        }
      });

      if (diasDestino.length === 0) {
        statuschk.textContent = 'Selecione pelo menos um dia diferente para copiar o anúncio.';
        return;
      }

      // Mostrar status de carregamento
      statuschk.textContent = 'Copiando anúncios, aguarde...';

      fetch('https://atentus.com.br:5000/copiar-anuncio', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          diaOrigem, 
          diasDestino, 
          idSession // Adicionar o ID da sessão
        })
      })
      
      .then(res => {
        if (!res.ok) throw new Error('Erro ao copiar anúncio');
        return res.text();
      })
      .then(msg => {
        statuschk.textContent = msg;
        // Opcional: desmarcar checkboxes após confirmação
        checkboxes.forEach(c => c.checked = false);
        
        // Opcional: recarregar preview se estiver visível
        if (typeof carregarPreview === 'function') {
          carregarPreview(selectDia.value);
        }
      })
      .catch(err => {
        console.error(err);
        statuschk.textContent = 'Erro ao copiar anúncio. Veja o console.';
      });
    });
};

//Apagar anuncio
if (document.getElementById('btn-apagar-anuncio')) {
  const btnApagarAnuncio = document.getElementById('btn-apagar-anuncio');
  btnApagarAnuncio.addEventListener('click', async () => {
    const diaSelecionado = document.getElementById('diaSemana_chk').value;
    const statuschk = document.getElementById('status_checkbox');
    const idSession = loginUsuario;

    if (!diaSelecionado) {
      statuschk.textContent = 'Por favor, selecione um dia.';
      return;
    }

    if (!idSession) {
      statuschk.textContent = 'Erro: Token de sessão não encontrado. Faça login novamente.';
      return;
    }

    // Confirmação antes de apagar
    if (!confirm(`Tem certeza que deseja apagar o anúncio de ${diaSelecionado}?`)) {
      return;
    }

    // Status de loading
    statuschk.textContent = 'Apagando anúncio, aguarde...';

    try {
      const resposta = await fetch('https://atentus.com.br:5000/apagar-anuncio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          dia: diaSelecionado, 
          idSession: idSession // ✅ Corrigido: idSession (não idsession)
        })
      });

      const textoResposta = await resposta.text();
      statuschk.textContent = textoResposta;
      
      // ✅ ADICIONADO: Limpar preview após apagar
      if (resposta.ok) {
        const imagem = document.getElementById('previewImagem_chk');
        const texto = document.getElementById('previewText_chk');
        
        if (imagem) imagem.src = 'default_preview.jpg';
        if (texto) texto.textContent = 'Nenhum texto encontrado para este dia';
      }

    } catch (error) {
      console.error('Erro ao apagar anúncio:', error);
      statuschk.textContent = 'Erro ao tentar apagar o anúncio.';
    }
  });
};
//Apagar todos
if (document.getElementById('btn-apagar-todos')) {
  const btnApagarTodos = document.getElementById('btn-apagar-todos');
  btnApagarTodos.addEventListener('click', async () => {
    const statuschk = document.getElementById('status_checkbox');
    const idSession = loginUsuario;

    // Validação de sessão
    if (!idSession) {
      statuschk.textContent = 'Erro: Token de sessão não encontrado. Faça login novamente.';
      return;
    }

    // Confirmação dupla para operação crítica
    if (!confirm('⚠️ ATENÇÃO: Tem certeza que deseja apagar TODOS os anúncios?\n\nEsta ação irá remover:\n• Todas as imagens\n• Todos os textos\n• De todos os dias da semana\n\nEsta ação NÃO pode ser desfeita!')) {
      return;
    }

    // Segunda confirmação
    if (!confirm('Confirma novamente? Esta é sua última chance antes de apagar tudo!')) {
      return;
    }

    // Status de loading
    statuschk.textContent = 'Apagando todos os anúncios, aguarde...';

    try {
      const resposta = await fetch('https://atentus.com.br:5000/apagar-todos-anuncios', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ 
          idSession: idSession 
        })
      });

      const textoResposta = await resposta.text();
      statuschk.textContent = textoResposta;
      
      // ✅ ADICIONADO: Limpar preview após apagar tudo
      if (resposta.ok) {
        const imagem = document.getElementById('previewImagem_chk');
        const texto = document.getElementById('previewText_chk');
        
        if (imagem) imagem.src = 'default_preview.jpg';
        if (texto) texto.textContent = 'Nenhum texto encontrado para este dia';
        
        // Limpar checkboxes se existirem
        const checkboxes = document.querySelectorAll('.main__checkbox');
        checkboxes.forEach(checkbox => checkbox.checked = false);
      }

    } catch (error) {
      console.error('Erro ao apagar todos os anúncios:', error);
      statuschk.textContent = 'Erro ao tentar apagar todos os anúncios.';
    }
  });
};

//historico
if (document.getElementById('tabela_historico_envios')) {
  console.log('[Histórico] Inicializando...');
  carregarHistorico();
  iniciarAtualizacaoAutomatica();
}
// Botão para apagar histórico
if (document.getElementById('btn-apagar-historico')) {
  document.getElementById('btn-apagar-historico').addEventListener('click', async () => {
    if (confirm('Tem certeza que deseja apagar todo o histórico de envios?')) {
      try {
        const response = await fetch('https://atentus.com.br:5000/delete-historico-envios', {
          method: 'DELETE'
        });

        if (!response.ok) throw new Error('Erro ao apagar histórico');

        const resultado = await response.json();

        if (resultado.sucesso) {
          alert('Histórico apagado com sucesso.');
          carregarHistorico(); // recarrega a tabela
        } else {
          alert('Falha ao apagar histórico.');
        }
      } catch (erro) {
        console.error('[Apagar Histórico] Erro:', erro);
        alert('Erro ao apagar histórico. Verifique o console.');
      }
    }
  });
}


//FIM HISTÓRICO
  // if (main.innerHTML.includes("id_exclusivo_da_nova_pagina")) { ... }
}

// Configura os links do menu
function getCurrentPage() {
  const activeLink = document.querySelector('.nav-link.active');
  return activeLink ? activeLink.getAttribute('data-page') : 'login';
}

// Função para inicializar a aplicação
function inicializarApp() {
  // Verificar se já está logado
  if (verificarAutenticacao()) {
    carregarPagina('anuncios');
  } else {
    carregarPagina('login');
  }
  
  // Configurar event listeners para navegação
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-page]');
    if (link) {
      e.preventDefault();
      const pagina = link.getAttribute('data-page');
      carregarPagina(pagina);
    }
  });
}

// Inicializar quando o DOM estiver pronto
document.addEventListener('DOMContentLoaded', () => {
  inicializarApp();
});