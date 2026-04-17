/**
 * Bela Essência – Servidor Principal
 * Express + PostgreSQL via Railway
 * ─────────────────────────────────────────────────────────────────────────────
 * Todas as rotas da API estão neste arquivo para simplicidade de deploy.
 * Estrutura:
 *   1. Config & Conexão DB
 *   2. Schema & Seed de dados
 *   3. Middleware
 *   4. Rotas: Auth / Procedures / Appointments / Blocked / Availability
 *   5. Servir frontend estático
 *   6. Inicialização
 */

require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const cors       = require('cors');
const path       = require('path');
const { Pool }   = require('pg');
const webpush    = require('web-push');
const cron       = require('node-cron');

// ══════════════════════════════════════════════════════════════════════════════
// 1. CONFIGURAÇÃO
// ══════════════════════════════════════════════════════════════════════════════
const PORT         = process.env.PORT || 3000;
const ADMIN_USER   = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS   = process.env.ADMIN_PASS || 'belaessencia2025';
const SESSION_SEC  = process.env.SESSION_SECRET || 'dev_secret_troque_em_prod';

// ── Fuso Brasil (America/Sao_Paulo) ──────────────────────────────────────────
// Retorna objeto Date ajustado para o fuso de Brasília
function nowBrasilia() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

// Retorna 'YYYY-MM-DD' no fuso de Brasília
function todayBrasilia() {
  const d = nowBrasilia();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// Retorna 'YYYY-MM' no fuso de Brasília
function monthBrasilia() { return todayBrasilia().slice(0,7); }

// Retorna 'YYYY' no fuso de Brasília
function yearBrasilia()  { return todayBrasilia().slice(0,4); }

// Início e fim da semana (Seg–Dom) no fuso de Brasília
function weekBrasilia() {
  const d = nowBrasilia();
  const dow = d.getDay(); // 0=Dom
  const daysSinceMon = dow === 0 ? 6 : dow - 1;
  const start = new Date(d);
  start.setDate(d.getDate() - daysSinceMon);
  start.setHours(0,0,0,0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = x => {
    const y=x.getFullYear(), m=String(x.getMonth()+1).padStart(2,'0'), day=String(x.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  };
  return { ws: fmt(start), we: fmt(end) };
}

// ── Web Push (VAPID) — configurado automaticamente ───────────────────────────
// As chaves são geradas na primeira execução e armazenadas no banco.
// Nenhuma configuração manual necessária.
async function initVapid() {
  try {
    // Tenta carregar do banco
    const { rows } = await pool.query(
      "SELECT key, value FROM app_settings WHERE key IN ('vapid_public','vapid_private','vapid_email')"
    );
    let pub = null, priv = null, email = null;
    for (const r of rows) {
      if (r.key === 'vapid_public')  pub   = r.value;
      if (r.key === 'vapid_private') priv  = r.value;
      if (r.key === 'vapid_email')   email = r.value;
    }

    // Se não existem, gera e persiste
    if (!pub || !priv) {
      const vapidKeys = webpush.generateVAPIDKeys();
      pub   = vapidKeys.publicKey;
      priv  = vapidKeys.privateKey;
      email = process.env.ADMIN_EMAIL || 'admin@belaessencia.com';
      await pool.query(
        "INSERT INTO app_settings (key,value) VALUES ('vapid_public',$1),('vapid_private',$2),('vapid_email',$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
        [pub, priv, email]
      );
      console.log('[Push] VAPID keys geradas e salvas no banco.');
    }

    webpush.setVapidDetails('mailto:' + email, pub, priv);
    // Torna pública a chave para o frontend via variável de runtime
    process.env.VAPID_PUBLIC_KEY = pub;
    console.log('[Push] VAPID configurado.');
  } catch (err) {
    console.error('[Push] Erro ao inicializar VAPID:', err.message);
  }
}

const app = express();

// ── PostgreSQL Pool ──────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('\n❌  DATABASE_URL nao encontrada!');
  console.error('   Adicione o plugin PostgreSQL no Railway:');
  console.error('   Projeto → + New → Database → PostgreSQL\n');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. SCHEMA + SEED
// ══════════════════════════════════════════════════════════════════════════════
const DEFAULT_PROCS = [
  { name:'Micropigmentação Labial',               dur:90,  price:450,  pt:'fixed' },
  { name:'Micropigmentação de Sobrancelhas',      dur:90,  price:450,  pt:'fixed' },
  { name:'Micropigm. Delineador Sup./Inf.',       dur:120, price:450,  pt:'fixed' },
  { name:'Delineador Inferior',                   dur:60,  price:250,  pt:'fixed' },
  { name:'Retorno Micropigmentação',              dur:60,  price:null, pt:'none'  },
  { name:'Remoção Laser Micropigmentação',        dur:30,  price:250,  pt:'fixed' },
  { name:'Remoção Laser Tatuagem',                dur:30,  price:null, pt:'eval'  },
  { name:'Limpeza de Pele',                       dur:90,  price:130,  pt:'fixed' },
  { name:'Extensão Cílios Volume Brasileiro',     dur:90,  price:120,  pt:'fixed' },
  { name:'Extensão Cílios Volume Inglês',         dur:90,  price:140,  pt:'fixed' },
  { name:'Extensão Cílios Volume 6D',             dur:90,  price:140,  pt:'fixed' },
  { name:'Manutenção de Cílios',                  dur:60,  price:80,   pt:'fixed' },
  { name:'Design de Sobrancelhas',                dur:30,  price:30,   pt:'fixed' },
  { name:'Design com Henna',                      dur:30,  price:45,   pt:'fixed' },
  { name:'Brow Lamination',                       dur:60,  price:80,   pt:'fixed' },
  { name:'Lash Lifting',                          dur:60,  price:100,  pt:'fixed' },
  { name:'Combo Brow + Lash',                     dur:60,  price:150,  pt:'fixed' },
  { name:'Reconstrução BrowExpert',               dur:60,  price:null, pt:'none'  },
];

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Tabela de procedimentos
    await client.query(`
      CREATE TABLE IF NOT EXISTS procedures (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(200) NOT NULL,
        dur        INTEGER      NOT NULL,  -- duração em minutos
        price      NUMERIC(10,2),          -- NULL = sem valor
        pt         VARCHAR(10)  NOT NULL DEFAULT 'fixed', -- fixed|eval|none
        active     BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    // Tabela de agendamentos
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id         VARCHAR(30)  PRIMARY KEY,
        city_id    INTEGER      NOT NULL,
        city_name  VARCHAR(100) NOT NULL,
        proc_id    INTEGER      REFERENCES procedures(id) ON DELETE SET NULL,
        proc_name  VARCHAR(200) NOT NULL,
        date       DATE         NOT NULL,
        st         TIME         NOT NULL,  -- horário início
        et         TIME         NOT NULL,  -- horário fim
        name       VARCHAR(200) NOT NULL,
        phone      VARCHAR(30)  NOT NULL,
        price      NUMERIC(10,2),
        pt         VARCHAR(10),
        status     VARCHAR(20)  NOT NULL DEFAULT 'confirmed',
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ
      );
    `);

    // Índices para performance nas consultas de agenda
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_appt_date   ON appointments(date);
      CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);
    `);

    // Tabela de datas bloqueadas
    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked_dates (
        date       DATE         PRIMARY KEY,
        reason     VARCHAR(200),
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    // Tabela de promoções
    await client.query(`
      CREATE TABLE IF NOT EXISTS promotions (
        id           SERIAL       PRIMARY KEY,
        name         VARCHAR(200) NOT NULL,
        start_date   DATE         NOT NULL,
        end_date     DATE         NOT NULL,
        discount     NUMERIC(5,2) NOT NULL CHECK (discount > 0 AND discount <= 100),
        apply_to_all BOOLEAN      NOT NULL DEFAULT TRUE,
        proc_ids     INTEGER[]    NOT NULL DEFAULT '{}',
        active       BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);
    // Migração segura: adiciona colunas se não existirem (clientes vindos de v1.4.0)
    await client.query(`ALTER TABLE promotions ADD COLUMN IF NOT EXISTS apply_to_all BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`ALTER TABLE promotions ADD COLUMN IF NOT EXISTS proc_ids INTEGER[] NOT NULL DEFAULT '{}'`);

    // Migração v1.6.1: city_ids nos bloqueios (vazio = todas as cidades)
    await client.query(`ALTER TABLE blocked_dates ADD COLUMN IF NOT EXISTS city_ids INTEGER[] NOT NULL DEFAULT '{}'`);
    await client.query(`ALTER TABLE blocked_slots ADD COLUMN IF NOT EXISTS city_ids INTEGER[] NOT NULL DEFAULT '{}'`);

    // v2.0.0: Liberação de datas (exceção para dias normalmente desabilitados)
    await client.query(`
      CREATE TABLE IF NOT EXISTS released_dates (
        id          SERIAL      PRIMARY KEY,
        date        DATE        NOT NULL,
        city_ids    INTEGER[]   NOT NULL DEFAULT '{}',
        work_start  TIME        NOT NULL DEFAULT '08:00',
        work_end    TIME        NOT NULL DEFAULT '18:00',
        break_start TIME,
        break_end   TIME,
        reason      TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_released_dates_date ON released_dates(date)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS released_slots (
        id          SERIAL      PRIMARY KEY,
        date        DATE        NOT NULL,
        st          TIME        NOT NULL,
        et          TIME        NOT NULL,
        city_ids    INTEGER[]   NOT NULL DEFAULT '{}',
        reason      TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_released_slots_date ON released_slots(date)`);
    // Migração v1.7.0: push_auth nos agendamentos (liga subscription ao agendamento)
    await client.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS push_auth TEXT`);

    // Migração: atualiza texto do template "Agendamento alterado" no banco
    await client.query(`
      UPDATE push_templates
      SET body = 'Seu agendamento sofreu alterações. Verifique os detalhes.'
      WHERE is_system = TRUE
        AND title = '📅 Agendamento alterado'
        AND body = 'Seu agendamento teve o horário alterado. Verifique os detalhes.'
    `);

    // Tabela de horários específicos bloqueados (agendamentos manuais / ausências parciais)
    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked_slots (
        id         SERIAL       PRIMARY KEY,
        date       DATE         NOT NULL,
        st         TIME         NOT NULL,
        et         TIME         NOT NULL,
        reason     VARCHAR(200),
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bslot_date ON blocked_slots(date);
    `);

    // ── CIDADES ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS cities (
        id            SERIAL       PRIMARY KEY,
        name          VARCHAR(100) NOT NULL,
        uf            VARCHAR(2)   NOT NULL,
        local_name    VARCHAR(200) NOT NULL,
        address       VARCHAR(200) NOT NULL,
        number        VARCHAR(20)  NOT NULL,
        complement    VARCHAR(100),
        neighborhood  VARCHAR(100) NOT NULL,
        cep           VARCHAR(9)   NOT NULL,
        maps_url      TEXT,
        is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    // Procedimentos habilitados por cidade (habilitado por padrão)
    await client.query(`
      CREATE TABLE IF NOT EXISTS city_procedures (
        city_id   INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
        proc_id   INTEGER NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
        enabled   BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (city_id, proc_id)
      );
    `);

    // ── CONFIGURAÇÃO DE HORÁRIOS ──────────────────────────────────────────────
    // scope: 'global' | 'day' | 'city_day'
    // Prioridade de resolução: city_day > day > global
    await client.query(`
      CREATE TABLE IF NOT EXISTS work_configs (
        id          SERIAL       PRIMARY KEY,
        scope       VARCHAR(10)  NOT NULL DEFAULT 'global',
        city_id     INTEGER      REFERENCES cities(id) ON DELETE CASCADE,
        day_of_week SMALLINT,    -- 0=Dom, 1=Seg ... 6=Sáb; NULL se global
        is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
        work_start  TIME,        -- NULL = dia desabilitado
        work_end    TIME,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wcfg_lookup ON work_configs(scope, city_id, day_of_week);
    `);

    // Pausas de cada work_config (almoço, lanche, etc.)
    await client.query(`
      CREATE TABLE IF NOT EXISTS work_breaks (
        id          SERIAL   PRIMARY KEY,
        config_id   INTEGER  NOT NULL REFERENCES work_configs(id) ON DELETE CASCADE,
        break_start TIME     NOT NULL,
        break_end   TIME     NOT NULL
      );
    `);

    // ── PERFIL DO ADMINISTRADOR ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_profile (
        id        SERIAL       PRIMARY KEY,
        name      VARCHAR(200) NOT NULL DEFAULT 'Administrador',
        phone     VARCHAR(30),
        email     VARCHAR(200),
        login     VARCHAR(50)  NOT NULL DEFAULT 'admin',
        password  VARCHAR(200) NOT NULL,
        updated_at TIMESTAMPTZ
      );
    `);

    // ── NPS RESPONSES ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS nps_responses (
        id          SERIAL        PRIMARY KEY,
        phone       VARCHAR(30)   NOT NULL,
        phone_norm  VARCHAR(20)   NOT NULL,  -- apenas dígitos, para busca
        appt_id     VARCHAR(30),             -- agendamento de referência
        score       SMALLINT      NOT NULL CHECK (score BETWEEN 0 AND 10),
        comment     VARCHAR(300),
        category    VARCHAR(10)   NOT NULL,  -- 'promoter' | 'neutral' | 'detractor'
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nps_phone ON nps_responses(phone_norm)`);

    // ── PUSH TEMPLATES ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_templates (
        id          SERIAL       PRIMARY KEY,
        title       VARCHAR(200) NOT NULL,
        body        VARCHAR(500) NOT NULL,
        is_system   BOOLEAN      NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    // Seed: templates do sistema pré-cadastrados
    const { rowCount: ptCount } = await client.query('SELECT 1 FROM push_templates WHERE is_system=TRUE LIMIT 1');
    if (ptCount === 0) {
      const systemTemplates = [
        ['✅ Agendamento confirmado!',     'Seu agendamento foi confirmado. Estamos te esperando!'],
        ['📅 Agendamento alterado',        'Seu agendamento sofreu alterações. Verifique os detalhes.'],
        ['❌ Agendamento cancelado',       'Seu agendamento foi cancelado. Entre em contato para reagendar.'],
        ['💖 Obrigada pela sua visita!',     'Seu procedimento foi realizado com sucesso. Até a próxima!'],
      ];
      for (const [title, body] of systemTemplates) {
        await client.query(
          `INSERT INTO push_templates (title, body, is_system) VALUES ($1, $2, TRUE)`,
          [title, body]
        );
      }
      console.log('[DB] Push templates pré-cadastrados.');
    }

    // ── APP SETTINGS (chave-valor genérico para configurações do sistema) ───────
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key        VARCHAR(100) PRIMARY KEY,
        value      TEXT         NOT NULL,
        updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    // ── PUSH SUBSCRIPTIONS ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id           SERIAL       PRIMARY KEY,
        endpoint     TEXT         NOT NULL UNIQUE,
        p256dh       TEXT         NOT NULL,
        auth         TEXT         NOT NULL,
        role         VARCHAR(10)  NOT NULL DEFAULT 'client', -- 'client' | 'admin'
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    // ── DATAS COMEMORATIVAS ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS commemorative_dates (
        id        SERIAL       PRIMARY KEY,
        day       SMALLINT     NOT NULL CHECK (day BETWEEN 1 AND 31),
        month     SMALLINT     NOT NULL CHECK (month BETWEEN 1 AND 12),
        title     VARCHAR(200) NOT NULL,
        message   VARCHAR(300) NOT NULL,
        is_active BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query('COMMIT');

    // Seed: insere procedimentos padrão apenas se a tabela estiver vazia
    const { rowCount } = await client.query('SELECT 1 FROM procedures LIMIT 1');
    if (rowCount === 0) {
      console.log('[DB] Tabela vazia – inserindo procedimentos padrão...');
      for (const p of DEFAULT_PROCS) {
        await client.query(
          'INSERT INTO procedures (name, dur, price, pt) VALUES ($1, $2, $3, $4)',
          [p.name, p.dur, p.price, p.pt]
        );
      }
      console.log(`[DB] ${DEFAULT_PROCS.length} procedimentos inseridos.`);
    }

    // ── Seed: cidades pré-cadastradas ────────────────────────────────────────
    const { rowCount: cityCount } = await client.query('SELECT 1 FROM cities LIMIT 1');
    if (cityCount === 0) {
      const c1 = await client.query(
        `INSERT INTO cities (name,uf,local_name,address,number,complement,neighborhood,cep,maps_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        ['São Sebastião da Amoreira','PR','Clínica Bela Essência',
         'Praça Comendador Jeremias Lunardelli','55','2 andar','Centro','86240-000',
         'https://maps.google.com/?q=Praça+Comendador+Jeremias+Lunardelli+55+São+Sebastião+da+Amoreira+PR']
      );
      const c2 = await client.query(
        `INSERT INTO cities (name,uf,local_name,address,number,complement,neighborhood,cep,maps_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        ['Assaí','PR','Studio K','Rua Vereador Clovis Negreiro','250','','Copasa','86220-000',
         'https://maps.google.com/?q=Rua+Vereador+Clovis+Negreiro+250+Assaí+PR']
      );
      console.log('[DB] Cidades pré-cadastradas.');

      // Seed: work_configs por cidade+dia
      // SSA: Seg(1),Ter(2),Qui(4),Sex(5),Sáb(6) ativos — Qua(3) e Dom(0) desabilitados
      const ssaId = c1.rows[0].id, assaiId = c2.rows[0].id;
      const ssaDays = [
        {d:0,on:false},{d:1,on:true},{d:2,on:true},{d:3,on:false},
        {d:4,on:true},{d:5,on:true},{d:6,on:true}
      ];
      const assaiDays = [
        {d:0,on:false},{d:1,on:false},{d:2,on:false},{d:3,on:true},
        {d:4,on:false},{d:5,on:false},{d:6,on:false}
      ];
      for (const {d,on} of ssaDays) {
        const r = await client.query(
          `INSERT INTO work_configs (scope,city_id,day_of_week,is_active,work_start,work_end)
           VALUES ('city_day',$1,$2,$3,$4,$5) RETURNING id`,
          [ssaId, d, on, on?'08:00':null, on?'18:00':null]
        );
        if (on) await client.query(
          `INSERT INTO work_breaks (config_id,break_start,break_end) VALUES ($1,'12:00','13:00')`,
          [r.rows[0].id]
        );
      }
      for (const {d,on} of assaiDays) {
        const r = await client.query(
          `INSERT INTO work_configs (scope,city_id,day_of_week,is_active,work_start,work_end)
           VALUES ('city_day',$1,$2,$3,$4,$5) RETURNING id`,
          [assaiId, d, on, on?'08:00':null, on?'18:00':null]
        );
        if (on) await client.query(
          `INSERT INTO work_breaks (config_id,break_start,break_end) VALUES ($1,'12:00','13:00')`,
          [r.rows[0].id]
        );
      }
      console.log('[DB] Configurações de horário pré-cadastradas.');
    }

    // ── Seed: perfil admin ────────────────────────────────────────────────────
    const { rowCount: apCount } = await client.query('SELECT 1 FROM admin_profile LIMIT 1');
    if (apCount === 0) {
      const initPass = process.env.ADMIN_PASS || 'belaessencia2025';
      await client.query(
        `INSERT INTO admin_profile (name,phone,email,login,password)
         VALUES ($1,$2,$3,'admin',$4)`,
        ['Ana Paula Silva','(43) 99873-4460','anapaulasilvanac@gmail.com', initPass]
      );
      console.log('[DB] Perfil admin pré-cadastrado.');
    }

    console.log('[DB] Schema inicializado com sucesso.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] Erro ao inicializar schema:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════════
// Railway usa proxy reverso (SSL termination) — obrigatório para cookies funcionarem
app.set('trust proxy', 1);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Suprimir warning de MemoryStore em produção (aceitável para 1 instância)
const sessionStore = session.MemoryStore ? new session.MemoryStore() : undefined;

app.use(session({
  secret: SESSION_SEC,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS via Railway proxy
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 8 * 60 * 60 * 1000, // 8 horas
  },
}));

// Middleware de autenticação admin
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Não autorizado' });
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. ROTAS DA API
// ══════════════════════════════════════════════════════════════════════════════

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, version: '1.1', db: 'connected' });
  } catch {
    res.status(503).json({ ok: false, db: 'disconnected' });
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { user, pass } = req.body;
  try {
    // Check DB first, fallback to env vars
    const { rows } = await pool.query(
      'SELECT password FROM admin_profile WHERE login=$1 LIMIT 1', [user]
    );
    const dbPass = rows.length ? rows[0].password : null;
    const validPass = dbPass ? (pass === dbPass) : (user === ADMIN_USER && pass === ADMIN_PASS);
    if (validPass) {
      req.session.isAdmin = true;
      return res.json({ ok: true });
    }
  } catch { /* fallback to env */ }
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Credenciais inválidas' });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

// ── Procedimentos (público: GET; admin: POST/PUT/DELETE) ──────────────────────
app.get('/api/procedures', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM procedures WHERE active = TRUE ORDER BY id'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/procedures', requireAdmin, async (req, res) => {
  const { name, dur, price, pt } = req.body;
  if (!name || !dur) return res.status(400).json({ error: 'Nome e duração obrigatórios' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO procedures (name, dur, price, pt) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, parseInt(dur), price || null, pt || 'fixed']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/procedures/:id', requireAdmin, async (req, res) => {
  const { name, dur, price, pt } = req.body;
  try {
    const { rows } = await pool.query(
      'UPDATE procedures SET name=$1, dur=$2, price=$3, pt=$4 WHERE id=$5 RETURNING *',
      [name, parseInt(dur), price || null, pt || 'fixed', req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Procedimento não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/procedures/:id', requireAdmin, async (req, res) => {
  try {
    // Soft delete – preserva histórico de agendamentos vinculados
    await pool.query('UPDATE procedures SET active=FALSE WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agendamentos ──────────────────────────────────────────────────────────────

// Público: criar agendamento
app.post('/api/appointments', async (req, res) => {
  const { cityId, cityName, procId, procName, date, st, et, name, phone, price, pt } = req.body;
  if (!cityId || !procId || !date || !st || !name || !phone) {
    return res.status(400).json({ error: 'Campos obrigatórios faltando' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Valida que o horário ainda está disponível (anti-race condition)
    const busy = await client.query(
      `SELECT id FROM appointments
       WHERE date = $1 AND status != 'cancelled'
         AND (st, et) OVERLAPS ($2::time, $3::time)
       FOR UPDATE`,
      [date, st, et]
    );
    if (busy.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Horário não disponível. Por favor, escolha outro.' });
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const { rows } = await client.query(
      `INSERT INTO appointments
         (id, city_id, city_name, proc_id, proc_name, date, st, et, name, phone, price, pt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, cityId, cityName, procId, procName, date, st, et, name, phone, price||null, pt||'fixed']
    );

    await client.query('COMMIT');
    const appt = rows[0];
    // Notificação assíncrona — não bloqueia a resposta
    notifyAdminNewBooking(appt).catch(e => console.error('[Push] notifyAdminNewBooking:', e.message));
    res.status(201).json(appt);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Auto-marca confirmados passados como "realizado" (fuso Brasília)
async function autoCompleteAppointments() {
  try {
    // Compara no fuso de Brasília:
    // date+et são valores "locais BRT" — usamos AT TIME ZONE para interpretá-los como BRT
    // e comparamos com NOW() também em BRT
    const brtQuery = `
      (date::text || ' ' || et::text)::timestamp AT TIME ZONE 'America/Sao_Paulo'
        < NOW()
    `;

    // Busca os que vão ser marcados como realizado (para notificar)
    const { rows: toComplete } = await pool.query(`
      SELECT * FROM appointments
      WHERE status = 'confirmed' AND ${brtQuery}
    `);

    if (toComplete.length > 0) {
      await pool.query(`
        UPDATE appointments
        SET status = 'realizado', updated_at = NOW()
        WHERE status = 'confirmed' AND ${brtQuery}
      `);
      // Notifica cada cliente sobre o procedimento realizado
      for (const appt of toComplete) {
        notifyClientCompleted(appt).catch(e => console.error('[Push] notifyClientCompleted:', e.message));
      }
    }
  } catch (err) {
    console.error('[autoComplete] Erro:', err.message);
  }
}

// Admin: listar agendamentos com filtros
app.get('/api/appointments', requireAdmin, async (req, res) => {
  // Atualiza status antes de listar — marca passados como "realizado"
  await autoCompleteAppointments();
  const { date, city, status } = req.query;
  let sql = 'SELECT * FROM appointments WHERE 1=1';
  const params = [];
  if (date) {
    // Filtro exato por data
    sql += ` AND date = $${params.push(date)}`;
  }
  // Sem filtro de data = mostra todos os agendamentos (passados e futuros)
  if (city)   { sql += ` AND city_id = $${params.push(city)}`; }
  if (status) { sql += ` AND status = $${params.push(status)}`; }
  sql += ' ORDER BY date, st';
  try {
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: listar por mês (receita)
app.get('/api/appointments/month/:month', requireAdmin, async (req, res) => {
  // month = "2025-04"
  try {
    const { rows } = await pool.query(
      `SELECT * FROM appointments
       WHERE to_char(date,'YYYY-MM') = $1 AND status IN ('confirmed','realizado')
       ORDER BY date, st`,
      [req.params.month]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: editar agendamento
app.put('/api/appointments/:id', requireAdmin, async (req, res) => {
  const { name, phone, date, st, et: etBody, procDur, cityId, cityName, procId, procName, price } = req.body;
  const dur = parseInt(procDur) || 60;
  const stMin = timeToMin(st);
  const et = etBody || minToTime(stMin + dur);
  try {
    // price: null = não alterar; número = salvar; string vazia = salvar como null
    const priceVal = (price !== undefined && price !== null && price !== '')
      ? Number(price) : undefined;

    const { rows } = await pool.query(
      `UPDATE appointments
       SET name=$1, phone=$2, date=$3, st=$4, et=$5,
           city_id=COALESCE($7::integer, city_id),
           city_name=COALESCE($8, city_name),
           proc_id=COALESCE($9::integer, proc_id),
           proc_name=COALESCE($10, proc_name),
           price=${priceVal !== undefined ? '$11::numeric' : 'price'},
           updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      priceVal !== undefined
        ? [name, phone, date, st, et, req.params.id, cityId||null, cityName||null, procId||null, procName||null, priceVal]
        : [name, phone, date, st, et, req.params.id, cityId||null, cityName||null, procId||null, procName||null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agendamento não encontrado' });
    const edited = rows[0];
    // Notifica o cliente sobre a alteração
    notifyClientEdit(edited).catch(e => console.error('[Push] notifyClientEdit:', e.message));
    res.json(edited);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: cancelar agendamento
app.patch('/api/appointments/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE appointments SET status='cancelled', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agendamento não encontrado' });
    const appt = rows[0];
    // Notifica o cliente sobre o cancelamento
    getSubsByAuth(appt.push_auth).then(subs => {
      if (!subs.length) return;
      sendPush(subs,
        '❌ Agendamento cancelado',
        `Seu agendamento de ${appt.proc_name} em ${String(appt.date).slice(0,10)} às ${String(appt.st).slice(0,5)} foi cancelado. Entre em contato para reagendar.`,
        { type: 'cancelled' }
      ).catch(e => console.error('[Push] notifyClientCancelled:', e.message));
    });
    res.json(appt);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: excluir agendamento definitivamente da base (hard delete)
app.delete('/api/appointments/:id', requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM appointments WHERE id=$1',
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Agendamento não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Datas Bloqueadas ──────────────────────────────────────────────────────────
app.get('/api/blocked', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM blocked_dates ORDER BY date');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/blocked', requireAdmin, async (req, res) => {
  const { date, reason, city_ids } = req.body;
  if (!date) return res.status(400).json({ error: 'Data obrigatória' });
  const ids = Array.isArray(city_ids) ? city_ids.map(Number) : [];
  try {
    const { rows } = await pool.query(
      `INSERT INTO blocked_dates (date, reason, city_ids)
       VALUES ($1, $2, $3)
       ON CONFLICT(date) DO UPDATE SET reason=EXCLUDED.reason, city_ids=EXCLUDED.city_ids
       RETURNING *`,
      [date, reason || null, ids]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/blocked/:date', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM blocked_dates WHERE date = $1', [req.params.date]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Disponibilidade (público) ─────────────────────────────────────────────────
const WSTART = 480, WLAST = 1080, LSTRT = 720, LEND = 780, SLOT = 30;

function timeToMin(t) {
  const [h, m] = String(t).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}
function minToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Resolve work config for a specific city + day_of_week (priority: city_day > day > global)
async function resolveWorkConfig(cityId, dayOfWeek) {
  // Try city_day
  let r = await pool.query(
    `SELECT wc.*, array_agg(json_build_object('s',wb.break_start,'e',wb.break_end)) FILTER (WHERE wb.id IS NOT NULL) as breaks
     FROM work_configs wc
     LEFT JOIN work_breaks wb ON wb.config_id = wc.id
     WHERE wc.scope='city_day' AND wc.city_id=$1 AND wc.day_of_week=$2
     GROUP BY wc.id LIMIT 1`,
    [cityId, dayOfWeek]
  );
  if (r.rowCount) return r.rows[0];
  // Try day
  r = await pool.query(
    `SELECT wc.*, array_agg(json_build_object('s',wb.break_start,'e',wb.break_end)) FILTER (WHERE wb.id IS NOT NULL) as breaks
     FROM work_configs wc
     LEFT JOIN work_breaks wb ON wb.config_id = wc.id
     WHERE wc.scope='day' AND wc.day_of_week=$1
     GROUP BY wc.id LIMIT 1`,
    [dayOfWeek]
  );
  if (r.rowCount) return r.rows[0];
  // Try global
  r = await pool.query(
    `SELECT wc.*, array_agg(json_build_object('s',wb.break_start,'e',wb.break_end)) FILTER (WHERE wb.id IS NOT NULL) as breaks
     FROM work_configs wc
     LEFT JOIN work_breaks wb ON wb.config_id = wc.id
     WHERE wc.scope='global'
     GROUP BY wc.id LIMIT 1`
  );
  if (r.rowCount) return r.rows[0];
  // Fallback to hardcoded defaults
  return { is_active:true, work_start:'08:00', work_end:'18:00',
           breaks:[{s:'12:00:00',e:'13:00:00'}] };
}

app.get('/api/availability', async (req, res) => {
  const { date, procId, cityId } = req.query;
  if (!date || !procId || !cityId) {
    return res.status(400).json({ error: 'date, procId e cityId são obrigatórios' });
  }

  try {
    // 1. Verifica data bloqueada para esta cidade (city_ids vazio = todas)
    const blk = await pool.query(
      `SELECT 1 FROM blocked_dates
       WHERE date=$1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))`,
      [date, Number(cityId)]
    );
    if (blk.rowCount > 0) return res.json([]);

    // 2. Exclusividade: outra cidade tem bloqueio ou liberação específica neste dia?
    //    Se sim, a profissional está comprometida com aquela cidade → bloqueia esta.
    const exclusiveClaim = await pool.query(
      `SELECT 1 FROM (
        SELECT city_ids FROM blocked_dates  WHERE date=$1 AND cardinality(city_ids)>0
        UNION ALL
        SELECT city_ids FROM released_dates WHERE date=$1 AND cardinality(city_ids)>0
       ) t
       WHERE NOT ($2 = ANY(city_ids))
       LIMIT 1`,
      [date, Number(cityId)]
    );
    if (exclusiveClaim.rowCount > 0) return res.json([]);

    // Resolve config de horário para esta cidade+dia
    const [y,m,d] = date.split('-').map(Number);
    const dayOfWeek = new Date(y, m-1, d).getDay();
    const cfg = await resolveWorkConfig(Number(cityId), dayOfWeek);

    // Dia desabilitado na config — verifica se há liberação para esta data/cidade
    if (!cfg.is_active || !cfg.work_start || !cfg.work_end) {
      // Tenta released_dates (dia inteiro liberado)
      const relDay = await pool.query(
        `SELECT * FROM released_dates
         WHERE date=$1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))`,
        [date, Number(cityId)]
      );
      if (!relDay.rowCount) {
        // Tenta released_slots (horários específicos liberados)
        const relSlots = await pool.query(
          `SELECT st, et FROM released_slots
           WHERE date=$1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))`,
          [date, Number(cityId)]
        );
        if (!relSlots.rowCount) return res.json([]);
        // Tem slots liberados — verifica procedimento e retorna esses horários
        const pRes2 = await pool.query(
          `SELECT p.dur FROM procedures p
           LEFT JOIN city_procedures cp ON cp.proc_id=p.id AND cp.city_id=$2
           WHERE p.id=$1 AND p.active=TRUE AND (cp.enabled IS NULL OR cp.enabled=TRUE)`,
          [procId, cityId]
        );
        if (!pRes2.rowCount) return res.json([]);
        const dur2 = pRes2.rows[0].dur;
        const [aRes2, bkSlots2] = await Promise.all([
          excludeId
            ? pool.query(`SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled' AND id!=$2`, [date, excludeId])
            : pool.query(`SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled'`, [date]),
          pool.query(`SELECT st, et FROM blocked_slots WHERE date=$1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))`, [date, Number(cityId)]),
        ]);
        const busy2 = [...aRes2.rows, ...bkSlots2.rows].map(r => ({ s: timeToMin(r.st), e: timeToMin(r.et) }));
        const freeSlots = [];
        for (const row of relSlots.rows) {
          const slotS = timeToMin(row.st);
          const slotE = timeToMin(row.et);
          for (let s = slotS; s + dur2 <= slotE; s += SLOT) {
            const e = s + dur2;
            if (!busy2.some(b => s < b.e && e > b.s)) freeSlots.push(minToTime(s));
          }
        }
        return res.json(freeSlots);
      }
      // Dia inteiro liberado — usa os horários da liberação
      const rel = relDay.rows[0];
      const pRes3 = await pool.query(
        `SELECT p.dur FROM procedures p
         LEFT JOIN city_procedures cp ON cp.proc_id=p.id AND cp.city_id=$2
         WHERE p.id=$1 AND p.active=TRUE AND (cp.enabled IS NULL OR cp.enabled=TRUE)`,
        [procId, cityId]
      );
      if (!pRes3.rowCount) return res.json([]);
      const dur3 = pRes3.rows[0].dur;
      const rStart = timeToMin(rel.work_start);
      const rEnd   = timeToMin(rel.work_end);
      const rBreaks = (rel.break_start && rel.break_end)
        ? [{ s: timeToMin(rel.break_start), e: timeToMin(rel.break_end) }] : [];
      const [aRes3, bkSlots3] = await Promise.all([
        excludeId
          ? pool.query(`SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled' AND id!=$2`, [date, excludeId])
          : pool.query(`SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled'`, [date]),
        pool.query(`SELECT st, et FROM blocked_slots WHERE date=$1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))`, [date, Number(cityId)]),
      ]);
      const busy3 = [...aRes3.rows, ...bkSlots3.rows, ...excSlots.rows].map(r => ({ s: timeToMin(r.st), e: timeToMin(r.et) }));
      const relFreeSlots = [];
      for (let s = rStart; s <= rEnd; s += SLOT) {
        const e = s + dur3;
        if (isToday && s <= nowMinBRT) continue;
        if (rBreaks.some(b => s < b.e && e > b.s)) continue;
        if (!busy3.some(b => s < b.e && e > b.s)) relFreeSlots.push(minToTime(s));
      }
      return res.json(relFreeSlots);
    }

    const wStart = timeToMin(cfg.work_start);
    const wEnd   = timeToMin(cfg.work_end);
    const breaks  = (cfg.breaks || []).filter(Boolean).map(b => ({
      s: timeToMin(b.s), e: timeToMin(b.e)
    }));

    // Verifica se procedimento está habilitado para esta cidade
    const pRes = await pool.query(
      `SELECT p.dur FROM procedures p
       LEFT JOIN city_procedures cp ON cp.proc_id=p.id AND cp.city_id=$2
       WHERE p.id=$1 AND p.active=TRUE AND (cp.enabled IS NULL OR cp.enabled=TRUE)`,
      [procId, cityId]
    );
    if (!pRes.rowCount) return res.json([]);
    const dur = pRes.rows[0].dur;

    // Agendamentos e horários bloqueados (exclui o próprio agendamento ao editar)
    const excludeId = req.query.excludeApptId ? Number(req.query.excludeApptId) : null;
    const [aRes, sRes, excSlots] = await Promise.all([
      excludeId
        ? pool.query(`SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled' AND id!=$2`, [date, excludeId])
        : pool.query(`SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled'`, [date]),
      // Horários bloqueados para esta cidade (ou todas)
      pool.query(
        `SELECT st, et FROM blocked_slots
         WHERE date=$1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))`,
        [date, Number(cityId)]
      ),
      // Horários exclusivos de OUTRAS cidades (bloqueados ou liberados especificamente para outra cidade)
      pool.query(
        `SELECT st, et FROM (
           SELECT st, et, city_ids FROM blocked_slots  WHERE date=$1 AND cardinality(city_ids)>0
           UNION ALL
           SELECT st, et, city_ids FROM released_slots WHERE date=$1 AND cardinality(city_ids)>0
         ) t
         WHERE NOT ($2 = ANY(city_ids))`,
        [date, Number(cityId)]
      ),
    ]);
    const busy = [...aRes.rows, ...sRes.rows, ...excSlots.rows].map(r => ({
      s: timeToMin(r.st), e: timeToMin(r.et),
    }));

    // Horário atual em Brasília para filtrar slots passados no dia de hoje
    const nowBRT = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    );
    const todayBRT = `${nowBRT.getFullYear()}-${String(nowBRT.getMonth()+1).padStart(2,'0')}-${String(nowBRT.getDate()).padStart(2,'0')}`;
    const isToday   = (date === todayBRT);
    const nowMinBRT = isToday ? nowBRT.getHours() * 60 + nowBRT.getMinutes() : 0;

    // Horários liberados para esta cidade (override de blocked_slots)
    const relRes = await pool.query(
      `SELECT st, et FROM released_slots
       WHERE date=$1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))`,
      [date, Number(cityId)]
    );
    const released = relRes.rows.map(r => ({
      s: timeToMin(r.st), e: timeToMin(r.et)
    }));

    // Calcula slots livres respeitando configuração dinâmica
    const slots = [];
    for (let s = wStart; s <= wEnd; s += SLOT) {
      const e = s + dur;
      // Filtra horários que já passaram no dia de hoje (fuso Brasília)
      if (isToday && s <= nowMinBRT) continue;
      // Verificar pausas
      const inBreak = breaks.some(b => s < b.e && e > b.s);
      if (inBreak) continue;
      // Verificar sobreposição com agendamentos/bloqueios
      // Se o slot está dentro de uma janela LIBERADA, ignora blocked_slots
      const inReleasedWindow = released.some(r => s >= r.s && e <= r.e);
      const overlap = busy.some(b => {
        if (!inReleasedWindow) return s < b.e && e > b.s; // bloqueios valem normalmente
        // Dentro de janela liberada: só agendamentos reais bloqueiam (não blocked_slots)
        // aRes.rows são os agendamentos; sRes.rows são blocked_slots — ignoramos sRes aqui
        const isAppt = aRes.rows.some(a =>
          timeToMin(a.st) === b.s && timeToMin(a.et) === b.e
        );
        return isAppt && s < b.e && e > b.s;
      });
      if (!overlap) slots.push(minToTime(s));
    }

    res.json(slots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Resumo de receita (admin) ─────────────────────────────────────────────────
app.get('/api/revenue/summary', requireAdmin, async (req, res) => {
  await autoCompleteAppointments();
  try {
    const today = todayBrasilia();
    const month = monthBrasilia();
    const year  = yearBrasilia();
    const { ws, we } = weekBrasilia();

    // COUNT(*) conta TODOS os confirmados; SUM(price) ignora NULL naturalmente
    const q = (sql, p) => pool.query(sql, p).then(r => r.rows[0]);
    const [todayRow, weekRow, monthRow, yearRow] = await Promise.all([
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE date=$1 AND status IN ('confirmed','realizado')`, [today]),
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE date>=$1 AND date<=$2 AND status IN ('confirmed','realizado')`, [ws, we]),
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE to_char(date,'YYYY-MM')=$1 AND status IN ('confirmed','realizado')`, [month]),
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE to_char(date,'YYYY')=$1 AND status IN ('confirmed','realizado')`, [year]),
    ]);
    res.json({ today: todayRow, week: weekRow, month: monthRow, year: yearRow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Promoções ────────────────────────────────────────────────────────────────

// Público: retorna promoção ativa agora (se existir)
app.get('/api/promotions/active', async (req, res) => {
  try {
    const today = todayBrasilia();
    const { rows } = await pool.query(
      `SELECT * FROM promotions
       WHERE active = TRUE AND start_date <= $1 AND end_date >= $1
       ORDER BY created_at DESC LIMIT 1`,
      [today]
    );
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: listar todas
app.get('/api/promotions', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM promotions ORDER BY start_date DESC'
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: criar promoção
app.post('/api/promotions', requireAdmin, async (req, res) => {
  const { name, start_date, end_date, discount, apply_to_all, proc_ids } = req.body;
  if (!name || !start_date || !end_date || !discount) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  }
  if (start_date > end_date) {
    return res.status(400).json({ error: 'Data de início deve ser antes do fim' });
  }
  if (Number(discount) <= 0 || Number(discount) > 100) {
    return res.status(400).json({ error: 'Desconto deve ser entre 1% e 100%' });
  }
  const allProcs = apply_to_all !== false;
  const ids = allProcs ? [] : (Array.isArray(proc_ids) ? proc_ids.map(Number) : []);
  if (!allProcs && ids.length === 0) {
    return res.status(400).json({ error: 'Selecione ao menos um procedimento' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO promotions (name, start_date, end_date, discount, apply_to_all, proc_ids)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, start_date, end_date, Number(discount), allProcs, ids]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: desativar promoção (soft delete)
app.patch('/api/promotions/:id/deactivate', requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE promotions SET active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: excluir promoção definitivamente (hard delete)
app.delete('/api/promotions/:id', requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM promotions WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Promoção não encontrada' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Horários Bloqueados (blocked_slots) ──────────────────────────────────────
app.get('/api/blocked-slots', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM blocked_slots ORDER BY date, st'
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/blocked-slots', requireAdmin, async (req, res) => {
  const { date, st, et, reason, city_ids } = req.body;
  if (!date || !st || !et) return res.status(400).json({ error: 'Data, início e fim são obrigatórios' });
  if (timeToMin(st) >= timeToMin(et)) return res.status(400).json({ error: 'Horário de início deve ser antes do fim' });
  const ids = Array.isArray(city_ids) ? city_ids.map(Number) : [];
  try {
    const { rows } = await pool.query(
      'INSERT INTO blocked_slots (date, st, et, reason, city_ids) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [date, st, et, reason || null, ids]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/blocked-slots/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM blocked_slots WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Backup / Export (admin, desktop only) ────────────────────────────────────
app.get('/api/backup/export', requireAdmin, async (req, res) => {
  try {
    const [procs, appts, blocked, slots, promos] = await Promise.all([
      pool.query('SELECT * FROM procedures ORDER BY id'),
      pool.query('SELECT * FROM appointments ORDER BY date, st'),
      pool.query('SELECT * FROM blocked_dates ORDER BY date'),
      pool.query('SELECT * FROM blocked_slots ORDER BY date, st'),
      pool.query('SELECT * FROM promotions ORDER BY start_date DESC'),
    ]);
    const today = todayBrasilia();
    res.setHeader('Content-Disposition', `attachment; filename="bela-essencia-backup-${today}.json"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({
      exportedAt: new Date().toISOString(),
      version: '1.4.0',
      procedures:    procs.rows,
      appointments:  appts.rows,
      blocked_dates: blocked.rows,
      blocked_slots: slots.rows,
      promotions:    promos.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Cidades ──────────────────────────────────────────────────────────────────
app.get('/api/cities', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM cities WHERE is_active=TRUE ORDER BY id'
    );
    for (const city of rows) {
      // Check if this city has ANY city_procedures rows
      const cpCount = await pool.query(
        'SELECT COUNT(*) FROM city_procedures WHERE city_id=$1', [city.id]
      );
      const hasOverrides = parseInt(cpCount.rows[0].count) > 0;

      const pr = await pool.query(
        `SELECT p.id, p.name, p.dur, p.price, p.pt,
                CASE
                  WHEN $2 THEN COALESCE(cp.enabled, TRUE)
                  ELSE TRUE
                END as enabled
         FROM procedures p
         LEFT JOIN city_procedures cp ON cp.proc_id=p.id AND cp.city_id=$1
         WHERE p.active=TRUE ORDER BY p.id`,
        [city.id, hasOverrides]
      );
      // Only return enabled procedures for client-facing API
      city.procedures = pr.rows.filter(p => p.enabled);
      const wd = await pool.query(
        `SELECT day_of_week, is_active FROM work_configs
         WHERE scope='city_day' AND city_id=$1 ORDER BY day_of_week`,
        [city.id]
      );
      city.activeDays = wd.rows.filter(r=>r.is_active).map(r=>r.day_of_week);
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cities/all', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM cities ORDER BY id');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: get city with ALL procedures (enabled + disabled) for editing
app.get('/api/cities/:id/procedures', requireAdmin, async (req, res) => {
  try {
    const cityId = req.params.id;
    // Check if this city has any proc overrides at all
    const { rowCount } = await pool.query(
      'SELECT 1 FROM city_procedures WHERE city_id=$1 LIMIT 1', [cityId]
    );
    const hasOverrides = rowCount > 0;
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.dur, p.price, p.pt,
              CASE
                WHEN $2 THEN COALESCE(cp.enabled, TRUE)
                ELSE TRUE
              END as enabled
       FROM procedures p
       LEFT JOIN city_procedures cp ON cp.proc_id=p.id AND cp.city_id=$1
       WHERE p.active=TRUE ORDER BY p.id`,
      [cityId, hasOverrides]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cities', requireAdmin, async (req, res) => {
  const { name, uf, local_name, address, number, complement, neighborhood, cep, proc_ids } = req.body;
  if (!name||!uf||!local_name||!address||!number||!neighborhood||!cep)
    return res.status(400).json({ error: 'Campos obrigatórios faltando' });
  try {
    const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(address+' '+number+' '+name+' '+uf)}`;
    const { rows } = await pool.query(
      `INSERT INTO cities (name,uf,local_name,address,number,complement,neighborhood,cep,maps_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name,uf,local_name,address,number,complement||'',neighborhood,cep,mapsUrl]
    );
    const city = rows[0];
    // Seed default schedule (all days disabled)
    const procs = await pool.query('SELECT id FROM procedures WHERE active=TRUE');
    for (let d=0; d<=6; d++) {
      await pool.query(
        `INSERT INTO work_configs (scope,city_id,day_of_week,is_active,work_start,work_end)
         VALUES ('city_day',$1,$2,FALSE,NULL,NULL)`,
        [city.id, d]
      );
    }
    // Insert procedure overrides (all enabled by default unless specified)
    if (proc_ids && proc_ids.length) {
      for (const p of procs.rows) {
        await pool.query(
          `INSERT INTO city_procedures (city_id,proc_id,enabled) VALUES ($1,$2,$3)
           ON CONFLICT (city_id,proc_id) DO UPDATE SET enabled=EXCLUDED.enabled`,
          [city.id, p.id, proc_ids.includes(p.id)]
        );
      }
    }
    res.status(201).json(city);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/cities/:id', requireAdmin, async (req, res) => {
  const { name, uf, local_name, address, number, complement, neighborhood, cep, is_active, proc_overrides } = req.body;
  try {
    const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent((address||'')+' '+(number||'')+' '+(name||'')+' '+(uf||''))}`;
    const { rows } = await pool.query(
      `UPDATE cities SET name=COALESCE($1,name), uf=COALESCE($2,uf), local_name=COALESCE($3,local_name),
       address=COALESCE($4,address), number=COALESCE($5,number), complement=COALESCE($6,complement),
       neighborhood=COALESCE($7,neighborhood), cep=COALESCE($8,cep),
       maps_url=$9, is_active=COALESCE($10,is_active)
       WHERE id=$11 RETURNING *`,
      [name,uf,local_name,address,number,complement,neighborhood,cep,mapsUrl,is_active,req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cidade não encontrada' });
    // Always upsert procedure overrides (delete old + reinsert ensures clean state)
    if (proc_overrides && Object.keys(proc_overrides).length > 0) {
      await pool.query('DELETE FROM city_procedures WHERE city_id=$1', [req.params.id]);
      for (const [procId, enabled] of Object.entries(proc_overrides)) {
        await pool.query(
          `INSERT INTO city_procedures (city_id,proc_id,enabled) VALUES ($1,$2,$3)`,
          [req.params.id, procId, enabled]
        );
      }
    }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/cities/:id', requireAdmin, async (req, res) => {
  try {
    // Only delete if inactive
    const { rows } = await pool.query('SELECT is_active FROM cities WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Cidade não encontrada' });
    if (rows[0].is_active) return res.status(400).json({ error: 'Desative a cidade antes de excluir' });
    await pool.query('DELETE FROM cities WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Work Configs ──────────────────────────────────────────────────────────────
app.get('/api/work-configs', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT wc.*, c.name as city_name,
              array_agg(json_build_object('id',wb.id,'s',wb.break_start::text,'e',wb.break_end::text))
                FILTER (WHERE wb.id IS NOT NULL) as breaks
       FROM work_configs wc
       LEFT JOIN cities c ON c.id=wc.city_id
       LEFT JOIN work_breaks wb ON wb.config_id=wc.id
       GROUP BY wc.id, c.name ORDER BY wc.city_id, wc.day_of_week`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/work-configs/:id', requireAdmin, async (req, res) => {
  const { is_active, work_start, work_end, breaks } = req.body;
  try {
    await pool.query(
      `UPDATE work_configs SET is_active=$1, work_start=$2, work_end=$3 WHERE id=$4`,
      [is_active, is_active ? work_start : null, is_active ? work_end : null, req.params.id]
    );
    if (breaks !== undefined) {
      await pool.query('DELETE FROM work_breaks WHERE config_id=$1', [req.params.id]);
      if (breaks && breaks.length) {
        for (const b of breaks) {
          await pool.query(
            'INSERT INTO work_breaks (config_id,break_start,break_end) VALUES ($1,$2,$3)',
            [req.params.id, b.s, b.e]
          );
        }
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin Profile ─────────────────────────────────────────────────────────────
// Público: expõe apenas nome e telefone para o frontend do cliente
app.get('/api/admin/profile/public', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT name, phone FROM admin_profile LIMIT 1'
    );
    res.json(rows[0] || { name: 'Profissional', phone: '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/profile', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, phone, email, login FROM admin_profile LIMIT 1'
    );
    res.json(rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/profile', requireAdmin, async (req, res) => {
  const { name, phone, email } = req.body;
  if (!name||!phone||!email) return res.status(400).json({ error: 'Nome, telefone e e-mail são obrigatórios' });
  try {
    await pool.query(
      `UPDATE admin_profile SET name=$1, phone=$2, email=$3, updated_at=NOW() WHERE login='admin'`,
      [name, phone, email]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/password', requireAdmin, async (req, res) => {
  const { current, newPass, confirm } = req.body;
  if (!current||!newPass||!confirm) return res.status(400).json({ error: 'Preencha todos os campos' });
  if (newPass !== confirm) return res.status(400).json({ error: 'Nova senha e confirmação não coincidem' });
  // Validate password rules: min 8, letters+numbers, at least 1 uppercase, no special chars
  if (!/^[A-Za-z0-9]{8,}$/.test(newPass))
    return res.status(400).json({ error: 'Senha deve ter no mínimo 8 caracteres, apenas letras e números' });
  if (!/[A-Z]/.test(newPass))
    return res.status(400).json({ error: 'Senha deve ter pelo menos uma letra maiúscula' });
  if (!/[0-9]/.test(newPass))
    return res.status(400).json({ error: 'Senha deve ter pelo menos um número' });
  try {
    const { rows } = await pool.query('SELECT password FROM admin_profile LIMIT 1');
    const stored = rows.length ? rows[0].password : (process.env.ADMIN_PASS || '');
    if (current !== stored) return res.status(401).json({ error: 'Senha atual incorreta' });
    await pool.query(`UPDATE admin_profile SET password=$1, updated_at=NOW() WHERE login='admin'`, [newPass]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Datas Comemorativas ───────────────────────────────────────────────────────
app.get('/api/commemorative', async (req, res) => {
  try {
    const brtNow = nowBrasilia();
    const { rows } = await pool.query(
      `SELECT * FROM commemorative_dates
       WHERE is_active=TRUE AND day=$1 AND month=$2 LIMIT 1`,
      [brtNow.getDate(), brtNow.getMonth() + 1]
    );
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/commemorative/all', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM commemorative_dates ORDER BY month,day');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/commemorative', requireAdmin, async (req, res) => {
  const { day, month, title, message } = req.body;
  if (!day||!month||!title||!message) return res.status(400).json({ error: 'Todos os campos obrigatórios' });
  if (message.length > 300) return res.status(400).json({ error: 'Mensagem máximo 300 caracteres' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO commemorative_dates (day,month,title,message) VALUES ($1,$2,$3,$4) RETURNING *`,
      [day, month, title, message]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/commemorative/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE commemorative_dates SET is_active=NOT is_active WHERE id=$1 RETURNING is_active', [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/commemorative/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT is_active FROM commemorative_dates WHERE id=$1',[req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Data não encontrada' });
    if (rows[0].is_active) return res.status(400).json({ error: 'Cancele a data antes de excluir' });
    await pool.query('DELETE FROM commemorative_dates WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── NPS ──────────────────────────────────────────────────────────────────────

function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  // Remove country code 55 se tiver 13 dígitos
  return digits.length === 13 && digits.startsWith('55') ? digits.slice(2) : digits;
}

function npsCategory(score) {
  if (score >= 9) return 'promoter';
  if (score >= 7) return 'neutral';
  return 'detractor';
}

// Público: verifica se cliente tem procedimento realizado sem NPS (por telefone)
app.get('/api/nps/check', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.json({ eligible: false });

  const norm = normalizePhone(phone);
  if (norm.length < 10) return res.json({ eligible: false });

  try {
    // Último procedimento realizado deste telefone
    const apptRes = await pool.query(
      `SELECT id, proc_name, date FROM appointments
       WHERE regexp_replace(phone, '[^0-9]', '', 'g') LIKE $1
         AND status = 'realizado'
       ORDER BY date DESC, et DESC LIMIT 1`,
      [`%${norm.slice(-8)}`]  // busca pelos últimos 8 dígitos (mais tolerante)
    );
    if (!apptRes.rowCount) return res.json({ eligible: false });
    const appt = apptRes.rows[0];

    // Verificar cooldown: última resposta NPS deste telefone
    const lastRes = await pool.query(
      `SELECT created_at FROM nps_responses
       WHERE phone_norm LIKE $1
       ORDER BY created_at DESC LIMIT 1`,
      [`%${norm.slice(-8)}`]
    );
    if (lastRes.rowCount) {
      const lastDate = new Date(lastRes.rows[0].created_at);
      const daysSince = (Date.now() - lastDate) / (1000 * 60 * 60 * 24);
      if (daysSince < 30) return res.json({ eligible: false, cooldown: true });
    }

    res.json({ eligible: true, appt_id: appt.id, proc_name: appt.proc_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Público: salvar resposta NPS
app.post('/api/nps', async (req, res) => {
  const { phone, appt_id, score, comment } = req.body;
  if (!phone || score === undefined || score === null) {
    return res.status(400).json({ error: 'phone e score são obrigatórios' });
  }
  const s = parseInt(score);
  if (isNaN(s) || s < 0 || s > 10) return res.status(400).json({ error: 'Score deve ser entre 0 e 10' });
  if (comment && comment.length > 300) return res.status(400).json({ error: 'Comentário máx. 300 caracteres' });

  const norm = normalizePhone(phone);
  const category = npsCategory(s);
  try {
    await pool.query(
      `INSERT INTO nps_responses (phone, phone_norm, appt_id, score, comment, category)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [phone, norm, appt_id || null, s, comment || null, category]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: painel NPS completo
app.get('/api/nps/dashboard', requireAdmin, async (req, res) => {
  try {
    const { rows: all } = await pool.query(
      `SELECT score, category, comment, phone, created_at FROM nps_responses ORDER BY created_at DESC`
    );
    if (!all.length) return res.json({ score: null, total: 0, promoters: 0, neutrals: 0, detractors: 0, responses: [] });

    const total      = all.length;
    const promoters  = all.filter(r => r.category === 'promoter').length;
    const neutrals   = all.filter(r => r.category === 'neutral').length;
    const detractors = all.filter(r => r.category === 'detractor').length;
    const nps        = Math.round(((promoters - detractors) / total) * 100);
    const avg        = (all.reduce((s,r) => s + r.score, 0) / total).toFixed(1);

    // Distribuição por nota (0-10)
    const distribution = Array.from({length: 11}, (_, i) => ({
      score: i,
      count: all.filter(r => r.score === i).length
    }));

    res.json({ nps, avg, total, promoters, neutrals, detractors, distribution, responses: all });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Liberar Datas ────────────────────────────────────────────────────────────

app.get('/api/released', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM released_dates ORDER BY date');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/released', requireAdmin, async (req, res) => {
  const { date, city_ids, work_start, work_end, break_start, break_end, reason } = req.body;
  if (!date || !work_start || !work_end) return res.status(400).json({ error: 'Data, início e fim são obrigatórios' });
  const ids = Array.isArray(city_ids) ? city_ids.map(Number) : [];
  try {
    const { rows } = await pool.query(
      `INSERT INTO released_dates (date, city_ids, work_start, work_end, break_start, break_end, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (date) DO UPDATE
         SET city_ids=$2, work_start=$3, work_end=$4, break_start=$5, break_end=$6, reason=$7
       RETURNING *`,
      [date, ids, work_start, work_end, break_start||null, break_end||null, reason||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/released/:date', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM released_dates WHERE date=$1', [req.params.date]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/released-slots', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM released_slots ORDER BY date, st');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/released-slots', requireAdmin, async (req, res) => {
  const { date, st, et, city_ids, reason } = req.body;
  if (!date || !st || !et) return res.status(400).json({ error: 'Data, início e fim são obrigatórios' });
  if (timeToMin(st) >= timeToMin(et)) return res.status(400).json({ error: 'Início deve ser antes do fim' });
  const ids = Array.isArray(city_ids) ? city_ids.map(Number) : [];
  try {
    const { rows } = await pool.query(
      `INSERT INTO released_slots (date, st, et, city_ids, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [date, st, et, ids, reason||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/released-slots/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM released_slots WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Push Helpers ─────────────────────────────────────────────────────────────
const PUSH_ENABLED = () => !!(process.env.VAPID_PUBLIC_KEY);

async function sendPush(subscriptions, title, body, data = {}) {
  if (!PUSH_ENABLED()) {
    console.log('[Push] VAPID não configurado, skip.');
    return;
  }
  if (!subscriptions || !subscriptions.length) {
    console.log('[Push] Nenhuma subscription para enviar.');
    return;
  }

  const payload = JSON.stringify({ title, body, data });
  console.log(`[Push] Enviando "${title}" para ${subscriptions.length} subscription(s)...`);

  const results = await Promise.allSettled(
    subscriptions.map(async sub => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 86400 }
        );
        console.log('[Push] Enviado com sucesso:', sub.endpoint.slice(-30));
      } catch (err) {
        console.error('[Push] Erro ao enviar:', err.statusCode, err.message);
        // Remove subscriptions inválidas/expiradas
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
          console.log('[Push] Subscription removida (expirada).');
        }
        throw err;
      }
    })
  );

  const ok = results.filter(r => r.status === 'fulfilled').length;
  console.log(`[Push] Resultado: ${ok}/${results.length} enviados com sucesso.`);
}

async function getSubsByRole(role) {
  const { rows } = await pool.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE role=$1', [role]
  );
  return rows;
}

async function getSubsByAuth(authKey) {
  if (!authKey) return [];
  const { rows } = await pool.query(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions
     WHERE role='client' AND auth=$1`,
    [authKey]
  );
  return rows;
}

// Notifica admin sobre novo agendamento
async function notifyAdminNewBooking(appt) {
  const subs = await getSubsByRole('admin');
  await sendPush(subs,
    '✨ Novo agendamento!',
    `${appt.name} · ${appt.proc_name} · ${String(appt.date).slice(0,10)} às ${String(appt.st).slice(0,5)}`,
    { url: '/#admin', type: 'new_booking' }
  );
}

// Notifica cliente específico sobre alteração
async function notifyClientEdit(appt) {
  const subs = await getSubsByAuth(appt.push_auth);
  await sendPush(subs,
    '📅 Agendamento alterado',
    `Seu agendamento sofreu alterações. Verifique os detalhes.`,
    { type: 'edit_booking' }
  );
}

// Notifica cliente específico sobre procedimento realizado
async function notifyClientCompleted(appt) {
  const subs = await getSubsByAuth(appt.push_auth);
  await sendPush(subs,
    '💖 Obrigada pela sua visita!',
    `Seu procedimento de ${appt.proc_name} foi realizado com sucesso. Até a próxima!`,
    { type: 'completed' }
  );
}

// ── Push Routes ───────────────────────────────────────────────────────────────

// Retorna a VAPID public key para o frontend
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

// Cliente se inscreve para push — salva subscription e envia confirmação imediata
app.post('/api/push/subscribe/client', async (req, res) => {
  const { endpoint, keys, appointmentId } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Dados de inscrição inválidos' });
  }
  console.log('[Push] Nova subscription cliente, appointmentId:', appointmentId);
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, role)
       VALUES ($1, $2, $3, 'client')
       ON CONFLICT (endpoint) DO UPDATE SET p256dh=$2, auth=$3`,
      [endpoint, keys.p256dh, keys.auth]
    );

    // Liga a subscription ao agendamento para notificações futuras
    if (appointmentId) {
      await pool.query(
        `UPDATE appointments SET push_auth=$1 WHERE id=$2`,
        [keys.auth, appointmentId]
      );
    }

    res.json({ ok: true });

    // Envia confirmação push imediatamente após inscrição
    // (resolve o race condition — subscription existe ANTES de enviar)
    if (appointmentId) {
      const { rows } = await pool.query('SELECT * FROM appointments WHERE id=$1', [appointmentId]);
      if (rows.length) {
        const appt = rows[0];
        const sub = { endpoint, p256dh: keys.p256dh, auth: keys.auth };
        sendPush([sub],
          '✅ Agendamento confirmado!',
          `${appt.proc_name} · ${String(appt.date).slice(0,10)} às ${String(appt.st).slice(0,5)}`,
          { type: 'confirmed' }
        ).catch(e => console.error('[Push] confirmação cliente:', e.message));
      }
    }
  } catch (err) {
    console.error('[Push] Erro subscribe/client:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Push Templates (Web Push Manager) ────────────────────────────────────────

// Listar todos os templates
app.get('/api/push/templates', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM push_templates ORDER BY is_system DESC, id');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Criar template customizado
app.post('/api/push/templates', requireAdmin, async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Título e mensagem são obrigatórios' });
  if (title.length > 200) return res.status(400).json({ error: 'Título máx. 200 caracteres' });
  if (body.length > 500)  return res.status(400).json({ error: 'Mensagem máx. 500 caracteres' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO push_templates (title, body, is_system) VALUES ($1, $2, FALSE) RETURNING *`,
      [title, body]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Editar template (só customizados — sistema protegido)
app.put('/api/push/templates/:id', requireAdmin, async (req, res) => {
  const { title, body } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE push_templates SET title=$1, body=$2
       WHERE id=$3 AND is_system=FALSE RETURNING *`,
      [title, body, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Template não encontrado ou é do sistema' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Excluir template (só customizados)
app.delete('/api/push/templates/:id', requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM push_templates WHERE id=$1 AND is_system=FALSE`,
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Template não encontrado ou protegido' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Disparar push em massa para TODOS os subscribers (admin + client)
app.post('/api/push/broadcast', requireAdmin, async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Título e mensagem obrigatórios' });
  try {
    const { rows: allSubs } = await pool.query(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions'
    );
    console.log(`[Push/broadcast] Disparando para ${allSubs.length} subscribers...`);
    // Não await — dispara async e responde imediatamente
    sendPush(allSubs, title, body, { type: 'broadcast' })
      .catch(e => console.error('[Push/broadcast] Erro:', e.message));
    res.json({ ok: true, total: allSubs.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Contar subscribers ativos
app.get('/api/push/subscribers/count', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT role, COUNT(*) as cnt FROM push_subscriptions GROUP BY role`
    );
    const result = { total: 0, admin: 0, client: 0 };
    rows.forEach(r => { result[r.role] = parseInt(r.cnt); result.total += parseInt(r.cnt); });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: testar push manualmente
app.post('/api/push/test', requireAdmin, async (req, res) => {
  try {
    const adminSubs = await getSubsByRole('admin');
    const clientSubs = await getSubsByRole('client');
    console.log(`[Push/test] admin subs: ${adminSubs.length}, client subs: ${clientSubs.length}`);
    if (adminSubs.length) {
      await sendPush(adminSubs, '🔔 Teste Push Admin', 'Se você está vendo isso, o push está funcionando!', { type: 'test' });
    }
    if (clientSubs.length) {
      await sendPush(clientSubs, '🔔 Teste Push Cliente', 'Se você está vendo isso, o push está funcionando!', { type: 'test' });
    }
    res.json({ ok: true, adminSubs: adminSubs.length, clientSubs: clientSubs.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Profissional se inscreve (chamado no login do admin)
app.post('/api/push/subscribe/admin', requireAdmin, async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Dados de inscrição inválidos' });
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (endpoint) DO UPDATE SET p256dh=$2, auth=$3`,
      [endpoint, keys.p256dh, keys.auth]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. FRONTEND ESTÁTICO
// ══════════════════════════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback – qualquer rota não encontrada retorna o index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. INICIALIZAÇÃO
// ══════════════════════════════════════════════════════════════════════════════
// ── E-mail diário da agenda (via Resend API — HTTPS, nunca bloqueado) ──────────
// Resend: https://resend.com — grátis até 3.000 emails/mês
// Variável necessária no Railway: RESEND_API_KEY
async function sendEmail({ to, bcc, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('[Email] RESEND_API_KEY não configurada. Pulando envio.');
    return null;
  }
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    'Belle Planner <noreply@belaessencia.app.br>',
      to:      Array.isArray(to) ? to : [to],
      bcc:     bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined,
      subject,
      html,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || `Resend error ${resp.status}`);
  return data;
}

async function sendDailyAgendaEmail() {
  if (!process.env.RESEND_API_KEY) {
    console.log('[Email] RESEND_API_KEY não configurada. Pulando envio.');
    return;
  }
  console.log('[Email] RESEND_API_KEY: ✓ configurada');

  try {
    // Dados do profissional
    const { rows: profRows } = await pool.query(
      'SELECT name, email FROM admin_profile LIMIT 1'
    );
    if (!profRows.length || !profRows[0].email) {
      console.log('[Email] E-mail do profissional não cadastrado.');
      return;
    }
    const prof = profRows[0];
    const today = todayBrasilia();

    // Agendamentos do dia
    const { rows: appts } = await pool.query(
      `SELECT a.*, c.name as city_display
       FROM appointments a
       LEFT JOIN cities c ON c.id = a.city_id
       WHERE a.date = $1 AND a.status IN ('confirmed','realizado')
       ORDER BY a.city_name, a.st`,
      [today]
    );

    if (!appts.length) {
      console.log('[Email] Nenhum agendamento hoje. Não enviando.');
      return;
    }

    // Formata data em português
    const months = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    const d = new Date(today + 'T12:00:00');
    const dateLabel = `${d.getDate()} de ${months[d.getMonth()]} de ${d.getFullYear()}`;

    // Agrupa por cidade
    const byCidade = {};
    for (const a of appts) {
      const city = a.city_name || a.city_display || 'Cidade não informada';
      if (!byCidade[city]) byCidade[city] = [];
      byCidade[city].push(a);
    }

    // Monta HTML do e-mail
    const cityBlocks = Object.entries(byCidade).map(([city, items]) => {
      const rows = items.map(a => {
        const valor = a.price
          ? `R$ ${Number(a.price).toLocaleString('pt-BR', {minimumFractionDigits:2})}`
          : a.pt === 'eval' ? 'Sob avaliação' : '—';
        const phone = a.phone || '—';
        return `
          <tr>
            <td style="padding:10px 14px;border-bottom:1px solid #f0e8ec;font-weight:600;color:#2d1a22">${a.name}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #f0e8ec;color:#666">${phone}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #f0e8ec;color:#2d1a22">${a.proc_name}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #f0e8ec;color:#2d1a22;white-space:nowrap">${String(a.st).slice(0,5)}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #f0e8ec;color:#9b4d6a;font-weight:700">${valor}</td>
          </tr>`;
      }).join('');
      return `
        <div style="margin-bottom:28px">
          <div style="background:#9b4d6a;color:white;padding:10px 16px;border-radius:8px 8px 0 0;font-size:15px;font-weight:700">
            📍 ${city}
          </div>
          <table style="width:100%;border-collapse:collapse;background:white;border-radius:0 0 8px 8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
            <thead>
              <tr style="background:#fdf0f4">
                <th style="padding:8px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:#9b4d6a;letter-spacing:.06em">Cliente</th>
                <th style="padding:8px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:#9b4d6a;letter-spacing:.06em">WhatsApp</th>
                <th style="padding:8px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:#9b4d6a;letter-spacing:.06em">Procedimento</th>
                <th style="padding:8px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:#9b4d6a;letter-spacing:.06em">Horário</th>
                <th style="padding:8px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:#9b4d6a;letter-spacing:.06em">Valor</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join('');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;background:#fdf5f8;padding:24px">
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-family:Georgia,serif;font-size:28px;color:#9b4d6a;font-style:italic">Bela Essência</div>
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#b07090;margin-top:4px">Agenda do Dia</div>
        </div>
        <div style="background:linear-gradient(135deg,#9b4d6a,#7b3050);border-radius:12px;padding:20px 24px;margin-bottom:24px;color:white;text-align:center">
          <div style="font-size:14px;opacity:.85;margin-bottom:6px">Sua programação para</div>
          <div style="font-family:Georgia,serif;font-size:24px;font-weight:bold">${dateLabel}</div>
          <div style="font-size:13px;margin-top:8px;opacity:.85">${appts.length} procedimento${appts.length!==1?'s':''} agendado${appts.length!==1?'s':''}</div>
        </div>
        ${cityBlocks}
        <div style="text-align:center;margin-top:24px;font-size:11px;color:#aaa">
          Bela Essência · Sistema de Agendamento Online<br>
          Este e-mail é gerado automaticamente às 06h30 (horário de Brasília)
        </div>
      </div>`;

    const firstName = prof.name.split(' ')[0];
    console.log(`[Email] Enviando via Resend para ${prof.email}...`);
    const result = await sendEmail({
      to:      prof.email,
      bcc:     'erick.torritezi@gmail.com',
      subject: `${firstName}, veja sua agenda do dia! 📅`,
      html,
    });
    console.log(`[Email] ✓ Enviado! id: ${result?.id} | para: ${prof.email} | BCC: erick.torritezi@gmail.com`);
  } catch (err) {
    console.error('[Email] Erro ao enviar via Resend:', err.message);
  }
}

// Admin: disparar e-mail manualmente (para teste)
app.post('/api/admin/send-daily-email', requireAdmin, async (req, res) => {
  console.log('[Email] Disparo manual solicitado pelo admin...');
  console.log('[Email] RESEND_API_KEY:', process.env.RESEND_API_KEY ? '✓ configurada' : '✗ NÃO configurada');
  try {
    await sendDailyAgendaEmail();
    res.json({ ok: true, message: 'E-mail enviado. Verifique os logs do servidor.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cron: todo dia às 06h30 horário de Brasília (= 09h30 UTC)
// Railway está em UTC → 06h30 BRT = 09h30 UTC
cron.schedule('30 9 * * *', () => {
  console.log('[Cron] Disparando e-mail da agenda diária...');
  sendDailyAgendaEmail();
}, { timezone: 'UTC' });

async function start() {
  try {
    await initDB();
    await initVapid(); // gera/carrega chaves VAPID automaticamente
    app.listen(PORT, () => {
      console.log(`✅  Bela Essência rodando na porta ${PORT}`);
      // E-mail diário configurado via cron às 06h30 BRT (ver abaixo)
    });
  } catch (err) {
    console.error('❌  Falha ao iniciar servidor:', err.message);
    process.exit(1);
  }
}

start();
