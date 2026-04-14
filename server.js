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
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
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
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use(session({
  secret: SESSION_SEC,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
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
app.post('/api/auth/login', (req, res) => {
  const { user, pass } = req.body;
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
  if (date)   { sql += ` AND date = $${params.push(date)}`; }
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

app.get('/api/availability', async (req, res) => {
  const { date, procId, cityId } = req.query;
  if (!date || !procId || !cityId) {
    return res.status(400).json({ error: 'date, procId e cityId são obrigatórios' });
  }

  try {
    // Verifica data bloqueada
    const blk = await pool.query('SELECT 1 FROM blocked_dates WHERE date=$1', [date]);
    if (blk.rowCount > 0) return res.json([]);

    // Busca duração do procedimento
    const pRes = await pool.query('SELECT dur FROM procedures WHERE id=$1 AND active=TRUE', [procId]);
    if (!pRes.rowCount) return res.json([]);
    const dur = pRes.rows[0].dur;

    // Busca agendamentos confirmados no dia
    const aRes = await pool.query(
      `SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled'`,
      [date]
    );
    const busy = aRes.rows.map(r => ({
      s: timeToMin(r.st),
      e: timeToMin(r.et),
    }));

    // Calcula slots livres
    const slots = [];
    for (let s = WSTART; s <= WLAST; s += SLOT) {
      const e = s + dur;
      if (s < LEND && e > LSTRT) continue; // bloqueia almoço
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

    const q = (sql, p) => pool.query(sql, p).then(r => r.rows[0]);
    const [todayRow, weekRow, monthRow, yearRow] = await Promise.all([
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE date=$1 AND status='confirmed' AND pt!='none'`, [today]),
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE date>=$1 AND status='confirmed' AND pt!='none'`, [ws]),
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE to_char(date,'YYYY-MM')=$1 AND status='confirmed' AND pt!='none'`, [month]),
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE to_char(date,'YYYY')=$1 AND status='confirmed' AND pt!='none'`, [year]),
    ]);
    res.json({ today: todayRow, week: weekRow, month: monthRow, year: yearRow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
