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

// ══════════════════════════════════════════════════════════════════════════════
// 1. CONFIGURAÇÃO
// ══════════════════════════════════════════════════════════════════════════════
const PORT         = process.env.PORT || 3000;
const ADMIN_USER   = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS   = process.env.ADMIN_PASS || 'belaessencia2025';
const SESSION_SEC  = process.env.SESSION_SECRET || 'dev_secret_troque_em_prod';

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

    // ── DATAS COMEMORATIVAS ──────────────────────────────────────────────────
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
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Admin: listar agendamentos com filtros
app.get('/api/appointments', requireAdmin, async (req, res) => {
  const { date, city, status } = req.query;
  let sql = 'SELECT * FROM appointments WHERE 1=1';
  const params = [];
  if (date) {
    // Filtro exato por data
    sql += ` AND date = $${params.push(date)}`;
  } else {
    // Padrão: exibe da data atual em diante
    const today = new Date().toISOString().slice(0, 10);
    sql += ` AND date >= $${params.push(today)}`;
  }
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
       WHERE to_char(date,'YYYY-MM') = $1 AND status = 'confirmed'
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
  const { name, phone, date, st, procDur } = req.body;
  const dur = parseInt(procDur) || 60;
  const stMin = timeToMin(st);
  const et = minToTime(stMin + dur);
  try {
    const { rows } = await pool.query(
      `UPDATE appointments SET name=$1, phone=$2, date=$3, st=$4, et=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [name, phone, date, st, et, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agendamento não encontrado' });
    res.json(rows[0]);
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
    res.json(rows[0]);
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
  const { date, reason } = req.body;
  if (!date) return res.status(400).json({ error: 'Data obrigatória' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO blocked_dates (date, reason) VALUES ($1, $2) ON CONFLICT(date) DO NOTHING RETURNING *',
      [date, reason || null]
    );
    res.status(201).json(rows[0] || { date, reason });
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
    // Verifica data bloqueada
    const blk = await pool.query('SELECT 1 FROM blocked_dates WHERE date=$1', [date]);
    if (blk.rowCount > 0) return res.json([]);

    // Resolve config de horário para esta cidade+dia
    const [y,m,d] = date.split('-').map(Number);
    const dayOfWeek = new Date(y, m-1, d).getDay();
    const cfg = await resolveWorkConfig(Number(cityId), dayOfWeek);

    // Dia desabilitado na config
    if (!cfg.is_active || !cfg.work_start || !cfg.work_end) return res.json([]);

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

    // Agendamentos e horários bloqueados
    const [aRes, sRes] = await Promise.all([
      pool.query(`SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled'`, [date]),
      pool.query(`SELECT st, et FROM blocked_slots WHERE date=$1`, [date]),
    ]);
    const busy = [...aRes.rows, ...sRes.rows].map(r => ({
      s: timeToMin(r.st), e: timeToMin(r.et),
    }));

    // Calcula slots livres respeitando configuração dinâmica
    const slots = [];
    for (let s = wStart; s <= wEnd; s += SLOT) {
      const e = s + dur;
      // Verificar pausas
      const inBreak = breaks.some(b => s < b.e && e > b.s);
      if (inBreak) continue;
      // Verificar sobreposição com agendamentos
      const overlap = busy.some(b => s < b.e && e > b.s);
      if (!overlap) slots.push(minToTime(s));
    }

    res.json(slots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Resumo de receita (admin) ─────────────────────────────────────────────────
app.get('/api/revenue/summary', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const year  = today.slice(0, 4);
    // Início da semana (domingo)
    const weekDay = now.getDay();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - weekDay);
    const ws = weekStart.toISOString().slice(0, 10);

    // COUNT(*) conta TODOS os confirmados; SUM(price) ignora NULL naturalmente
    const q = (sql, p) => pool.query(sql, p).then(r => r.rows[0]);
    const [todayRow, weekRow, monthRow, yearRow] = await Promise.all([
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE date=$1 AND status='confirmed'`, [today]),
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE date>=$1 AND status='confirmed'`, [ws]),
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE to_char(date,'YYYY-MM')=$1 AND status='confirmed'`, [month]),
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE to_char(date,'YYYY')=$1 AND status='confirmed'`, [year]),
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
    const today = new Date().toISOString().slice(0, 10);
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
  const { date, st, et, reason } = req.body;
  if (!date || !st || !et) return res.status(400).json({ error: 'Data, início e fim são obrigatórios' });
  if (timeToMin(st) >= timeToMin(et)) return res.status(400).json({ error: 'Horário de início deve ser antes do fim' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO blocked_slots (date, st, et, reason) VALUES ($1,$2,$3,$4) RETURNING *',
      [date, st, et, reason || null]
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
    const today = new Date().toISOString().slice(0,10);
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
    const now = new Date();
    const { rows } = await pool.query(
      `SELECT * FROM commemorative_dates
       WHERE is_active=TRUE AND day=$1 AND month=$2 LIMIT 1`,
      [now.getDate(), now.getMonth() + 1]
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
async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`✅  Bela Essência rodando na porta ${PORT}`);
    });
  } catch (err) {
    console.error('❌  Falha ao iniciar servidor:', err.message);
    process.exit(1);
  }
}

start();
