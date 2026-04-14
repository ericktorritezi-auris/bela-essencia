# Bela Essência — Sistema de Agendamento

Sistema de agendamento online para Ana Paula Silva, com painel administrativo, banco de dados PostgreSQL no Railway e suporte a PWA (instalável na tela inicial).

---

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Backend | Node.js + Express |
| Banco de dados | PostgreSQL (Railway Plugin) |
| Frontend | HTML + CSS + JS vanilla (sem framework) |
| Deploy | Railway |
| PWA | Service Worker + Web App Manifest |

---

## Deploy no Railway — Passo a Passo

### 1. Preparar o repositório GitHub

```bash
# Na sua máquina, dentro da pasta do projeto:
git init
git add .
git commit -m "chore: initial commit – Bela Essência v1.1"

# Crie um repositório no github.com e siga as instruções para push:
git remote add origin https://github.com/SEU_USUARIO/bela-essencia.git
git branch -M main
git push -u origin main
```

### 2. Criar projeto no Railway

1. Acesse [railway.app](https://railway.app) e faça login
2. Clique em **New Project**
3. Escolha **Deploy from GitHub repo**
4. Selecione o repositório `bela-essencia`
5. Railway detecta automaticamente o Node.js e inicia o deploy

### 3. Adicionar banco de dados PostgreSQL

1. No projeto Railway, clique em **+ New**
2. Escolha **Database → Add PostgreSQL**
3. Aguarde o provisionamento (≈30 segundos)
4. A variável `DATABASE_URL` é injetada **automaticamente** no serviço Node.js

### 4. Configurar variáveis de ambiente

No Railway, vá em seu serviço Node.js → **Variables** → adicione:

| Variável | Valor |
|----------|-------|
| `SESSION_SECRET` | string aleatória longa (ex.: rode `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `ADMIN_USER` | `admin` (ou troque) |
| `ADMIN_PASS` | Senha forte de sua escolha |
| `NODE_ENV` | `production` |

> `DATABASE_URL` e `PORT` são injetados automaticamente pelo Railway. Não precisa adicionar.

### 5. Obter o link público

1. No seu serviço, vá em **Settings → Networking**
2. Clique em **Generate Domain**
3. Seu link público será algo como `bela-essencia-production.up.railway.app`

---

## Estrutura de Arquivos

```
bela-essencia/
├── server.js              # Servidor Express + todas as rotas da API
├── package.json
├── railway.toml           # Configuração de deploy
├── .env.example           # Template de variáveis de ambiente
├── .gitignore
├── public/
│   ├── index.html         # Frontend completo (booking + painel admin)
│   ├── manifest.json      # PWA manifest
│   ├── sw.js              # Service Worker (cache offline)
│   └── icons/
│       ├── icon-192.png   # Ícone PWA 192×192
│       └── icon-512.png   # Ícone PWA 512×512
└── README.md
```

---

## Desenvolvimento Local

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# Edite o .env com suas credenciais locais de PostgreSQL

# 3. Iniciar servidor
npm run dev        # com --watch (Node 18+)
# ou
npm start

# 4. Acessar
open http://localhost:3000
```

---

## Credenciais de Acesso Admin (padrão)

> **Altere antes de fazer deploy!** Defina `ADMIN_USER` e `ADMIN_PASS` nas variáveis do Railway.

- **Usuário:** `admin`
- **Senha:** `belaessencia2025`

O link para o painel admin aparece no rodapé do site: **"Área administrativa"**.

---

## API Endpoints

### Públicos
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/procedures` | Lista procedimentos ativos |
| GET | `/api/availability?date=&procId=&cityId=` | Horários disponíveis |
| POST | `/api/appointments` | Criar agendamento |
| GET | `/api/blocked` | Datas bloqueadas |
| GET | `/api/health` | Health check |

### Requerem autenticação admin
| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/auth/login` | Login admin |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/appointments` | Listar agendamentos (filtros) |
| PUT | `/api/appointments/:id` | Editar agendamento |
| PATCH | `/api/appointments/:id/cancel` | Cancelar agendamento |
| POST/PUT/DELETE | `/api/procedures/:id` | CRUD procedimentos |
| POST/DELETE | `/api/blocked/:date` | Gerenciar bloqueios |
| GET | `/api/revenue/summary` | Resumo financeiro |

---

## PWA — Instalação no Celular

O sistema exibe automaticamente um prompt de instalação após **3 segundos** para usuários que ainda não instalaram.

- **Android (Chrome):** Banner nativo aparece na tela
- **iOS (Safari):** Instrução manual: *Compartilhar → Adicionar à Tela de Início*

---

## Persistência de Dados

Todos os dados vivem no PostgreSQL do Railway:
- Agendamentos (histórico completo, nunca deletados)
- Procedimentos (soft delete — desativados, não apagados)
- Datas bloqueadas

Atualizações no código **nunca afetam os dados**. O schema usa `CREATE TABLE IF NOT EXISTS`, então é seguro fazer redeploy a qualquer momento.
