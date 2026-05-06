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

// ── Multi-tenant: schema por tenant ──────────────────────────────────────────

// Cache de tenants para evitar query a cada request
const _tenantCache = new Map();

async function getTenantByHost(host) {
  if (_tenantCache.has(host)) return _tenantCache.get(host);
  try {
    const { rows } = await pool.query(
      `SELECT t.*, tc.primary_color, tc.secondary_color, tc.accent_color,
              tc.logo_url, tc.favicon_url, tc.business_name, tc.tagline,
              tc.whatsapp_number, tc.resend_from_email, tc.admin_user,
              tc.admin_pass_hash, tc.timezone
       FROM tenants t
       LEFT JOIN tenant_configs tc ON tc.tenant_id = t.id
       WHERE (
         t.domain_custom = $1
         OR t.subdomain = $1
         OR t.subdomain || '.belleplanner.com.br' = $1
         OR $1 LIKE t.subdomain || '.%'
       )
       LIMIT 1`,
      [host]
    );
    const tenant = rows[0] || null;
    if (tenant) _tenantCache.set(host, tenant);
    return tenant;
  } catch { return null; }
}

// Invalida cache de um tenant (após atualização de config)
function invalidateTenantCache(host) { _tenantCache.delete(host); }

// Migra dados do schema public para o schema do tenant (apenas se vazio)
async function migrateTenantData(schemaName) {
  const client = await pool.connect();
  try {
    // Verifica se a migração está COMPLETA (procedures E cities com dados)
    const checkProc = await client.query(`SELECT COUNT(*) as cnt FROM "${schemaName}".procedures`);
    const checkCity = await client.query(`SELECT COUNT(*) as cnt FROM "${schemaName}".cities`);
    const hasProc   = Number(checkProc.rows[0].cnt) > 0;
    const hasCity   = Number(checkCity.rows[0].cnt) > 0;

    if (hasProc && hasCity) {
      console.log(`[DB] Schema "${schemaName}" já migrado completamente — ignorado.`);
      return;
    }

    // Migração parcial ou incompleta — limpa e refaz do zero
    if (hasProc || hasCity) {
      console.log(`[DB] Migração incompleta em "${schemaName}" — limpando para refazer...`);
      const tables = [
        'nps_responses','push_subscriptions','push_templates','app_settings',
        'admin_profile','commemorative_dates','promotions','released_slots',
        'released_dates','blocked_slots','blocked_dates','appointments',
        'work_breaks','work_configs','city_procedures','cities','procedures',
      ];
      for (const tbl of tables) {
        try { await client.query(`TRUNCATE "${schemaName}".${tbl} RESTART IDENTITY CASCADE`); } catch {}
      }
      console.log(`[DB] Schema "${schemaName}" limpo — iniciando migração completa...`);
    }

    console.log(`[DB] Iniciando migração public → "${schemaName}"...`);

    const tables = [
      'procedures', 'cities', 'city_procedures', 'work_configs', 'work_breaks',
      'appointments', 'blocked_dates', 'blocked_slots', 'released_dates',
      'released_slots', 'promotions', 'commemorative_dates', 'admin_profile',
      'push_subscriptions', 'push_templates', 'app_settings', 'nps_responses',
    ];

    for (const tbl of tables) {
      try {
        // Busca colunas que existem em AMBOS os schemas (evita mismatch de ordem/estrutura)
        const { rows: colRows } = await client.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
            AND column_name IN (
              SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $2
            )
          ORDER BY ordinal_position
        `, [schemaName, tbl]);

        if (!colRows.length) continue;
        const cols = colRows.map(r => `"${r.column_name}"`).join(', ');

        await client.query(
          `INSERT INTO "${schemaName}".${tbl} (${cols})
           SELECT ${cols} FROM public.${tbl}`
        );
        const cnt = await client.query(
          `SELECT COUNT(*) as n FROM "${schemaName}".${tbl}`
        );
        console.log(`[DB] Migrado: ${tbl} (${cnt.rows[0].n} registros)`);
      } catch (err) {
        if (!err.message.includes('does not exist')) {
          console.warn(`[DB] Aviso ao migrar ${tbl}: ${err.message}`);
        }
      }
    }

    // Sincroniza sequences para evitar conflito de IDs
    const seqTables = [
      { tbl: 'procedures',          seq: 'procedures_id_seq' },
      { tbl: 'cities',              seq: 'cities_id_seq' },
      { tbl: 'work_configs',        seq: 'work_configs_id_seq' },
      { tbl: 'work_breaks',         seq: 'work_breaks_id_seq' },
      { tbl: 'blocked_slots',       seq: 'blocked_slots_id_seq' },
      { tbl: 'released_dates',      seq: 'released_dates_id_seq' },
      { tbl: 'released_slots',      seq: 'released_slots_id_seq' },
      { tbl: 'promotions',          seq: 'promotions_id_seq' },
      { tbl: 'commemorative_dates', seq: 'commemorative_dates_id_seq' },
      { tbl: 'admin_profile',       seq: 'admin_profile_id_seq' },
      { tbl: 'push_subscriptions',  seq: 'push_subscriptions_id_seq' },
      { tbl: 'push_templates',      seq: 'push_templates_id_seq' },
      { tbl: 'nps_responses',       seq: 'nps_responses_id_seq' },
    ];

    for (const { tbl, seq } of seqTables) {
      try {
        await client.query(`
          SELECT setval('"${schemaName}".${seq}',
            COALESCE((SELECT MAX(id) FROM "${schemaName}".${tbl}), 1), true)
        `);
      } catch {}
    }

    // admin_profile: inserção especial (pass_hash pode ser nulo no public)
    try {
      const apCnt = await client.query(`SELECT COUNT(*) as cnt FROM "${schemaName}".admin_profile`);
      if (Number(apCnt.rows[0].cnt) === 0) {
        const { rows: src } = await client.query(
          `SELECT id, name, email, login, pass_hash FROM public.admin_profile LIMIT 1`
        );
        if (src.length > 0) {
          await client.query(
            `INSERT INTO "${schemaName}".admin_profile (id, name, email, login, pass_hash)
             VALUES ($1, $2, $3, $4, $5)`,
            [src[0].id, src[0].name || 'Profissional', src[0].email || '',
             src[0].login || 'admin', src[0].pass_hash || null]
          );
          console.log(`[DB] Migrado: admin_profile (1 registro)`);
        }
      }
    } catch (e) { console.warn('[DB] admin_profile fallback:', e.message); }

    console.log(`[DB] Migração para "${schemaName}" concluída com sucesso.`);
  } finally {
    client.release();
  }
}

// Cria o schema de um novo tenant com todas as tabelas
async function createTenantSchema(schemaName) {
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}", public`);

    // Cria todas as tabelas no schema do tenant (mesma estrutura do public)
    const tables = [
      `CREATE TABLE IF NOT EXISTS procedures (
        id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL, dur INTEGER NOT NULL,
        price NUMERIC(10,2), pt VARCHAR(10) NOT NULL DEFAULT 'fixed',
        description TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS cities (
        id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, short VARCHAR(50),
        local_name VARCHAR(100), address VARCHAR(200), number VARCHAR(20),
        complement VARCHAR(100), neighborhood VARCHAR(100), uf VARCHAR(2),
        cep VARCHAR(10), maps_url TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS city_procedures (
        city_id INTEGER NOT NULL, proc_id INTEGER NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (city_id, proc_id)
      )`,
      `CREATE TABLE IF NOT EXISTS work_configs (
        id SERIAL PRIMARY KEY, scope VARCHAR(20) NOT NULL DEFAULT 'city_day',
        city_id INTEGER, day_of_week INTEGER, is_active BOOLEAN NOT NULL DEFAULT FALSE,
        work_start TIME, work_end TIME, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS work_breaks (
        id SERIAL PRIMARY KEY, config_id INTEGER NOT NULL, break_start TIME NOT NULL,
        break_end TIME NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS appointments (
        id VARCHAR(30) PRIMARY KEY, city_id INTEGER NOT NULL, city_name VARCHAR(100) NOT NULL,
        proc_id INTEGER, proc_name VARCHAR(200) NOT NULL, date DATE NOT NULL,
        st TIME NOT NULL, et TIME NOT NULL, name VARCHAR(200) NOT NULL,
        phone VARCHAR(30) NOT NULL, price NUMERIC(10,2), pt VARCHAR(10),
        status VARCHAR(20) NOT NULL DEFAULT 'confirmed', push_auth TEXT,
        privacy_consent BOOLEAN NOT NULL DEFAULT FALSE,
        consent_at      TIMESTAMPTZ,
        consent_version VARCHAR(10) NOT NULL DEFAULT 'v1.0',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ
      )`,
      `CREATE TABLE IF NOT EXISTS blocked_dates (
        date DATE PRIMARY KEY, reason VARCHAR(200), city_ids INTEGER[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS blocked_slots (
        id SERIAL PRIMARY KEY, date DATE NOT NULL, st TIME NOT NULL, et TIME NOT NULL,
        reason VARCHAR(200), city_ids INTEGER[] NOT NULL DEFAULT '{}'
      )`,
      `CREATE TABLE IF NOT EXISTS released_dates (
        id SERIAL PRIMARY KEY, date DATE NOT NULL, city_ids INTEGER[] NOT NULL DEFAULT '{}',
        work_start TIME NOT NULL DEFAULT '08:00', work_end TIME NOT NULL DEFAULT '18:00',
        break_start TIME, break_end TIME, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_released_dates_date_${schemaName.replace('-','_')} ON released_dates(date)`,
      `CREATE TABLE IF NOT EXISTS released_slots (
        id SERIAL PRIMARY KEY, date DATE NOT NULL, st TIME NOT NULL, et TIME NOT NULL,
        city_ids INTEGER[] NOT NULL DEFAULT '{}', reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS promotions (
        id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, start_date DATE NOT NULL,
        end_date DATE NOT NULL, discount NUMERIC(5,2) NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
        apply_to_all BOOLEAN NOT NULL DEFAULT TRUE, proc_ids INTEGER[] NOT NULL DEFAULT '{}',
        apply_to_all_cities BOOLEAN NOT NULL DEFAULT TRUE, city_ids_promo INTEGER[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS commemorative_dates (
        id          SERIAL      PRIMARY KEY,
        title       VARCHAR(100) NOT NULL,
        day         INTEGER     NOT NULL,
        month       INTEGER     NOT NULL,
        message     VARCHAR(500),
        -- Período de veiculação (opcional — se nulo, exibe apenas no dia exato)
        from_day    INTEGER,
        from_month  INTEGER,
        to_day      INTEGER,
        to_month    INTEGER,
        is_active   BOOLEAN     NOT NULL DEFAULT TRUE
      )`,
      `CREATE TABLE IF NOT EXISTS admin_profile (
        id        SERIAL       PRIMARY KEY,
        name      VARCHAR(200) NOT NULL DEFAULT 'Profissional',
        phone     VARCHAR(30),
        email     VARCHAR(150),
        login     VARCHAR(50)  NOT NULL DEFAULT 'admin',
        pass_hash TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS push_templates (
        id SERIAL PRIMARY KEY, title VARCHAR(100) NOT NULL, body VARCHAR(300) NOT NULL,
        is_system BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS app_settings (
        key VARCHAR(50) PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS nps_responses (
        id SERIAL PRIMARY KEY, phone VARCHAR(30) NOT NULL, phone_norm VARCHAR(20) NOT NULL,
        appt_id VARCHAR(30), score SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 10),
        comment VARCHAR(300), category VARCHAR(10) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ];

    for (const sql of tables) {
      await client.query(sql);
    }
    console.log(`[DB] Schema "${schemaName}" criado com todas as tabelas.`);
  } finally {
    client.release();
  }
}

// Insere dados iniciais no schema do novo tenant
async function seedTenantData(schemaName, tenantData = {}) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schemaName}", public`);

    const { name, email, login, passHash } = tenantData;

    // admin_profile
    const apCount = await client.query(`SELECT COUNT(*) as n FROM admin_profile`);
    if (Number(apCount.rows[0].n) === 0 && passHash) {
      await client.query(
        `INSERT INTO admin_profile (name, email, login, pass_hash)
         VALUES ($1, $2, $3, $4)`,
        [name || 'Profissional', email || '', login || 'admin', passHash]
      );
      console.log(`[DB] admin_profile inserido em "${schemaName}"`);
    }

    // work_configs padrão: Seg-Sex, 08h-18h
    const wcCount = await client.query(`SELECT COUNT(*) as n FROM work_configs`);
    if (Number(wcCount.rows[0].n) === 0) {
      // dias 1=seg a 5=sex
      for (let day = 1; day <= 5; day++) {
        await client.query(
          `INSERT INTO work_configs (scope, day_of_week, is_active, work_start, work_end)
           VALUES ('city_day', $1, TRUE, '08:00', '18:00')`,
          [day]
        );
      }
      // sab e dom desativados
      for (let day of [0, 6]) {
        await client.query(
          `INSERT INTO work_configs (scope, day_of_week, is_active, work_start, work_end)
           VALUES ('city_day', $1, FALSE, '08:00', '18:00')`,
          [day]
        );
      }
      console.log(`[DB] work_configs padrão inseridos em "${schemaName}"`);
    }

    // app_settings padrão
    const asCount = await client.query(`SELECT COUNT(*) as n FROM app_settings`);
    if (Number(asCount.rows[0].n) === 0) {
      const defaults = [
        ['nps_enabled', 'true'],
        ['nps_delay_hours', '2'],
        ['booking_advance_days', '30'],
      ];
      for (const [key, value] of defaults) {
        await client.query(
          `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
          [key, value]
        );
      }
      console.log(`[DB] app_settings padrão inseridos em "${schemaName}"`);
    }

    // push_templates padrão
    const ptCount = await client.query(`SELECT COUNT(*) as n FROM push_templates`);
    if (Number(ptCount.rows[0].n) === 0) {
      const templates = [
        ['✅ Agendamento confirmado', 'Seu agendamento foi confirmado! Te esperamos.', true],
        ['✏️ Agendamento alterado', 'Seu agendamento foi atualizado. Verifique os detalhes.', true],
        ['❌ Agendamento cancelado', 'Seu agendamento foi cancelado. Entre em contato conosco.', true],
        ['💖 Procedimento realizado', 'Obrigada pela visita! Esperamos te ver em breve.', true],
      ];
      for (const [title, body, is_system] of templates) {
        await client.query(
          `INSERT INTO push_templates (title, body, is_system) VALUES ($1, $2, $3)`,
          [title, body, is_system]
        );
      }
      console.log(`[DB] push_templates padrão inseridos em "${schemaName}"`);
    }

    // commemorative_dates padrão
    const cdCount = await client.query(`SELECT COUNT(*) as n FROM commemorative_dates`);
    if (Number(cdCount.rows[0].n) === 0) {
      const dates = [
        ['Dia das Mães', 2, 5, '💐 Feliz Dia das Mães! Aproveite nossas promoções especiais.'],
        ['Dia dos Namorados', 12, 6, '💕 Dia dos Namorados! Presenteie com beleza e cuidado.'],
        ['Natal', 25, 12, '🎄 Feliz Natal! Que seu dia seja cheio de beleza e alegria.'],
        ['Ano Novo', 1, 1, '🥂 Feliz Ano Novo! Que a beleza te acompanhe o ano todo.'],
      ];
      for (const [title, day, month, message] of dates) {
        await client.query(
          `INSERT INTO commemorative_dates (title, day, month, message, is_active)
           VALUES ($1, $2, $3, $4, TRUE)`,
          [title, day, month, message]
        );
      }
      console.log(`[DB] commemorative_dates padrão inseridos em "${schemaName}"`);
    }

    console.log(`[DB] Seeds iniciais concluídos para "${schemaName}"`);
  } finally {
    client.release();
  }
}

// ── Middleware de tenant ───────────────────────────────────────────────────────
// Detecta o tenant pelo hostname e injeta no request
// FASE 1: Funciona em paralelo com o sistema atual (search_path seletivo)
async function tenantMiddleware(req, res, next) {
  const host = req.hostname;

  // Subdomínio dedicado a contratos — tudo público, sem autenticação
  if (host === 'contratos.belleplanner.com.br') {
    return next(); // todas as rotas deste subdomínio são públicas
  }

  // Landing page Belle Planner Pro — não passa pelo tenant
  if (host === 'pro.belleplanner.com.br') {
    return res.sendFile(require('path').join(__dirname, 'public', 'pro.html'));
  }

  // Rotas públicas de contrato — acessíveis em qualquer domínio
  if (req.path.startsWith('/contrato/') || req.path.startsWith('/api/contrato/')) {
    return next(); // serve sem autenticação
  }

  // Rotas do master (painel Erick) — sem tenant
  if (host === 'adminpanel.belleplanner.com.br' || req.path.startsWith('/master')) {
    req.isMaster = true;
    return next();
  }

  try {
    const tenant = await getTenantByHost(host);
    if (tenant) {
      // Tenant suspenso — serve suspended.html EXCETO para /api/config (necessário para branding)
      if (!tenant.active) {
        if (req.path === '/api/config') {
          // Permite /api/config para que suspended.html possa carregar as cores do tenant
          req.tenant     = tenant;
          req.schemaName = tenant.schema_name;
          return next();
        }
        const path = require('path');
        return res.sendFile(path.join(__dirname, 'public', 'suspended.html'));
      }
      req.tenant     = tenant;
      req.schemaName = tenant.schema_name;
    } else if (host !== 'localhost' && host !== '127.0.0.1' && !host.includes('railway.app')) {
      // Domínio não reconhecido — serve página de agenda não encontrada
      // (exceto localhost e railway.app interno que são usados por ferramentas)
      const path = require('path');
      return res.sendFile(path.join(__dirname, 'public', 'not-found.html'));
    }
    // localhost/railway.app sem tenant: opera no schema public (Ana Paula em dev)
  } catch (e) {
    console.error('[Tenant] Erro ao detectar tenant:', e.message);
  }
  next();
}

// Pool query com schema do tenant

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

// Uso futuro (Fase 4): pool.queryTenant(req, sql, params)
pool.queryTenant = async function(req, sql, params) {
  if (req.schemaName) {
    const client = await this.connect();
    try {
      await client.query(`SET search_path TO "${req.schemaName}", public`);
      const result = await client.query(sql, params);
      return result;
    } finally {
      client.release();
    }
  }
  return this.query(sql, params);
};


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
  // ── Pre-migration: rename commemorative_dates.name → title ──────────────────
  // Runs in a separate committed transaction BEFORE the main initDB transaction
  // so that createTenantSchema (which opens its own connection) sees the renamed column
  try {
    const preClient = await pool.connect();
    try {
      await preClient.query(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='commemorative_dates' AND column_name='name'
                   AND table_schema='public') THEN
          ALTER TABLE commemorative_dates RENAME COLUMN name TO title;
        END IF;
      END $$`);
      // Also rename in all tenant schemas
      const { rows: schemas } = await preClient.query(
        `SELECT schema_name FROM tenants WHERE schema_name IS NOT NULL`
      );
      for (const { schema_name } of schemas) {
        try {
          await preClient.query(`DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema='${schema_name}'
                         AND table_name='commemorative_dates' AND column_name='name') THEN
              ALTER TABLE "${schema_name}".commemorative_dates RENAME COLUMN name TO title;
            END IF;
          END $$`);
        } catch {}
      }
    } catch(e) {
      // Ignore if tenants table doesn't exist yet (first run)
      if (!e.message.includes('does not exist')) console.error('[Pre-migration] warn:', e.message);
    } finally { preClient.release(); }
  } catch {}

  // ── Pre-migration: contract columns on tenants table ─────────────────────────
  // Must be committed BEFORE the main BEGIN so that the seed (which runs in a
  // separate pool connection) can see contract_token and contract_status columns
  try {
    const preClient2 = await pool.connect();
    try {
      await preClient2.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contract_status VARCHAR(20) NOT NULL DEFAULT 'accepted'`);
      await preClient2.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contract_token  VARCHAR(64)`);
      await preClient2.query(`CREATE TABLE IF NOT EXISTS contract_acceptances (
        id                SERIAL        PRIMARY KEY,
        tenant_id         INTEGER       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        token             VARCHAR(64)   NOT NULL UNIQUE,
        accepted_privacy  BOOLEAN       NOT NULL DEFAULT FALSE,
        accepted_terms    BOOLEAN       NOT NULL DEFAULT FALSE,
        accepted_contract BOOLEAN       NOT NULL DEFAULT FALSE,
        accepted_at       TIMESTAMPTZ,
        ip_address        VARCHAR(45)   DEFAULT '0.0.0.0',
        version_privacy   VARCHAR(10)   NOT NULL DEFAULT 'v1.0',
        version_terms     VARCHAR(10)   NOT NULL DEFAULT 'v1.0',
        version_contract  VARCHAR(10)   NOT NULL DEFAULT 'v1.0',
        status            VARCHAR(20)   NOT NULL DEFAULT 'pending',
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )`);
    } catch(e) {
      if (!e.message.includes('does not exist')) console.error('[Pre-migration] contract warn:', e.message);
      // ── Seed: tokens e aceites para tenants existentes (idempotente) ────────
      const { rows: noToken } = await preClient2.query(
        `SELECT id, slug, owner_name FROM tenants WHERE contract_token IS NULL`
      );
      for (const t of noToken) {
        const token = require('crypto').randomBytes(32).toString('hex');
        await preClient2.query(
          `UPDATE tenants SET contract_token=$1, contract_status='accepted' WHERE id=$2`, [token, t.id]
        );
        const { rowCount: hasAccept } = await preClient2.query(
          `SELECT 1 FROM contract_acceptances WHERE tenant_id=$1`, [t.id]
        );
        if (!hasAccept) {
          const acceptDate = t.slug === 'bela-essencia'
            ? '2026-04-15T15:37:41Z'
            : '2026-04-25T18:18:37Z';
          await preClient2.query(
            `INSERT INTO contract_acceptances
              (tenant_id,token,accepted_privacy,accepted_terms,accepted_contract,
               accepted_at,ip_address,version_privacy,version_terms,version_contract,status)
             VALUES ($1,$2,TRUE,TRUE,TRUE,$3::timestamptz,'0.0.0.0','v1.0','v1.0','v1.0','accepted')`,
            [t.id, token, acceptDate]
          );
          console.log('[Seed] Aceite contratual criado para tenant:', t.slug);
        }
      }
    } finally { preClient2.release(); }
  } catch {}


  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── MASTER SCHEMA (público — compartilhado entre todos os tenants) ─────────
    // Estas tabelas ficam no schema 'public' e são acessadas por todos

    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id              SERIAL        PRIMARY KEY,
        slug            VARCHAR(50)   UNIQUE NOT NULL,
        name            VARCHAR(100)  NOT NULL,
        owner_name      VARCHAR(100),
        owner_email     VARCHAR(150),
        owner_phone     VARCHAR(30),
        domain_custom   VARCHAR(150),
        subdomain       VARCHAR(80),
        active          BOOLEAN       NOT NULL DEFAULT TRUE,
        plan_id         INTEGER,
        plan_expires_at DATE,
        trial_ends_at   DATE,
        exempt          BOOLEAN       NOT NULL DEFAULT FALSE,
        contract_status VARCHAR(20)   NOT NULL DEFAULT 'accepted', -- 'pending' | 'accepted'
        contract_token  VARCHAR(64)   UNIQUE,
        schema_name     VARCHAR(50)   UNIQUE NOT NULL,
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_configs (
        id                SERIAL        PRIMARY KEY,
        tenant_id         INTEGER       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        primary_color     VARCHAR(7)    NOT NULL DEFAULT '#9b4d6a',
        secondary_color   VARCHAR(7)    NOT NULL DEFAULT '#C49A3C',
        accent_color      VARCHAR(7),
        logo_url          TEXT,
        favicon_url       TEXT,
        business_name     VARCHAR(100)  NOT NULL DEFAULT 'Bela Essência',
        tagline           VARCHAR(200),
        whatsapp_number   VARCHAR(30),
        resend_from_email VARCHAR(150),
        admin_user        VARCHAR(50)   NOT NULL DEFAULT 'admin',
        admin_pass_hash   TEXT,
        timezone          VARCHAR(50)   NOT NULL DEFAULT 'America/Sao_Paulo',
        updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_configs_tenant_id ON tenant_configs(tenant_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id              SERIAL        PRIMARY KEY,
        name            VARCHAR(50)   NOT NULL,
        price           NUMERIC(8,2)  NOT NULL DEFAULT 100.00,
        max_cities      INTEGER       NOT NULL DEFAULT 10,
        max_procedures  INTEGER       NOT NULL DEFAULT 50,
        features        JSONB         NOT NULL DEFAULT '{"push":true,"email":true,"nps":true,"promotions":true}',
        active          BOOLEAN       NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);

    // Tabela: perfil master (Erick)
    await client.query(`
      CREATE TABLE IF NOT EXISTS master_profile (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(100) NOT NULL DEFAULT 'Erick',
        email         VARCHAR(150),
        whatsapp      VARCHAR(30),
        photo_url     TEXT,
        support_msg   VARCHAR(300) DEFAULT 'Entre em contato para renovar sua assinatura.',
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Seed: perfil master inicial
    const mpCheck = await client.query(`SELECT 1 FROM master_profile LIMIT 1`);
    if (!mpCheck.rowCount) {
      await client.query(
        `INSERT INTO master_profile (name, email, whatsapp)
         VALUES ('Erick Torritezi', 'erick.torritezi@gmail.com', '')`
      );
    }

    // Tabela: notas internas por tenant
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_notes (
        id          SERIAL PRIMARY KEY,
        tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        note        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tenant_notes_tenant ON tenant_notes(tenant_id)`);

    // Tabela: onboarding checklist por tenant
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_onboarding (
        tenant_id         INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        acesso_criado     BOOLEAN NOT NULL DEFAULT FALSE,
        dns_configurado   BOOLEAN NOT NULL DEFAULT FALSE,
        procedimentos     BOOLEAN NOT NULL DEFAULT FALSE,
        cidades           BOOLEAN NOT NULL DEFAULT FALSE,
        horarios          BOOLEAN NOT NULL DEFAULT FALSE,
        teste_agendamento BOOLEAN NOT NULL DEFAULT FALSE,
        entregue          BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Reparo startup: garante que todos os tenants têm admin_profile populado
    const { rows: allTenants } = await client.query(
      `SELECT t.id, t.schema_name, t.name, t.owner_email,
              tc.admin_user, tc.admin_pass_hash, tc.business_name
       FROM tenants t LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id`
    );
    for (const t of allTenants) {
      try {
        const tc = await pool.connect();
        try {
          await tc.query(`SET search_path TO "${t.schema_name}", public`);
          const { rows: apRows } = await tc.query(`SELECT COUNT(*) as n FROM admin_profile`);
          if (Number(apRows[0].n) === 0 && t.admin_pass_hash) {
            // Insere admin_profile do zero
            await tc.query(
              `INSERT INTO admin_profile (name, phone, email, login, pass_hash)
               VALUES ($1, '', $2, $3, $4)`,
              [t.business_name || t.name || 'Profissional',
               t.owner_email   || '',
               t.admin_user    || 'admin',
               t.admin_pass_hash]
            );
            console.log(`[DB] admin_profile criado para "${t.schema_name}"`);
          } else if (Number(apRows[0].n) > 0) {
            // Garante que nome e login estão preenchidos
            await tc.query(
              `UPDATE admin_profile SET
                 name  = CASE WHEN name  = '' OR name  IS NULL THEN $1 ELSE name  END,
                 email = CASE WHEN email = '' OR email IS NULL THEN $2 ELSE email END,
                 login = CASE WHEN login = '' OR login IS NULL THEN $3 ELSE login END
               WHERE id IN (SELECT id FROM admin_profile LIMIT 1)`,
              [t.business_name || t.name || 'Profissional',
               t.owner_email   || '',
               t.admin_user    || 'admin']
            );
          }
        } finally { tc.release(); }
      } catch {}
    }

    // Seed: onboarding da Ana Paula como completo
    const ob1 = await client.query(`SELECT 1 FROM tenant_onboarding WHERE tenant_id=(SELECT id FROM tenants WHERE slug='bela-essencia') LIMIT 1`);
    if (!ob1.rowCount) {
      await client.query(
        `INSERT INTO tenant_onboarding (tenant_id,acesso_criado,dns_configurado,procedimentos,cidades,horarios,teste_agendamento,entregue)
         SELECT id,TRUE,TRUE,TRUE,TRUE,TRUE,TRUE,TRUE FROM tenants WHERE slug='bela-essencia'`
      );
    }

    // Tabela: log de push master (histórico de envios para profissionais)
    await client.query(`
      CREATE TABLE IF NOT EXISTS master_push_log (
        id           SERIAL PRIMARY KEY,
        title        VARCHAR(100) NOT NULL,
        body         VARCHAR(300) NOT NULL,
        tenant_ids   INTEGER[] NOT NULL DEFAULT '{}',
        sent_count   INTEGER NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Tabela: pipeline de vendas
    await client.query(`
      CREATE TABLE IF NOT EXISTS sales_pipeline (
        id             SERIAL PRIMARY KEY,
        name           VARCHAR(100) NOT NULL,
        contact        VARCHAR(100),
        city           VARCHAR(100),
        origin         VARCHAR(20) NOT NULL DEFAULT 'online',
        status         VARCHAR(20) NOT NULL DEFAULT 'lead',
        next_action    VARCHAR(200),
        next_action_at DATE,
        notes          TEXT,
        value          NUMERIC(8,2),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pipeline_status ON sales_pipeline(status)`);

    // Tabela: snapshots da agenda diária (gerados à meia-noite, enviados às 06h30)
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_agenda_snapshots (
        id          SERIAL PRIMARY KEY,
        tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        snap_date   DATE NOT NULL,
        snapshot    JSONB NOT NULL,
        sent        BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(tenant_id, snap_date)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_snap_date ON daily_agenda_snapshots(snap_date, sent)`);

    // Seed: plano padrão se ainda não existir
    const planCheck = await client.query("SELECT 1 FROM plans WHERE name='Essencial' LIMIT 1");
    if (!planCheck.rowCount) {
      await client.query(
        `INSERT INTO plans (name, price, max_cities, max_procedures, features)
         VALUES ('Essencial', 100.00, 10, 50, '{"push":true,"email":true,"nps":true,"promotions":true}')`
      );
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id              SERIAL        PRIMARY KEY,
        tenant_id       INTEGER       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        type            VARCHAR(20)   NOT NULL CHECK (type IN ('setup','monthly')),
        amount          NUMERIC(8,2)  NOT NULL,
        status          VARCHAR(20)   NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','pending')),
        reference_month VARCHAR(7),
        paid_at         DATE,
        notes           TEXT,
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS contract_acceptances (
        id                SERIAL        PRIMARY KEY,
        tenant_id         INTEGER       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        token             VARCHAR(64)   NOT NULL UNIQUE,
        accepted_privacy  BOOLEAN       NOT NULL DEFAULT FALSE,
        accepted_terms    BOOLEAN       NOT NULL DEFAULT FALSE,
        accepted_contract BOOLEAN       NOT NULL DEFAULT FALSE,
        accepted_at       TIMESTAMPTZ,
        ip_address        VARCHAR(45)   DEFAULT '0.0.0.0',
        version_privacy   VARCHAR(10)   NOT NULL DEFAULT 'v1.0',
        version_terms     VARCHAR(10)   NOT NULL DEFAULT 'v1.0',
        version_contract  VARCHAR(10)   NOT NULL DEFAULT 'v1.0',
        status            VARCHAR(20)   NOT NULL DEFAULT 'pending',
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id          SERIAL        PRIMARY KEY,
        tenant_id   INTEGER       REFERENCES tenants(id) ON DELETE CASCADE,
        action      VARCHAR(100)  NOT NULL,
        details     TEXT,
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_logs_tenant ON system_logs(tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_logs_created ON system_logs(created_at DESC)`);

    // Seed: registra Ana Paula como tenant_001 se ainda não existir
    const t1Check = await client.query("SELECT 1 FROM tenants WHERE slug='bela-essencia' LIMIT 1");
    if (!t1Check.rowCount) {
      const planRow = await client.query("SELECT id FROM plans WHERE name='Essencial' LIMIT 1");
      const planId  = planRow.rows[0]?.id || 1;
      await client.query(
        `INSERT INTO tenants (slug, name, owner_name, owner_email, domain_custom, subdomain, active, plan_id, schema_name)
         VALUES ('bela-essencia', 'Bela Essência', 'Ana Paula Silva', 'anapaulasilvanac@gmail.com',
                 'belaessencia.app.br', 'belaessencia', TRUE, $1, 'tenant_001')`,
        [planId]
      );
      const t1Row = await client.query("SELECT id FROM tenants WHERE slug='bela-essencia' LIMIT 1");
      await client.query(
        `INSERT INTO tenant_configs (tenant_id, primary_color, secondary_color, business_name, tagline, whatsapp_number, resend_from_email, admin_user)
         VALUES ($1, '#9b4d6a', '#C49A3C', 'Bela Essência', 'Estética & Beleza · Ana Paula Silva', '', 'noreply@belaessencia.app.br', 'admin')`,
        [t1Row.rows[0].id]
      );
      console.log('[DB] tenant_001 (Bela Essência / Ana Paula) registrado no master.');
    }
    // ─────────────────────────────────────────────────────────────────────────

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
      await client.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT FALSE`);

    // Migração: cidades — adiciona uf e neighborhood em public e em todos os schemas de tenant
    await client.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS uf VARCHAR(2)`);
    await client.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS neighborhood VARCHAR(100)`);
    // Migração: admin_profile — adiciona phone e torna pass_hash nullable (se existir)
    await client.query(`ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS phone VARCHAR(30)`);
    await client.query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE`);
    await client.query(`ALTER TABLE commemorative_dates ADD COLUMN IF NOT EXISTS from_day   INTEGER`);
    await client.query(`ALTER TABLE commemorative_dates ADD COLUMN IF NOT EXISTS from_month INTEGER`);
    await client.query(`ALTER TABLE commemorative_dates ADD COLUMN IF NOT EXISTS to_day     INTEGER`);
    await client.query(`ALTER TABLE commemorative_dates ADD COLUMN IF NOT EXISTS to_month   INTEGER`);
    await client.query(`ALTER TABLE procedures ADD COLUMN IF NOT EXISTS description TEXT`);
    await client.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS privacy_consent BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS consent_version VARCHAR(10) NOT NULL DEFAULT 'v1.0'`);
    // Migração: lembrete push 30min antes
    await client.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT FALSE`);
    // Rename commemorative_dates.name → title if still old column
    await client.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='commemorative_dates' AND column_name='name') THEN
        ALTER TABLE commemorative_dates RENAME COLUMN name TO title;
      END IF;
    END $$`);
    // Migration em todos os schemas de tenant existentes
    for (const { schema_name } of (await client.query(`SELECT schema_name FROM tenants WHERE schema_name IS NOT NULL`)).rows) {
      try { await client.query(`ALTER TABLE "${schema_name}".procedures ADD COLUMN IF NOT EXISTS description TEXT`); } catch {}
      try { await client.query(`ALTER TABLE "${schema_name}".appointments ADD COLUMN IF NOT EXISTS privacy_consent BOOLEAN NOT NULL DEFAULT FALSE`); } catch {}
      try { await client.query(`ALTER TABLE "${schema_name}".appointments ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ`); } catch {}
      try { await client.query(`ALTER TABLE "${schema_name}".appointments ADD COLUMN IF NOT EXISTS consent_version VARCHAR(10) NOT NULL DEFAULT 'v1.0'`); } catch {}
      try { await client.query(`ALTER TABLE "${schema_name}".commemorative_dates ADD COLUMN IF NOT EXISTS from_day   INTEGER`); } catch {}
      try { await client.query(`ALTER TABLE "${schema_name}".commemorative_dates ADD COLUMN IF NOT EXISTS from_month INTEGER`); } catch {}
      try { await client.query(`ALTER TABLE "${schema_name}".commemorative_dates ADD COLUMN IF NOT EXISTS to_day     INTEGER`); } catch {}
      try { await client.query(`ALTER TABLE "${schema_name}".commemorative_dates ADD COLUMN IF NOT EXISTS to_month   INTEGER`); } catch {}
      try { await client.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='${schema_name}' AND table_name='commemorative_dates' AND column_name='name') THEN ALTER TABLE "${schema_name}".commemorative_dates RENAME COLUMN name TO title; END IF; END $$`); } catch {}
    }
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at DATE`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS exempt BOOLEAN NOT NULL DEFAULT FALSE`);
    // Tenants existentes sem vencimento → marca como isentos automaticamente
    await client.query(`UPDATE tenants SET exempt=TRUE WHERE plan_expires_at IS NULL AND trial_ends_at IS NULL`);
    // ── Seed: gera token e aceite contratual para tenants existentes ───────────
    const { rows: noTokenTenants } = await client.query(
      `SELECT id, slug, owner_name, name, owner_email, owner_phone FROM tenants WHERE contract_token IS NULL`
    );
    for (const t of noTokenTenants) {
      const token = require('crypto').randomBytes(32).toString('hex');
      await client.query(`UPDATE tenants SET contract_token=$1, contract_status='accepted' WHERE id=$2`, [token, t.id]);
      const acceptDate = t.slug === 'bela-essencia'
        ? '2026-04-15T15:37:41Z'   // Ana Paula — 12:37:41 BRT = 15:37:41 UTC
        : '2026-04-25T18:18:37Z';  // Erick     — 15:18:37 BRT = 18:18:37 UTC
      const { rowCount: already } = await client.query(
        `SELECT 1 FROM contract_acceptances WHERE tenant_id=$1`, [t.id]
      );
      if (!already) {
        await client.query(
          `INSERT INTO contract_acceptances
            (tenant_id, token, accepted_privacy, accepted_terms, accepted_contract,
             accepted_at, ip_address, version_privacy, version_terms, version_contract, status)
           VALUES ($1,$2,TRUE,TRUE,TRUE,$3::timestamptz,'0.0.0.0','v1.0','v1.0','v1.0','accepted')`,
          [t.id, token, acceptDate]
        );
      }
    }
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='admin_profile' AND column_name='pass_hash'
        ) THEN
          ALTER TABLE admin_profile ALTER COLUMN pass_hash DROP NOT NULL;
        END IF;
      END $$
    `);
    // Roda migration em todos os schemas de tenant existentes
    const { rows: schemas } = await client.query(
      `SELECT schema_name FROM tenants WHERE schema_name IS NOT NULL`
    );
    for (const { schema_name } of schemas) {
      try {
        await client.query(`ALTER TABLE "${schema_name}".cities ADD COLUMN IF NOT EXISTS uf VARCHAR(2)`);
        await client.query(`ALTER TABLE "${schema_name}".cities ADD COLUMN IF NOT EXISTS neighborhood VARCHAR(100)`);
        await client.query(`ALTER TABLE "${schema_name}".admin_profile ADD COLUMN IF NOT EXISTS phone VARCHAR(30)`);
        try {
          await client.query(`ALTER TABLE "${schema_name}".admin_profile ALTER COLUMN pass_hash DROP NOT NULL`);
        } catch {}
        // Preenche UF=PR para cidades sem UF (padrão para cidades do Paraná)
        await client.query(
          `UPDATE "${schema_name}".cities SET uf='PR' WHERE (uf IS NULL OR uf='') AND id > 0`
        );
      } catch {}
    }
    // Preenche UF=PR no schema public também
    await client.query(`UPDATE cities SET uf='PR' WHERE (uf IS NULL OR uf='') AND id > 0`);

    // Migração: mensalidade por tenant
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS monthly_fee NUMERIC(8,2) NOT NULL DEFAULT 100.00`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS setup_fee NUMERIC(8,2) NOT NULL DEFAULT 200.00`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contract_status VARCHAR(20) NOT NULL DEFAULT 'accepted'`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contract_token VARCHAR(64)`);
    // Ana Paula: mensalidade 0 (cliente original)
    await client.query(`UPDATE tenants SET monthly_fee=0, setup_fee=0 WHERE slug='bela-essencia' AND monthly_fee=100`);

    // Migração: preenche dados completos da Ana Paula (tenant_001)
    await client.query(`
      UPDATE tenants SET
        owner_name    = 'Ana Paula Silva',
        owner_email   = 'anapaulasilvanac@gmail.com',
        owner_phone   = '',
        domain_custom = 'belaessencia.app.br',
        subdomain     = 'belaessencia',
        plan_expires_at = NULL
      WHERE slug = 'bela-essencia'
        AND (owner_name IS NULL OR owner_name = '')
    `);
    await client.query(`
      UPDATE tenant_configs SET
        tagline           = 'Estética & Beleza · Ana Paula Silva',
        whatsapp_number   = '',
        resend_from_email = 'noreply@belaessencia.app.br',
        admin_user        = 'admin'
      WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'bela-essencia')
        AND (tagline IS NULL OR tagline = '')
    `);

    // Migration: preenche dados completos da Ana Paula
    await client.query(`
      UPDATE tenants SET
        owner_name    = 'Ana Paula Silva',
        owner_email   = 'anapaulasilvanac@gmail.com',
        owner_phone   = '',
        domain_custom = 'belaessencia.app.br',
        subdomain     = 'belaessencia',
        plan_expires_at = NULL
      WHERE slug = 'bela-essencia'
        AND (owner_name IS NULL OR owner_name = '')
    `);
    await client.query(`
      UPDATE tenant_configs SET
        tagline           = 'Estética & Beleza · Ana Paula Silva',
        whatsapp_number   = '',
        resend_from_email = 'noreply@belaessencia.app.br'
      WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'bela-essencia')
        AND (tagline IS NULL OR tagline = '')
    `);

    // Migração: city_ids nas promoções
    await client.query(`ALTER TABLE promotions ADD COLUMN IF NOT EXISTS apply_to_all_cities BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`ALTER TABLE promotions ADD COLUMN IF NOT EXISTS city_ids_promo INTEGER[] NOT NULL DEFAULT '{}'`);

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
        id           SERIAL       PRIMARY KEY,
        name         VARCHAR(100) NOT NULL,
        short        VARCHAR(50),
        local_name   VARCHAR(100),
        address      VARCHAR(200),
        number       VARCHAR(20),
        complement   VARCHAR(100),
        neighborhood VARCHAR(100),
        uf           VARCHAR(2),
        cep          VARCHAR(10),
        maps_url     TEXT,
        is_active    BOOLEAN NOT NULL DEFAULT TRUE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
        tenant_id    INTEGER      REFERENCES tenants(id) ON DELETE CASCADE,
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

    // Fase 1: garante que o schema tenant_001 existe (Ana Paula)
    await createTenantSchema('tenant_001');

    // Fase 4: migra dados da Ana Paula de public → tenant_001 (apenas se vazio)
    await migrateTenantData('tenant_001');

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

// Railway usa proxy reverso — necessário para secure cookies e req.ip correto
app.set('trust proxy', 1);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Tenant middleware — detecta tenant por hostname (Fase 1 White Label)
app.use(tenantMiddleware);

// Cache: schemas que já confirmaram ter dados migrados
const _migratedSchemas = new Set();

async function isSchemaMigrated(schemaName) {
  if (_migratedSchemas.has(schemaName)) return true;
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as cnt FROM "${schemaName}".cities`
    );
    const ok = Number(rows[0].cnt) > 0;
    if (ok) _migratedSchemas.add(schemaName);
    return ok;
  } catch { return false; }
}

// Middleware req.db — roteia queries ao schema correto do tenant
app.use((req, res, next) => {
  if (req.schemaName && !req.isMaster) {
    req.db = async (sql, params) => {
      const client = await pool.connect();
      try {
        // tenant_001 (Ana Paula): usa fallback para public se ainda não migrado
        // Todos os outros tenants: usam sempre o próprio schema (mesmo que vazio)
        let schema = req.schemaName;
        if (req.schemaName === 'tenant_001') {
          const migrated = await isSchemaMigrated('tenant_001');
          if (!migrated) schema = 'public';
        }
        await client.query(`SET search_path TO "${schema}", public`);
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    };
  } else {
    req.db = (sql, params) => pool.query(sql, params);
  }
  next();
});

// Helper: transação com search_path do tenant (evita pool.connect() direto em rotas)
async function tenantTransaction(req, callback) {
  const schema = req.schemaName || 'public';
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Redireciona adminpanel.belleplanner.com.br → /master
app.use((req, res, next) => {
  if (req.hostname === 'adminpanel.belleplanner.com.br' && !req.path.startsWith('/master')) {
    return res.redirect(301, '/master');
  }
  next();
});

// Suprimir warning de MemoryStore em produção (aceitável para 1 instância)
const sessionStore = session.MemoryStore ? new session.MemoryStore() : undefined;

app.use(session({
  secret: SESSION_SEC,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'none', // necessário para cookies cross-domain (adminpanel + belaessencia)
    maxAge: 24 * 60 * 60 * 1000, // 24 horas
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
    await req.db('SELECT 1');
    res.json({ ok: true, version: '2.8.6', db: 'connected' });
  } catch {
    res.status(503).json({ ok: false, db: 'disconnected' });
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { user, pass } = req.body;
  const bcrypt = require('bcryptjs');
  try {
    // Tenta autenticar pelo banco do tenant (pass_hash com bcrypt)
    const { rows } = await req.db(
      'SELECT pass_hash FROM admin_profile WHERE login=$1 LIMIT 1', [user]
    );
    if (rows.length && rows[0].pass_hash) {
      const valid = await bcrypt.compare(pass, rows[0].pass_hash);
      if (valid) {
        req.session.isAdmin = true;
        return res.json({ ok: true });
      } else {
        return res.status(401).json({ error: 'Credenciais inválidas' });
      }
    }
  } catch (e) { console.error('[Auth]', e.message); }
  // Fallback para variáveis de ambiente (Ana Paula / dev)
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
    const { rows } = await req.db(
      'SELECT * FROM procedures WHERE active = TRUE ORDER BY id'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/procedures', requireAdmin, async (req, res) => {
  const { name, dur, price, pt, description } = req.body;
  if (!name || !dur) return res.status(400).json({ error: 'Nome e duração obrigatórios' });
  try {
    const { rows } = await req.db(
      'INSERT INTO procedures (name, dur, price, pt, description) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, parseInt(dur), price || null, pt || 'fixed', description || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/procedures/:id', requireAdmin, async (req, res) => {
  const { name, dur, price, pt, description } = req.body;
  try {
    const { rows } = await req.db(
      'UPDATE procedures SET name=$1, dur=$2, price=$3, pt=$4, description=$5 WHERE id=$6 RETURNING *',
      [name, parseInt(dur), price || null, pt || 'fixed', description || null, req.params.id]
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
    await req.db('UPDATE procedures SET active=FALSE WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agendamentos ──────────────────────────────────────────────────────────────

// Público: criar agendamento
app.post('/api/appointments', async (req, res) => {
  const { cityId, cityName, procId, procName, date, st, et, name, phone, price, pt, privacy_consent } = req.body;
  if (!privacy_consent) {
    return res.status(400).json({ error: 'Consentimento de privacidade é obrigatório.' });
  }
  if (!cityId || !procId || !date || !st || !name || !phone) {
    return res.status(400).json({ error: 'Campos obrigatórios faltando' });
  }

  try {
    const appt = await tenantTransaction(req, async (client) => {
      // Valida que o horário ainda está disponível (anti-race condition)
      const busy = await client.query(
        `SELECT id FROM appointments
         WHERE date = $1 AND status != 'cancelled'
           AND (st, et) OVERLAPS ($2::time, $3::time)
         FOR UPDATE`,
        [date, st, et]
      );
      if (busy.rowCount > 0) {
        throw Object.assign(new Error('Horário não disponível. Por favor, escolha outro.'), { code: 409 });
      }

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const { rows } = await client.query(
        `INSERT INTO appointments
           (id, city_id, city_name, proc_id, proc_name, date, st, et, name, phone, price, pt,
            privacy_consent, consent_at, consent_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [id, cityId, cityName, procId, procName, date, st, et, name, phone, price||null, pt||'fixed',
         true, new Date().toISOString(), 'v1.0']
      );
      return rows[0];
    });

    // Notificação assíncrona — não bloqueia a resposta
    appt._schemaName = req.schemaName; // para isolamento de push por tenant
    notifyAdminNewBooking(appt).catch(e => console.error('[Push] notifyAdminNewBooking:', e.message));
    res.status(201).json(appt);
  } catch (err) {
    const status = err.code === 409 ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Force push re-subscribe (admin) ─────────────────────────────────────────
// Removes all existing subscriptions for this tenant's admins so next page load re-subscribes
app.delete('/api/push/subscribe/admin', requireAdmin, async (req, res) => {
  try {
    const tenantId = (await pool.query(
      `SELECT id FROM tenants WHERE schema_name=$1 LIMIT 1`, [req.schemaName]
    )).rows[0]?.id;
    if (!tenantId) return res.status(404).json({ error: 'Tenant não encontrado' });
    await pool.query(
      `DELETE FROM public.push_subscriptions WHERE tenant_id=$1 AND role='admin'`, [tenantId]
    );
    res.json({ ok: true, message: 'Subscriptions removidas. Recarregue a página para re-inscrever.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Log LGPD — Registro de consentimentos (admin) ───────────────────────────
app.get('/api/lgpd/consents', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  try {
    let sql = `SELECT id, name, phone, date, privacy_consent, consent_at, consent_version
               FROM appointments WHERE privacy_consent=TRUE`;
    const params = [];
    if (from) { params.push(from); sql += ` AND date >= $${params.length}`; }
    if (to)   { params.push(to);   sql += ` AND date <= $${params.length}`; }
    sql += ` ORDER BY consent_at DESC NULLS LAST`;
    const { rows } = await req.db(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Gestão do Contrato do profissional (admin) ───────────────────────────────
app.get('/api/meu-contrato', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT contract_token FROM tenants WHERE schema_name=$1 LIMIT 1`,
      [req.schemaName]
    );
    if (!rows.length || !rows[0].contract_token) {
      return res.status(404).json({ error: 'Contrato não encontrado.' });
    }
    res.json({ token: rows[0].contract_token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Agendamento Retroativo (admin) ───────────────────────────────────────────
// Permite lançar atendimentos já realizados sem restrição de horário de trabalho.
// Única regra: não pode conflitar (OVERLAPS) com agendamentos existentes.
app.post('/api/appointments/retroativo', requireAdmin, async (req, res) => {
  const { cityId, cityName, procId, procName, date, st, et, name, phone, price, pt, status } = req.body;

  if (!cityId || !procId || !date || !st || !et || !name) {
    return res.status(400).json({ error: 'Campos obrigatórios: cidade, procedimento, data, horário e nome do cliente.' });
  }

  // Validate time format
  if (!/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(et)) {
    return res.status(400).json({ error: 'Formato de horário inválido (HH:MM).' });
  }

  try {
    const appt = await tenantTransaction(req, async (client) => {
      // Validação 1: data deve ser um dia de trabalho ou data liberada para a cidade
      const dateObj = new Date(date + 'T12:00:00');
      const dow = dateObj.getUTCDay(); // 0=Dom ... 6=Sáb

      const workDay = await client.query(
        `SELECT is_active FROM work_configs
         WHERE scope='city_day' AND city_id=$1 AND day_of_week=$2 LIMIT 1`,
        [cityId, dow]
      );
      const isWorkDay = workDay.rows[0]?.is_active === true;

      const releasedDay = await client.query(
        `SELECT id FROM released_dates
         WHERE date=$1::date AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))
         LIMIT 1`,
        [date, cityId]
      );
      const isReleasedDay = releasedDay.rowCount > 0;

      if (!isWorkDay && !isReleasedDay) {
        throw Object.assign(
          new Error(`A data ${date} não é um dia de atendimento para esta cidade. Verifique os dias de trabalho ou as datas liberadas.`),
          { code: 422 }
        );
      }

      // Validação 2: conflito com agendamentos existentes
      const { rowCount } = await client.query(
        `SELECT id FROM appointments
         WHERE date = $1 AND status != 'cancelled'
           AND (st, et) OVERLAPS ($2::time, $3::time)
         FOR UPDATE`,
        [date, st, et]
      );
      if (rowCount > 0) {
        throw Object.assign(
          new Error(`Conflito de horário: já existe um agendamento em ${date} entre ${st}–${et}. Escolha outro horário.`),
          { code: 409 }
        );
      }

      const id = 'retro_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const finalStatus = ['realizado','confirmed','cancelled'].includes(status) ? status : 'realizado';

      const { rows } = await client.query(
        `INSERT INTO appointments
           (id, city_id, city_name, proc_id, proc_name, date, st, et, name, phone, price, pt, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [id, cityId, cityName, procId, procName, date, st, et,
         name, phone || null, price || null, pt || 'fixed', finalStatus]
      );
      return rows[0];
    });

    await logAction(null, 'retroativo_created',
      `Ag. retroativo: ${name} · ${date} ${st}–${et} · ${procName}`);

    res.status(201).json(appt);
  } catch (err) {
    const status = err.code === 409 ? 409 : 500;
    res.status(status).json({ error: err.message });
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
  sql += ' ORDER BY date DESC, st DESC';
  try {
    const { rows } = await req.db(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: listar por mês (receita)
app.get('/api/appointments/month/:month', requireAdmin, async (req, res) => {
  // month = "2025-04"
  try {
    const { rows } = await req.db(
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

    const { rows } = await req.db(
      `UPDATE appointments
       SET name=$1, phone=$2, date=$3, st=$4, et=$5,
           city_id=COALESCE($7::integer, city_id),
           city_name=COALESCE($8, city_name),
           proc_id=COALESCE($9::integer, proc_id),
           proc_name=COALESCE($10, proc_name),
           price=${priceVal !== undefined ? '$11::numeric' : 'price'},
           status = CASE
             WHEN status = 'realizado'
               AND ($3::date + $4::time) AT TIME ZONE 'America/Sao_Paulo'
                   > NOW() AT TIME ZONE 'America/Sao_Paulo'
             THEN 'confirmed'
             ELSE status
           END,
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
    // Notifica o profissional também sobre a edição
    edited._schemaName = req.schemaName;
    notifyAdminEdit(edited).catch(e => console.error('[Push] notifyAdminEdit:', e.message));
    res.json(edited);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: restaurar agendamento cancelado → confirmed ou realizado
app.patch('/api/appointments/:id/restore', requireAdmin, async (req, res) => {
  const { status } = req.body; // 'confirmed' | 'realizado'
  if (!['confirmed', 'realizado'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido. Use confirmed ou realizado.' });
  }
  try {
    const { rows } = await req.db(
      `UPDATE appointments SET status=$1, updated_at=NOW() WHERE id=$2 AND status='cancelled' RETURNING *`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agendamento não encontrado ou não está cancelado.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: cancelar agendamento
app.patch('/api/appointments/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const { rows } = await req.db(
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
    const { rowCount } = await req.db(
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
    const { rows } = await req.db('SELECT * FROM blocked_dates ORDER BY date');
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
    const { rows } = await req.db(
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
    await req.db('DELETE FROM blocked_dates WHERE date = $1', [req.params.date]);
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
    // excludeId: exclui o próprio agendamento ao editar (evita conflito de horário)
    const excludeId = req.query.excludeApptId ? Number(req.query.excludeApptId) : null;

    // Fuso Brasil — disponível em todos os branches abaixo
    const nowBRT = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    );
    const todayBRT  = `${nowBRT.getFullYear()}-${String(nowBRT.getMonth()+1).padStart(2,'0')}-${String(nowBRT.getDate()).padStart(2,'0')}`;
    const isToday   = (date === todayBRT);
    const nowMinBRT = isToday ? nowBRT.getHours() * 60 + nowBRT.getMinutes() : 0;

    // 1. Verifica data bloqueada para esta cidade (city_ids vazio = todas)
    const blk = await req.db(
      `SELECT 1 FROM blocked_dates
       WHERE date=$1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))`,
      [date, Number(cityId)]
    );
    if (blk.rowCount > 0) return res.json([]);

    // 2. Exclusividade: outra cidade tem LIBERAÇÃO específica neste dia?
    //    Só released_dates cria exclusividade (profissional comprometida com aquela cidade).
    //    blocked_dates NÃO cria exclusividade — bloquear Assaí não compromete a profissional lá.
    const exclusiveClaim = await req.db(
      `SELECT 1 FROM released_dates
       WHERE date=$1 AND cardinality(city_ids)>0 AND NOT ($2 = ANY(city_ids))
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
      const relDay = await req.db(
        `SELECT * FROM released_dates
         WHERE date=$1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))`,
        [date, Number(cityId)]
      );
      if (!relDay.rowCount) {
        // Tenta released_slots (horários específicos liberados)
        const relSlots = await req.db(
          `SELECT st, et FROM released_slots
           WHERE date=$1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))`,
          [date, Number(cityId)]
        );
        if (!relSlots.rowCount) return res.json([]);
        // Tem slots liberados — verifica procedimento e retorna esses horários
        const pRes2 = await req.db(
          `SELECT p.dur FROM procedures p
           LEFT JOIN city_procedures cp ON cp.proc_id=p.id AND cp.city_id=$2
           WHERE p.id=$1 AND p.active=TRUE AND (cp.enabled IS NULL OR cp.enabled=TRUE)`,
          [procId, cityId]
        );
        if (!pRes2.rowCount) return res.json([]);
        const dur2 = pRes2.rows[0].dur;
        const [aRes2, bkSlots2, excSlots2] = await Promise.all([
          excludeId
            ? req.db(`SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled' AND id!=$2`, [date, excludeId])
            : req.db(`SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled'`, [date]),
          req.db(`SELECT st, et FROM blocked_slots WHERE date=$1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))`, [date, Number(cityId)]),
          req.db(
            `SELECT st, et FROM released_slots
             WHERE date=$1 AND cardinality(city_ids)>0 AND NOT ($2 = ANY(city_ids))`,
            [date, Number(cityId)]
          ),
        ]);
        const busy2 = [...aRes2.rows, ...bkSlots2.rows, ...excSlots2.rows].map(r => ({ s: timeToMin(r.st), e: timeToMin(r.et) }));
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
      const pRes3 = await req.db(
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
      const [aRes3, bkSlots3, excSlots3] = await Promise.all([
        excludeId
          ? req.db(`SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled' AND id!=$2`, [date, excludeId])
          : req.db(`SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled'`, [date]),
        req.db(`SELECT st, et FROM blocked_slots WHERE date=$1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))`, [date, Number(cityId)]),
        req.db(
          `SELECT st, et FROM released_slots
           WHERE date=$1 AND cardinality(city_ids)>0 AND NOT ($2 = ANY(city_ids))`,
          [date, Number(cityId)]
        ),
      ]);
      const busy3 = [...aRes3.rows, ...bkSlots3.rows, ...excSlots3.rows].map(r => ({ s: timeToMin(r.st), e: timeToMin(r.et) }));
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
    const pRes = await req.db(
      `SELECT p.dur FROM procedures p
       LEFT JOIN city_procedures cp ON cp.proc_id=p.id AND cp.city_id=$2
       WHERE p.id=$1 AND p.active=TRUE AND (cp.enabled IS NULL OR cp.enabled=TRUE)`,
      [procId, cityId]
    );
    if (!pRes.rowCount) return res.json([]);
    const dur = pRes.rows[0].dur;

    // Agendamentos e horários bloqueados (exclui o próprio agendamento ao editar)
    // excludeId já declarado no início do try block
    const [aRes, sRes] = await Promise.all([
      excludeId
        ? req.db(`SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled' AND id!=$2`, [date, excludeId])
        : req.db(`SELECT st, et FROM appointments WHERE date=$1 AND status!='cancelled'`, [date]),
      // Horários bloqueados para esta cidade (ou todas)
      req.db(
        `SELECT st, et FROM blocked_slots
         WHERE date=$1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))`,
        [date, Number(cityId)]
      ),
    ]);
    // Horários exclusivos de OUTRAS cidades via released_slots
    // (só liberação cria exclusividade — bloquear não compromete a profissional lá)
    const excSlots = await req.db(
      `SELECT st, et FROM released_slots
       WHERE date=$1 AND cardinality(city_ids)>0 AND NOT ($2 = ANY(city_ids))`,
      [date, Number(cityId)]
    );
    const busy = [...aRes.rows, ...sRes.rows, ...excSlots.rows].map(r => ({
      s: timeToMin(r.st), e: timeToMin(r.et),
    }));

    // Horário atual em Brasília para filtrar slots passados no dia de hoje
    // nowBRT, todayBRT, isToday, nowMinBRT declarados no início do try block

    // Horários liberados para esta cidade (override de blocked_slots)
    const relRes = await req.db(
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
    // Se passar ?month=YYYY-MM, usa esse mês para o card "Este Mês"
    const filterMonth = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)
      ? req.query.month : month;

    const q = (sql, p) => req.db(sql, p).then(r => r.rows[0]);
    const [todayRow, weekRow, monthRow, yearRow] = await Promise.all([
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE date=$1 AND status IN ('confirmed','realizado')`, [today]),
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE date>=$1 AND date<=$2 AND status IN ('confirmed','realizado')`, [ws, we]),
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE to_char(date,'YYYY-MM')=$1 AND status IN ('confirmed','realizado')`, [filterMonth]),
      q(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as cnt FROM appointments WHERE to_char(date,'YYYY')=$1 AND status IN ('confirmed','realizado')`, [year]),
    ]);
    res.json({ today: todayRow, week: weekRow, month: monthRow, year: yearRow, filterMonth });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cockpit: resumo mês a mês por ano ────────────────────────────────────────
app.get('/api/revenue/cockpit', requireAdmin, async (req, res) => {
  await autoCompleteAppointments();
  const year = req.query.year || yearBrasilia();
  try {
    // Meses com dados no ano solicitado
    const { rows } = await req.db(
      `SELECT
         to_char(date,'MM') as month_num,
         to_char(date,'YYYY-MM') as ym,
         COALESCE(SUM(price),0)::numeric as total,
         COUNT(*) as cnt
       FROM appointments
       WHERE to_char(date,'YYYY')=$1 AND status IN ('confirmed','realizado')
       GROUP BY month_num, ym
       ORDER BY ym`,
      [year]
    );
    // Anos disponíveis (para o seletor)
    const { rows: years } = await req.db(
      `SELECT DISTINCT to_char(date,'YYYY') as yr
       FROM appointments WHERE status IN ('confirmed','realizado')
       ORDER BY yr`
    );
    res.json({ year, months: rows, available_years: years.map(r => r.yr) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Cockpit: detalhes de 1 mês específico ────────────────────────────────────
app.get('/api/revenue/cockpit/month', requireAdmin, async (req, res) => {
  const { month } = req.query; // YYYY-MM
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Parâmetro month obrigatório (YYYY-MM)' });
  }
  await autoCompleteAppointments();
  try {
    const q = (sql, p) => req.db(sql, p).then(r => r.rows);
    const q1 = (sql, p) => req.db(sql, p).then(r => r.rows[0]);

    // Totais do mês
    const totals = await q1(
      `SELECT COALESCE(SUM(price),0)::numeric as total, COUNT(*) as cnt
       FROM appointments
       WHERE to_char(date,'YYYY-MM')=$1 AND status IN ('confirmed','realizado')`,
      [month]
    );

    // Agendamentos por procedimento
    const byProc = await q(
      `SELECT proc_name, COUNT(*) as cnt, COALESCE(SUM(price),0)::numeric as total
       FROM appointments
       WHERE to_char(date,'YYYY-MM')=$1 AND status IN ('confirmed','realizado')
       GROUP BY proc_name ORDER BY cnt DESC, total DESC`,
      [month]
    );

    // Ticket médio
    const avg = totals.cnt > 0
      ? (Number(totals.total) / Number(totals.cnt))
      : 0;

    res.json({
      month,
      total:   Number(totals.total),
      cnt:     Number(totals.cnt),
      avg_ticket: avg,
      by_procedure: byProc.map(r => ({
        name:  r.proc_name,
        cnt:   Number(r.cnt),
        total: Number(r.total),
      })),
      top3: byProc.slice(0, 3).map(r => ({
        name:  r.proc_name,
        cnt:   Number(r.cnt),
        total: Number(r.total),
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Master: reset push subscriptions de um tenant ───────────────────────────
app.delete('/master/api/push/reset/:tenantId', requireMaster, async (req, res) => {
  const { tenantId } = req.params;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM public.push_subscriptions WHERE tenant_id=$1`, [tenantId]
    );
    await logAction(tenantId, 'push_reset', `Push subscriptions removidas: ${rowCount}`);
    res.json({ ok: true, removed: rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Aceite Contratual — página pública ───────────────────────────────────────
// Serve a página HTML de aceite (handled by static file + token route below)
app.get('/contrato/aceite/:token', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'contrato-aceite.html'));
});

// Dados do tenant para a página de aceite (sem autenticação — público por token)
app.get('/api/contrato/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.owner_name, t.name, t.owner_email, t.owner_phone,
              t.contract_status, tc.business_name, t.plan_expires_at, t.monthly_fee, t.setup_fee,
              ca.status as acceptance_status, ca.accepted_at
       FROM tenants t
       LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
       LEFT JOIN contract_acceptances ca ON ca.tenant_id=t.id
       WHERE t.contract_token=$1 LIMIT 1`,
      [token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Link inválido ou expirado.' });
    const t = rows[0];
    res.json({
      name:            t.owner_name || t.business_name || t.name,
      business_name:   t.business_name || t.name,
      email:           t.owner_email,
      phone:           t.owner_phone,
      plan_expires_at: t.plan_expires_at,
      monthly_fee:     t.monthly_fee,
      setup_fee:       t.setup_fee,
      already_accepted: t.acceptance_status === 'accepted',
      accepted_at:     t.accepted_at,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Salva aceite e ativa o tenant
app.post('/api/contrato/:token/aceitar', async (req, res) => {
  const { token } = req.params;
  const { accepted_privacy, accepted_terms, accepted_contract } = req.body;

  if (!accepted_privacy || !accepted_terms || !accepted_contract) {
    return res.status(400).json({ error: 'Todos os três documentos devem ser aceitos.' });
  }
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
           || req.socket?.remoteAddress
           || '0.0.0.0';
  try {
    const { rows: tRows } = await pool.query(
      `SELECT id, contract_status FROM tenants WHERE contract_token=$1 LIMIT 1`, [token]
    );
    if (!tRows.length) return res.status(404).json({ error: 'Link inválido.' });
    const tenant = tRows[0];
    if (tenant.contract_status === 'accepted') {
      return res.json({ ok: true, already: true, message: 'Documentos já aceitos anteriormente.' });
    }

    // Salva o aceite
    await pool.query(
      `INSERT INTO contract_acceptances
        (tenant_id, token, accepted_privacy, accepted_terms, accepted_contract,
         accepted_at, ip_address, status)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6,'accepted')
       ON CONFLICT (token) DO UPDATE SET
         accepted_privacy=$3, accepted_terms=$4, accepted_contract=$5,
         accepted_at=NOW(), ip_address=$6, status='accepted'`,
      [tenant.id, token, true, true, true, ip]
    );

    // Ativa o tenant automaticamente
    await pool.query(
      `UPDATE tenants SET active=TRUE, contract_status='accepted' WHERE id=$1`, [tenant.id]
    );

    await logAction(tenant.id, 'contract_accepted', `Aceite contratual registrado — IP: ${ip}`);
    res.json({ ok: true, message: 'Aceite registrado com sucesso. Sua agenda foi ativada.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Gestão de Contratos Master ────────────────────────────────────────────────
app.get('/master/api/contracts', requireMaster, async (req, res) => {
  const { status, from, to } = req.query;
  try {
    let sql = `SELECT
                t.id, t.slug, t.name, t.owner_name, t.owner_email, t.owner_phone,
                t.active, t.contract_status, t.contract_token,
                t.monthly_fee, t.setup_fee, t.created_at,
                tc.business_name,
                ca.accepted_at, ca.ip_address,
                ca.status         AS accept_status,
                ca.accepted_privacy, ca.accepted_terms, ca.accepted_contract,
                ca.version_privacy, ca.version_terms, ca.version_contract,
                ca.token          AS accept_token
              FROM tenants t
              LEFT JOIN tenant_configs        tc ON tc.tenant_id = t.id
              LEFT JOIN contract_acceptances  ca ON ca.tenant_id = t.id
              WHERE 1=1`;
    const params = [];
    if (status === 'active')   { params.push(true);  sql += ` AND t.active=$${params.length}`; }
    if (status === 'inactive') { params.push(false); sql += ` AND t.active=$${params.length}`; }
    if (status === 'pending')  { sql += ` AND t.contract_status='pending'`; }
    if (from) { params.push(from); sql += ` AND ca.accepted_at >= $${params.length}::date`; }
    if (to)   { params.push(to);   sql += ` AND ca.accepted_at <= $${params.length}::date + interval '1 day'`; }
    sql += ` ORDER BY t.created_at DESC`;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Re-envia e-mail de aceite para tenant pendente
app.post('/master/api/contracts/:tenantId/resend-email', requireMaster, async (req, res) => {
  const { tenantId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT t.*, tc.business_name FROM tenants t
       LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
       WHERE t.id=$1 LIMIT 1`, [tenantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant não encontrado' });
    const t = rows[0];
    const baseUrl = process.env.CONTRACT_BASE_URL || 'https://contratos.belleplanner.com.br';
    const acceptUrl = `${baseUrl}/contrato/aceite/${t.contract_token}`;
    await sendEmail({
      to: t.owner_email,
      subject: 'Belle Planner — Lembrete: aceite necessário para ativação da sua agenda',
      html: `<p>Olá, <strong>${t.owner_name||t.name}</strong>.<br><br>
             Seu link de aceite contratual:<br><br>
             <a href="${acceptUrl}" style="background:#9b4d6a;color:white;padding:12px 28px;border-radius:24px;text-decoration:none;font-weight:700">
               LER E ACEITAR DOCUMENTOS
             </a><br><br>Equipe Belle Planner</p>`,
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Log LGPD Master — Todos os tenants ──────────────────────────────────────
app.get('/master/api/lgpd/consents', requireMaster, async (req, res) => {
  const { tenant_id, from, to } = req.query;
  try {
    // Busca tenants para montar query em cada schema
    let tenantQuery = 'SELECT id, name, schema_name FROM tenants WHERE active=TRUE';
    const tParams = [];
    if (tenant_id) { tParams.push(tenant_id); tenantQuery += ` AND id=$1`; }
    const { rows: tenants } = await pool.query(tenantQuery, tParams);

    const allRows = [];
    for (const t of tenants) {
      try {
        const client = await pool.connect();
        try {
          await client.query(`SET search_path TO "${t.schema_name}", public`);
          let sql = `SELECT id, name, phone, date, privacy_consent, consent_at, consent_version FROM appointments WHERE privacy_consent=TRUE`;
          const params = [];
          if (from) { params.push(from); sql += ` AND date >= $${params.length}`; }
          if (to)   { params.push(to);   sql += ` AND date <= $${params.length}`; }
          const { rows } = await client.query(sql, params);
          rows.forEach(r => allRows.push({ ...r, tenant_id: t.id, tenant_name: t.name }));
        } finally { client.release(); }
      } catch {}
    }
    allRows.sort((a, b) => new Date(b.consent_at||0) - new Date(a.consent_at||0));
    res.json(allRows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Promoções ────────────────────────────────────────────────────────────────

// Público: retorna promoção ativa agora (se existir)
app.get('/api/promotions/active', async (req, res) => {
  try {
    const today  = todayBrasilia();
    const cityId = req.query.cityId ? Number(req.query.cityId) : null;
    let query = `SELECT * FROM promotions
       WHERE active = TRUE AND start_date <= $1 AND end_date >= $1`;
    const params = [today];
    // Filter by city if provided: apply_to_all_cities=true OR cityId in city_ids_promo
    if (cityId) {
      query += ` AND (apply_to_all_cities = TRUE OR $2 = ANY(city_ids_promo))`;
      params.push(cityId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1`;
    const { rows } = await req.db(query, params);
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: listar todas
app.get('/api/promotions', requireAdmin, async (req, res) => {
  try {
    const { rows } = await req.db(
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
  const allCities = req.body.apply_to_all_cities !== false;
  const cityIds   = allCities ? [] : (Array.isArray(req.body.city_ids_promo) ? req.body.city_ids_promo.map(Number) : []);
  if (!allCities && cityIds.length === 0) {
    return res.status(400).json({ error: 'Selecione ao menos uma cidade' });
  }
  try {
    const { rows } = await req.db(
      `INSERT INTO promotions (name, start_date, end_date, discount, apply_to_all, proc_ids, apply_to_all_cities, city_ids_promo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, start_date, end_date, Number(discount), allProcs, ids, allCities, cityIds]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: desativar promoção (soft delete)
app.patch('/api/promotions/:id/deactivate', requireAdmin, async (req, res) => {
  try {
    await req.db('UPDATE promotions SET active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: excluir promoção definitivamente (hard delete)
app.delete('/api/promotions/:id', requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await req.db('DELETE FROM promotions WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Promoção não encontrada' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Horários Bloqueados (blocked_slots) ──────────────────────────────────────
app.get('/api/blocked-slots', async (req, res) => {
  try {
    const { rows } = await req.db(
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
    const { rows } = await req.db(
      'INSERT INTO blocked_slots (date, st, et, reason, city_ids) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [date, st, et, reason || null, ids]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/blocked-slots/:id', requireAdmin, async (req, res) => {
  try {
    await req.db('DELETE FROM blocked_slots WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Backup / Export (admin, desktop only) ────────────────────────────────────
app.get('/api/backup/export', requireAdmin, async (req, res) => {
  try {
    const [procs, appts, blocked, slots, promos] = await Promise.all([
      req.db('SELECT * FROM procedures ORDER BY id'),
      req.db('SELECT * FROM appointments ORDER BY date, st'),
      req.db('SELECT * FROM blocked_dates ORDER BY date'),
      req.db('SELECT * FROM blocked_slots ORDER BY date, st'),
      req.db('SELECT * FROM promotions ORDER BY start_date DESC'),
    ]);
    const today = todayBrasilia();
    res.setHeader('Content-Disposition', `attachment; filename="bela-essencia-backup-${today}.json"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({
      exportedAt: new Date().toISOString(),
      version: '2.8.6',
      procedures:    procs.rows,
      appointments:  appts.rows,
      blocked_dates: blocked.rows,
      blocked_slots: slots.rows,
      promotions:    promos.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Cidades ──────────────────────────────────────────────────────────────────
// ── Todas as cidades ativas (para Agenda Retroativa — sem filtro de agenda) ──
app.get('/api/cities/all', requireAdmin, async (req, res) => {
  try {
    const { rows } = await req.db('SELECT * FROM cities WHERE is_active=TRUE ORDER BY name');
    for (const city of rows) {
      const pr = await req.db(
        `SELECT p.id, p.name, p.dur, p.price, p.pt
         FROM procedures p
         LEFT JOIN city_procedures cp ON cp.proc_id=p.id AND cp.city_id=$1
         WHERE p.active=TRUE
           AND (cp.enabled IS NULL OR cp.enabled=TRUE)
         ORDER BY p.name`, [city.id]
      );
      city.procedures = pr.rows;
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cities', async (req, res) => {
  try {
    const { rows } = await req.db(
      'SELECT * FROM cities WHERE is_active=TRUE ORDER BY id'
    );
    for (const city of rows) {
      // Check if this city has ANY city_procedures rows
      const cpCount = await req.db(
        'SELECT COUNT(*) FROM city_procedures WHERE city_id=$1', [city.id]
      );
      const hasOverrides = parseInt(cpCount.rows[0].count) > 0;

      const pr = await req.db(
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
      const wd = await req.db(
        `SELECT day_of_week, is_active FROM work_configs
         WHERE scope='city_day' AND city_id=$1 ORDER BY day_of_week`,
        [city.id]
      );
      city.activeDays = wd.rows.filter(r=>r.is_active).map(r=>r.day_of_week);

      // Datas específicas futuras liberadas para esta cidade
      const today = todayBrasilia();
      const rd = await req.db(
        `SELECT date::text, work_start::text, work_end::text
         FROM released_dates
         WHERE date >= $1 AND (cardinality(city_ids)=0 OR $2=ANY(city_ids))
         ORDER BY date`,
        [today, city.id]
      );
      city.specificDates = rd.rows.map(r => r.date.slice(0,10));
      city.specificDateConfigs = rd.rows; // inclui horários para uso no motor
    }

    // Filtra cidades sem dias ativos E sem datas futuras específicas
    const filtered = rows.filter(c =>
      c.activeDays.length > 0 || c.specificDates.length > 0
    );
    res.json(filtered);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cities/all', requireAdmin, async (req, res) => {
  try {
    const { rows } = await req.db('SELECT * FROM cities ORDER BY id');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: get city with ALL procedures (enabled + disabled) for editing
app.get('/api/cities/:id/procedures', requireAdmin, async (req, res) => {
  try {
    const cityId = req.params.id;
    // Check if this city has any proc overrides at all
    const { rowCount } = await req.db(
      'SELECT 1 FROM city_procedures WHERE city_id=$1 LIMIT 1', [cityId]
    );
    const hasOverrides = rowCount > 0;
    const { rows } = await req.db(
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
    const { rows } = await req.db(
      `INSERT INTO cities (name,uf,local_name,address,number,complement,neighborhood,cep,maps_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name,uf,local_name,address,number,complement||'',neighborhood,cep,mapsUrl]
    );
    const city = rows[0];
    // Seed default schedule (all days disabled)
    const procs = await req.db('SELECT id FROM procedures WHERE active=TRUE');
    for (let d=0; d<=6; d++) {
      await req.db(
        `INSERT INTO work_configs (scope,city_id,day_of_week,is_active,work_start,work_end)
         VALUES ('city_day',$1,$2,FALSE,NULL,NULL)`,
        [city.id, d]
      );
    }
    // Insert procedure overrides (all enabled by default unless specified)
    if (proc_ids && proc_ids.length) {
      for (const p of procs.rows) {
        await req.db(
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
    const { rows } = await req.db(
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
      await req.db('DELETE FROM city_procedures WHERE city_id=$1', [req.params.id]);
      for (const [procId, enabled] of Object.entries(proc_overrides)) {
        await req.db(
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
    const { rows } = await req.db('SELECT is_active FROM cities WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Cidade não encontrada' });
    if (rows[0].is_active) return res.status(400).json({ error: 'Desative a cidade antes de excluir' });
    await req.db('DELETE FROM cities WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Work Configs ──────────────────────────────────────────────────────────────
app.get('/api/work-configs', requireAdmin, async (req, res) => {
  try {
    const { rows } = await req.db(
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
    await req.db(
      `UPDATE work_configs SET is_active=$1, work_start=$2, work_end=$3 WHERE id=$4`,
      [is_active, is_active ? work_start : null, is_active ? work_end : null, req.params.id]
    );
    if (breaks !== undefined) {
      await req.db('DELETE FROM work_breaks WHERE config_id=$1', [req.params.id]);
      if (breaks && breaks.length) {
        for (const b of breaks) {
          await req.db(
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
    const { rows } = await req.db(
      'SELECT name, phone, email FROM admin_profile LIMIT 1'
    );
    const fallbackName = req.tenant?.business_name || 'Profissional';
    res.json(rows[0] || { name: fallbackName, phone: '', email: '' });
  } catch (err) {
    // Fallback gracioso mesmo com erro de DB
    const fallbackName = req.tenant?.business_name || 'Profissional';
    res.json({ name: fallbackName, phone: '', email: '' });
  }
});

app.get('/api/admin/profile', requireAdmin, async (req, res) => {
  try {
    const { rows } = await req.db(
      'SELECT id, name, phone, email, login FROM admin_profile LIMIT 1'
    );
    res.json(rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/profile', requireAdmin, async (req, res) => {
  const { name, phone, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Nome e e-mail são obrigatórios' });
  // phone is optional
  try {
    // Check if profile exists
    const { rows: existing } = await req.db(
      'SELECT id FROM admin_profile LIMIT 1'
    );
    if (existing.length > 0) {
      await req.db(
        `UPDATE admin_profile SET name=$1, phone=$2, email=$3 WHERE id=$4`,
        [name, phone || '', email, existing[0].id]
      );
    } else {
      // Profile doesn't exist — insert with pass_hash from tenant_configs
      const login = req.body.login || 'admin';
      // Get pass_hash from tenant_configs as fallback for NOT NULL constraint
      let existingHash = null;
      try {
        const { rows: tcRows } = await pool.query(
          `SELECT tc.admin_pass_hash FROM tenant_configs tc
           JOIN tenants t ON t.id = tc.tenant_id
           WHERE t.schema_name = $1 LIMIT 1`,
          [req.schemaName || 'public']
        );
        existingHash = tcRows[0]?.admin_pass_hash || null;
      } catch {}
      await req.db(
        `INSERT INTO admin_profile (name, phone, email, login, pass_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [name, phone || '', email, login, existingHash]
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Alterar login do admin (pelo próprio profissional) ───────────────────────
app.put('/api/admin/login', requireAdmin, async (req, res) => {
  const { new_login } = req.body;
  if (!new_login || new_login.trim().length < 3)
    return res.status(400).json({ error: 'Login mínimo de 3 caracteres' });
  if (!/^[a-zA-Z0-9._-]+$/.test(new_login.trim()))
    return res.status(400).json({ error: 'Use letras, números, . _ -' });
  try {
    await req.db(`UPDATE admin_profile SET login=$1 WHERE id IN (SELECT id FROM admin_profile LIMIT 1)`, [new_login.trim()]);
    await pool.query(`UPDATE tenant_configs SET admin_user=$1 WHERE tenant_id=(SELECT id FROM tenants WHERE schema_name=$2 LIMIT 1)`, [new_login.trim(), req.schemaName]);
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
    const { rows } = await req.db('SELECT pass_hash FROM admin_profile LIMIT 1');
    const stored = rows.length ? rows[0].pass_hash : (process.env.ADMIN_PASS || '');
    const bcrypt = require('bcryptjs');
    const validCurrent = rows.length && rows[0].pass_hash
      ? await bcrypt.compare(current, rows[0].pass_hash)
      : (current === stored);
    if (!validCurrent) return res.status(401).json({ error: 'Senha atual incorreta' });
    const newHash = await bcrypt.hash(newPass, 10);
    await req.db(`UPDATE admin_profile SET pass_hash=$1 WHERE id IN (SELECT id FROM admin_profile LIMIT 1)`, [newHash]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Datas Comemorativas ───────────────────────────────────────────────────────
app.get('/api/commemorative', async (req, res) => {
  try {
    const now = nowBrasilia();
    const d = now.getDate();
    const m = now.getMonth() + 1;
    const y = now.getFullYear();
    // Converte data atual em número de dia-do-ano para comparação de período
    // (suporta períodos que cruzam virada de mês mas não de ano)
    const toNum = (dy, mo) => mo * 100 + dy; // ex: 502 = 2 de maio
    const todayNum = toNum(d, m);

    const { rows } = await req.db(
      `SELECT * FROM commemorative_dates
       WHERE is_active=TRUE
         AND (
           -- Sem período: exibe apenas no dia exato
           (from_day IS NULL AND day=$1 AND month=$2)
           OR
           -- Com período: exibe se hoje está entre from e to
           (from_day IS NOT NULL AND to_day IS NOT NULL)
         )
       ORDER BY
         -- Prefere a que tem período (mais específica)
         (CASE WHEN from_day IS NOT NULL THEN 0 ELSE 1 END)
       LIMIT 5`,
      [d, m]
    );
    // Filtra em JS para período cruzando virada de mês
    const match = rows.find(r => {
      if (r.from_day == null) return true; // dia exato já verificado no SQL
      const fromNum = toNum(r.from_day, r.from_month);
      const toNum2  = toNum(r.to_day,   r.to_month);
      if (fromNum <= toNum2) {
        // Período normal: ex: 02/05 ao 10/05
        return todayNum >= fromNum && todayNum <= toNum2;
      } else {
        // Período vira ano: ex: 28/12 ao 05/01
        return todayNum >= fromNum || todayNum <= toNum2;
      }
    });
    res.json(match || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/commemorative/all', requireAdmin, async (req, res) => {
  try {
    const { rows } = await req.db('SELECT * FROM commemorative_dates ORDER BY month,day');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/commemorative', requireAdmin, async (req, res) => {
  const { day, month, title, message, from_day, from_month, to_day, to_month } = req.body;
  if (!day||!month||!title||!message) return res.status(400).json({ error: 'Todos os campos obrigatórios' });
  if (message.length > 300) return res.status(400).json({ error: 'Mensagem máximo 300 caracteres' });
  // Validação: se tem from, precisa ter to e vice-versa
  const hasPeriod = from_day || to_day;
  if (hasPeriod && (!from_day||!from_month||!to_day||!to_month)) {
    return res.status(400).json({ error: 'Preencha início e fim do período de veiculação' });
  }
  try {
    const { rows } = await req.db(
      `INSERT INTO commemorative_dates (day,month,title,message,from_day,from_month,to_day,to_month)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [day, month, title, message,
       from_day||null, from_month||null, to_day||null, to_month||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/commemorative/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const { rows } = await req.db(
      'UPDATE commemorative_dates SET is_active=NOT is_active WHERE id=$1 RETURNING is_active', [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/commemorative/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await req.db('SELECT is_active FROM commemorative_dates WHERE id=$1',[req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Data não encontrada' });
    if (rows[0].is_active) return res.status(400).json({ error: 'Cancele a data antes de excluir' });
    await req.db('DELETE FROM commemorative_dates WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// MASTER PANEL — Belle Planner (Erick only)
// ══════════════════════════════════════════════════════════════════════════════

const MASTER_PASS       = process.env.MASTER_PASS || 'belleplanner@master2026';
const MASTER_FROM_EMAIL = process.env.MASTER_FROM_EMAIL || 'noreply@belleplanner.com.br';

function requireMaster(req, res, next) {
  // Check session (primary)
  if (req.session?.isMaster) return next();
  // Check Authorization header as fallback (for cross-domain issues)
  const auth = req.headers['x-master-token'];
  if (auth && auth === process.env.MASTER_PASS) return next();
  return res.status(401).json({ error: 'Não autorizado' });
}

async function logAction(tenantId, action, details) {
  try {
    await pool.query(
      `INSERT INTO system_logs (tenant_id, action, details) VALUES ($1,$2,$3)`,
      [tenantId || null, action, details || null]
    );
  } catch {}
}

// Master login
app.post('/master/login', (req, res) => {
  const { pass } = req.body;
  if (pass === MASTER_PASS) {
    req.session.isMaster = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Senha incorreta' });
  }
});

app.post('/master/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ── Dashboard stats ─────────────────────────────────────────────────────────
app.get('/master/api/stats', requireMaster, async (req, res) => {
  try {
    const today = todayBrasilia();
    const month = monthBrasilia();

    const [tenantsRes, paymentsRes, expiringRes, blockedRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total,
        SUM(CASE WHEN active=TRUE THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN active=FALSE THEN 1 ELSE 0 END) as inactive,
        COALESCE(SUM(CASE WHEN active=TRUE THEN monthly_fee ELSE 0 END),0) as mrr
        FROM tenants`),
      pool.query(`SELECT
        COALESCE(SUM(CASE WHEN type='setup' AND status='paid' THEN amount END),0) as setup_total,
        COALESCE(SUM(CASE WHEN status='paid' THEN amount END),0) as total_revenue
        FROM payments`),
      pool.query(`SELECT COUNT(*) as cnt FROM tenants
        WHERE active=TRUE AND plan_expires_at BETWEEN $1 AND ($1::date + interval '7 days')`,
        [today]),
      pool.query(`SELECT COUNT(*) as cnt FROM tenants WHERE active=FALSE AND plan_expires_at < $1`, [today]),
    ]);

    // Monthly revenue chart (last 6 months)
    const { rows: chartRows } = await pool.query(`
      SELECT TO_CHAR(created_at,'YYYY-MM') as month,
             COALESCE(SUM(amount),0) as revenue
      FROM payments WHERE status='paid' AND created_at >= NOW() - interval '6 months'
      GROUP BY month ORDER BY month`);

    // Top tenants by agendamentos (cross-schema count)
    const { rows: tenantList } = await pool.query(
      `SELECT t.id, t.slug, t.name, t.owner_name, t.owner_email,
              t.domain_custom, t.subdomain, t.schema_name, t.active,
              t.plan_expires_at, t.monthly_fee, t.setup_fee,
              tc.business_name, tc.primary_color, tc.secondary_color,
              tc.logo_url, tc.tagline
       FROM tenants t LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
       ORDER BY t.created_at DESC`
    );

    res.json({
      tenants: tenantsRes.rows[0],
      payments: { ...paymentsRes.rows[0], mrr: tenantsRes.rows[0].mrr },
      expiring: Number(expiringRes.rows[0].cnt),
      blocked:  Number(blockedRes.rows[0].cnt),
      chart:    chartRows,
      tenantList,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tenants CRUD ─────────────────────────────────────────────────────────────
app.get('/master/api/tenants', requireMaster, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.slug, t.name, t.owner_name, t.owner_email, t.owner_phone,
             t.domain_custom, t.subdomain, t.active, t.plan_expires_at, t.schema_name,
             t.monthly_fee, t.setup_fee, t.created_at,
             tc.primary_color, tc.secondary_color, tc.business_name,
             tc.tagline, tc.whatsapp_number, tc.resend_from_email, tc.admin_user,
             tc.logo_url,
             (SELECT COUNT(*) FROM payments p WHERE p.tenant_id=t.id AND p.status='paid') as payment_count,
             (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.tenant_id=t.id AND p.status='paid') as total_paid
      FROM tenants t LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
      ORDER BY t.created_at DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/master/api/tenants', requireMaster, async (req, res) => {
  const {
    slug, name, owner_name, owner_email, owner_phone,
    domain_custom, subdomain, plan_expires_at,
    business_name, tagline, primary_color, secondary_color,
    logo_url, whatsapp_number, resend_from_email, admin_user, admin_pass,
    setup_amount
  } = req.body;
  if (!slug || !name || !owner_email) {
    return res.status(400).json({ error: 'slug, name e owner_email são obrigatórios' });
  }
  const bcrypt = require('bcryptjs');
  const schemaName = `tenant_${slug.replace(/[^a-z0-9]/gi,'_')}`;

  // Gera senha automática se não fornecida
  if (!admin_pass || admin_pass.trim().length < 6) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: 'Senha obrigatória — mínimo 6 caracteres' });
  }
  const finalPass = admin_pass.trim();
  const passHash  = await bcrypt.hash(finalPass, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Validação: domínio/subdomínio já em uso?
    const domainCheck = await pool.query(
      `SELECT slug FROM tenants
       WHERE domain_custom = $1 OR subdomain = $2 OR slug = $3`,
      [domain_custom||null, subdomain||null, slug]
    );
    if (domainCheck.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Slug ou domínio já está em uso pelo tenant "${domainCheck.rows[0].slug}"`
      });
    }

    const mFee = req.body.monthly_fee !== undefined ? Number(req.body.monthly_fee) : 100;
    const sFee = req.body.setup_fee    !== undefined ? Number(req.body.setup_fee)    : 200;
    const isExempt = req.body.exempt === true || req.body.exempt === 'true';
    // Gera token único de aceite contratual para este tenant
    const contractToken = require('crypto').randomBytes(32).toString('hex');
    // Novo tenant nasce PENDENTE (active=FALSE) — ativado após aceite dos documentos
    const { rows } = await client.query(
      `INSERT INTO tenants (slug,name,owner_name,owner_email,owner_phone,
        domain_custom,subdomain,active,schema_name,plan_expires_at,trial_ends_at,
        exempt,monthly_fee,setup_fee,contract_status,contract_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8,$9,$10,$11,$12,$13,'pending',$14) RETURNING *`,
      [slug,name,owner_name,owner_email,owner_phone||null,
       domain_custom||null,subdomain||null,schemaName,
       isExempt ? null : (plan_expires_at||null), null,
       isExempt, mFee, sFee, contractToken]
    );
    const tenant = rows[0];
    await client.query(
      `INSERT INTO tenant_configs
        (tenant_id,business_name,tagline,primary_color,secondary_color,
         logo_url,whatsapp_number,resend_from_email,admin_user,admin_pass_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenant.id, business_name||name, tagline||'',
       primary_color||'#9b4d6a', secondary_color||'#C49A3C',
       logo_url||null, whatsapp_number||'', resend_from_email||'',
       admin_user||'admin', passHash]
    );
    // Registra pagamento de setup
    if (setup_amount) {
      await client.query(
        `INSERT INTO payments (tenant_id,type,amount,status,paid_at) VALUES ($1,'setup',$2,'paid',$3)`,
        [tenant.id, Number(setup_amount), todayBrasilia()]
      );
    }
    await client.query('COMMIT');
    // Provisiona schema do tenant
    await createTenantSchema(schemaName);

    // Seeds iniciais com dados da profissional
    await seedTenantData(schemaName, {
      name:     owner_name || business_name || name,
      email:    owner_email || '',
      login:    admin_user  || 'admin',
      passHash: passHash,
      pass: finalPass,
    });

    await logAction(tenant.id, 'tenant_created', `Tenant ${slug} criado por master`);

    // E-mail de aceite contratual (substitui o welcome — tenant está PENDENTE)
    const tenantForEmail = { ...tenant, domain_custom: domain_custom||null, subdomain: subdomain||null };
    const baseUrl = process.env.CONTRACT_BASE_URL || 'https://contratos.belleplanner.com.br';
    const acceptUrl = `${baseUrl}/contrato/aceite/${contractToken}`;
    await sendEmail({
      to: owner_email,
      subject: 'Bem-vindo(a) à Belle Planner — aceite necessário para ativação da sua agenda',
      html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#3d1a2a">
        <div style="background:linear-gradient(135deg,#1f0d18,#4a1528);padding:28px 32px;border-radius:12px 12px 0 0">
          <h1 style="color:white;margin:0;font-size:22px">Belle Planner</h1>
          <p style="color:rgba(255,255,255,.75);margin:6px 0 0;font-size:13px">Sua agenda online</p>
        </div>
        <div style="background:#fff;padding:32px;border:1px solid #e8d0d8;border-top:none;border-radius:0 0 12px 12px">
          <p style="font-size:15px;line-height:1.7">Olá, <strong>${owner_name || name}</strong>.</p>
          <p style="line-height:1.7">Seja bem-vindo(a) à <strong>Belle Planner</strong>.</p>
          <p style="line-height:1.7">Para ativarmos sua agenda online e seguirmos com a configuração do seu espaço digital, é necessário que você leia e aceite os documentos iniciais da plataforma:</p>
          <ul style="line-height:2">
            <li>Política de Privacidade</li>
            <li>Termos de Uso</li>
            <li>Contrato de Prestação de Serviços SaaS</li>
          </ul>
          <div style="text-align:center;margin:28px 0">
            <a href="${acceptUrl}" style="background:#9b4d6a;color:white;padding:14px 36px;border-radius:30px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block">
              LER E ACEITAR DOCUMENTOS
            </a>
          </div>
          <p style="line-height:1.7">Após a confirmação, sua agenda poderá ser ativada e configurada pela Belle Planner.</p>
          <p style="margin-top:28px;color:#666;font-size:13px">Atenciosamente,<br><strong>Equipe Belle Planner</strong></p>
        </div>
      </body></html>`,
    }).catch(e => console.error('[Email] Erro ao enviar aceite:', e.message));

    res.status(201).json({ ...tenant, provisioned: true, generated_pass: finalPass, admin_user: admin_user||'admin' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.put('/master/api/tenants/:id', requireMaster, async (req, res) => {
  const { id } = req.params;
  const { name, owner_name, owner_email, owner_phone, domain_custom, subdomain,
          plan_expires_at, active, business_name, tagline, primary_color,
          secondary_color, logo_url, whatsapp_number, resend_from_email } = req.body;
  try {
    const updMFee = req.body.monthly_fee !== undefined ? Number(req.body.monthly_fee) : null;
    const updSFee = req.body.setup_fee    !== undefined ? Number(req.body.setup_fee)    : null;
    await pool.query(
      `UPDATE tenants SET name=$1,owner_name=$2,owner_email=$3,owner_phone=$4,
         domain_custom=$5,subdomain=$6,plan_expires_at=$7,active=$8,
         monthly_fee=COALESCE($10,monthly_fee),
         setup_fee=COALESCE($11,setup_fee)
       WHERE id=$9`,
      [name,owner_name,owner_email,owner_phone||null,domain_custom||null,
       subdomain||null,plan_expires_at||null,active!==false,id,updMFee,updSFee]
    );
    await pool.query(
      `UPDATE tenant_configs SET business_name=$1,tagline=$2,primary_color=$3,
         secondary_color=$4,logo_url=$5,whatsapp_number=$6,resend_from_email=$7,
         updated_at=NOW() WHERE tenant_id=$8`,
      [business_name,tagline||'',primary_color,secondary_color,
       logo_url||null,whatsapp_number||'',resend_from_email||'',id]
    );
    invalidateTenantCache(domain_custom || subdomain);
    await logAction(id, 'tenant_updated', `Tenant ${id} atualizado`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/master/api/tenants/:id/toggle', requireMaster, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE tenants SET active = NOT active WHERE id=$1 RETURNING active, slug`,
      [req.params.id]
    );
    await logAction(req.params.id, rows[0].active ? 'tenant_enabled' : 'tenant_disabled',
      `Tenant ${rows[0].slug} ${rows[0].active ? 'ativado' : 'suspenso'}`);
    _tenantCache.clear();
    // Envia e-mail de notificação ao owner quando suspenso
    if (!rows[0].active) {
      const { rows: ownerRows } = await pool.query(
        `SELECT owner_email, owner_name, t.name FROM tenants t WHERE t.id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (ownerRows[0]?.owner_email) {
        sendEmail({
          to: ownerRows[0].owner_email,
          subject: 'Belle Planner — Acesso suspenso',
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
            <h2 style="color:#E8557A">Acesso suspenso</h2>
            <p>Olá, <strong>${ownerRows[0].owner_name||ownerRows[0].name}</strong>.</p>
            <p>Sua agenda <strong>${ownerRows[0].name}</strong> foi temporariamente suspensa.</p>
            <p>Para reativar, entre em contato com o suporte Belle Planner.</p>
            <p style="margin-top:20px;font-size:12px;color:#888">Belle Planner · Sua Agenda Online</p>
          </div>`
        }).catch(() => {});
      }
    }
    res.json({ active: rows[0].active });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Pagamentos ───────────────────────────────────────────────────────────────
app.get('/master/api/payments', requireMaster, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*, t.name as tenant_name, t.slug,
             tc.business_name
      FROM payments p
      JOIN tenants t ON t.id=p.tenant_id
      LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
      ORDER BY p.created_at DESC LIMIT 200`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Enviar email de cobrança de um pagamento
app.post('/master/api/payments/:id/send-email', requireMaster, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, t.owner_email, t.owner_name, t.name as tenant_name,
              tc.business_name
       FROM payments p
       JOIN tenants t ON t.id=p.tenant_id
       LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
       WHERE p.id=$1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pagamento não encontrado' });
    const p = rows[0];
    await sendPaymentEmail(p);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Atualizar status de pagamento (pending → paid)
app.patch('/master/api/payments/:id/status', requireMaster, async (req, res) => {
  const { status } = req.body;
  if (!['paid','pending'].includes(status)) return res.status(400).json({ error: 'Status inválido' });
  try {
    const paid_at = status === 'paid' ? todayBrasilia() : null;
    const { rows } = await pool.query(
      `UPDATE payments SET status=$1, paid_at=$2 WHERE id=$3 RETURNING *`,
      [status, paid_at, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pagamento não encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/master/api/payments', requireMaster, async (req, res) => {
  const { tenant_id, type, amount, status, reference_month, paid_at, notes } = req.body;
  if (!tenant_id || !type || !amount) {
    return res.status(400).json({ error: 'tenant_id, type e amount são obrigatórios' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO payments (tenant_id,type,amount,status,reference_month,paid_at,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tenant_id, type, Number(amount), status||'paid',
       reference_month||null, paid_at||todayBrasilia(), notes||null]
    );
    // Se pagamento de mensalidade, reativa tenant se estava bloqueado e atualiza vencimento
    if (type === 'monthly' && status === 'paid') {
      const nextExpiry = new Date(paid_at || todayBrasilia());
      nextExpiry.setMonth(nextExpiry.getMonth() + 1);
      const expiryStr = nextExpiry.toISOString().slice(0,10);
      await pool.query(
        `UPDATE tenants SET active=TRUE, plan_expires_at=$1 WHERE id=$2`,
        [expiryStr, tenant_id]
      );
      _tenantCache.clear();
      await logAction(tenant_id, 'payment_registered', `Mensalidade paga. Novo vencimento: ${expiryStr}`);
    }
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// MASTER PROFILE
// ══════════════════════════════════════════════════════════════════════════════

app.get('/master/api/profile', requireMaster, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM master_profile LIMIT 1`);
    res.json(rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/master/api/profile', requireMaster, async (req, res) => {
  const { name, email, whatsapp, photo_url, support_msg, new_pass } = req.body;
  try {
    await pool.query(
      `UPDATE master_profile SET name=$1, email=$2, whatsapp=$3,
       photo_url=$4, support_msg=$5, updated_at=NOW()`,
      [name, email, whatsapp||'', photo_url||null, support_msg||'']
    );
    // Atualiza senha se fornecida
    if (new_pass && new_pass.trim().length >= 6) {
      process.env.MASTER_PASS = new_pass.trim();
      // Nota: a mudança é em memória; para persistir, atualizar variável no Railway
    }
    await logAction(null, 'profile_updated', 'Perfil master atualizado');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// TENANT NOTES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/master/api/tenants/:id/notes', requireMaster, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM tenant_notes WHERE tenant_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/master/api/tenants/:id/notes', requireMaster, async (req, res) => {
  const { note } = req.body;
  if (!note?.trim()) return res.status(400).json({ error: 'Nota não pode ser vazia' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO tenant_notes (tenant_id, note) VALUES ($1, $2) RETURNING *`,
      [req.params.id, note.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/master/api/notes/:id', requireMaster, async (req, res) => {
  try {
    await pool.query(`DELETE FROM tenant_notes WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ONBOARDING CHECKLIST
// ══════════════════════════════════════════════════════════════════════════════

app.get('/master/api/tenants/:id/onboarding', requireMaster, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM tenant_onboarding WHERE tenant_id=$1`, [req.params.id]
    );
    if (!rows.length) {
      // Cria registro vazio se não existe
      const { rows: nr } = await pool.query(
        `INSERT INTO tenant_onboarding (tenant_id) VALUES ($1) RETURNING *`,
        [req.params.id]
      );
      return res.json(nr[0]);
    }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/master/api/tenants/:id/onboarding', requireMaster, async (req, res) => {
  const { acesso_criado, dns_configurado, procedimentos, cidades,
          horarios, teste_agendamento, entregue } = req.body;
  try {
    await pool.query(
      `INSERT INTO tenant_onboarding
         (tenant_id,acesso_criado,dns_configurado,procedimentos,cidades,horarios,teste_agendamento,entregue,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         acesso_criado=$2, dns_configurado=$3, procedimentos=$4,
         cidades=$5, horarios=$6, teste_agendamento=$7,
         entregue=$8, updated_at=NOW()`,
      [req.params.id, !!acesso_criado, !!dns_configurado, !!procedimentos,
       !!cidades, !!horarios, !!teste_agendamento, !!entregue]
    );

    // Se todos os 7 itens estiverem verdes, gera cobrança de implantação
    const allDone = [acesso_criado, dns_configurado, procedimentos,
                     cidades, horarios, teste_agendamento, entregue].every(Boolean);
    if (allDone) {
      // Isento: não gera cobrança nem trial
      const { rows: exemptCheck } = await pool.query(
        `SELECT exempt FROM tenants WHERE id=$1`, [req.params.id]
      );
      if (exemptCheck[0]?.exempt) {
        return res.json({ ok: true, exempt: true });
      }
      // Só cria se ainda não existe pagamento de setup para este tenant
      const { rows: existing } = await pool.query(
        `SELECT id FROM payments WHERE tenant_id=$1 AND type='setup' LIMIT 1`,
        [req.params.id]
      );
      if (!existing.length) {
        const { rows: payRows } = await pool.query(
          `INSERT INTO payments (tenant_id,type,amount,status,notes)
           VALUES ($1,'setup',247.00,'pending','Gerado automaticamente ao concluir onboarding')
           RETURNING *`,
          [req.params.id]
        );
        // Busca dados do tenant para enviar email
        const { rows: tenantRows } = await pool.query(
          `SELECT t.owner_email, t.owner_name, t.name as tenant_name, tc.business_name
           FROM tenants t
           LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
           WHERE t.id=$1`, [req.params.id]
        );
        if (tenantRows.length) {
          const payData = { ...payRows[0], ...tenantRows[0] };
          sendPaymentEmail(payData).catch(e =>
            console.error('[Onboarding] Erro ao enviar email implantação:', e.message)
          );
        }
        // Seta trial de 7 dias para pagar a implantação
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + 7);
        await pool.query(
          `UPDATE tenants SET trial_ends_at=$1 WHERE id=$2`,
          [trialEnd.toISOString().slice(0,10), req.params.id]
        );
        await logAction(req.params.id, 'setup_payment_created',
          'Cobrança de implantação gerada automaticamente (checklist 100%) — trial 7 dias iniciado');
      }
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// RECEITA PROJETADA
// ══════════════════════════════════════════════════════════════════════════════

app.get('/master/api/revenue/projection', requireMaster, async (req, res) => {
  try {
    const today = todayBrasilia();
    // MRR atual (tenants ativos com mensalidade > 0)
    const { rows: mrrRows } = await pool.query(
      `SELECT COALESCE(SUM(monthly_fee),0) as mrr FROM tenants WHERE active=TRUE AND monthly_fee>0`
    );
    const mrr = Number(mrrRows[0].mrr);

    // Tenants que vencem nos próximos 3 meses (risco de churn)
    const { rows: expRows } = await pool.query(
      `SELECT t.name, t.plan_expires_at, t.monthly_fee, tc.business_name
       FROM tenants t LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
       WHERE t.active=TRUE AND t.monthly_fee>0
         AND t.plan_expires_at BETWEEN $1 AND ($1::date + interval '90 days')
       ORDER BY t.plan_expires_at`,
      [today]
    );

    // Histórico mensal últimos 6 meses
    const { rows: histRows } = await pool.query(
      `SELECT TO_CHAR(created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') as month,
              COALESCE(SUM(amount),0) as revenue,
              COUNT(*) as payments
       FROM payments WHERE status='paid' AND created_at >= NOW() - interval '6 months'
       GROUP BY month ORDER BY month`
    );

    // Projeção 3 meses (MRR × 3, descontando tenants que vencem e não renovam)
    const atRisk = expRows.reduce((s,r) => s + Number(r.monthly_fee), 0);
    const projection = [
      { month: 1, label: 'Mês 1', projected: mrr, at_risk: atRisk },
      { month: 2, label: 'Mês 2', projected: mrr, at_risk: atRisk },
      { month: 3, label: 'Mês 3', projected: mrr, at_risk: atRisk },
    ];

    res.json({ mrr, at_risk: atRisk, expiring: expRows, history: histRows, projection });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// PUSH PARA PROFISSIONAIS (MASTER → ADMINS DOS TENANTS)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/master/api/push/send', requireMaster, async (req, res) => {
  const { title, body, tenant_ids } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Título e mensagem obrigatórios' });
  if (!PUSH_ENABLED()) return res.status(503).json({ error: 'Push não configurado no servidor.' });

  const results = [];
  let sentCount = 0;
  try {
    let tenants;
    if (!tenant_ids || !tenant_ids.length) {
      const { rows } = await pool.query(`SELECT id, name FROM tenants WHERE active=TRUE`);
      tenants = rows;
    } else {
      const { rows } = await pool.query(`SELECT id, name FROM tenants WHERE id = ANY($1)`, [tenant_ids]);
      tenants = rows;
    }
    for (const t of tenants) {
      try {
        const { rows: subs } = await pool.query(
          `SELECT endpoint, p256dh, auth FROM public.push_subscriptions WHERE tenant_id=$1 AND role='admin'`,
          [t.id]
        );
        if (!subs.length) { results.push({ tenant: t.name, status: 'no_subscription' }); continue; }
        // sendPush já usa o webpush global com VAPID configurado e remove subscriptions inválidas (410)
        await sendPush(subs, title, body, { url: '/', type: 'master_push' });
        sentCount += subs.length;
        results.push({ tenant: t.name, status: 'sent', count: subs.length });
      } catch (e) {
        console.error('[MasterPush]', t.name, ':', e.message);
        results.push({ tenant: t.name, status: 'error', error: e.message });
      }
    }
    res.json({ ok: true, sent: sentCount, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Histórico de pushes master
app.get('/master/api/push/history', requireMaster, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM master_push_log ORDER BY created_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lista tenants com info de subscription admin
app.get('/master/api/push/tenants', requireMaster, async (req, res) => {
  try {
    const { rows: tenants } = await pool.query(
      `SELECT t.id, t.name, t.schema_name, t.active, tc.business_name
       FROM tenants t LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
       WHERE t.active=TRUE ORDER BY t.name`
    );
    // Verifica se cada tenant tem subscription admin na tabela global
    const result = [];
    for (const t of tenants) {
      try {
        const { rows } = await pool.query(
          `SELECT role FROM public.push_subscriptions
           WHERE tenant_id=$1 AND role='admin'
           ORDER BY created_at DESC LIMIT 1`,
          [t.id]
        );
        result.push({ ...t, has_subscription: rows.length > 0, sub_role: rows[0]?.role || null });
      } catch { result.push({ ...t, has_subscription: false }); }
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// PIPELINE DE VENDAS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/master/api/pipeline', requireMaster, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM sales_pipeline ORDER BY updated_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/master/api/pipeline', requireMaster, async (req, res) => {
  const { name, contact, city, origin, status, next_action, next_action_at, notes, value } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO sales_pipeline
         (name,contact,city,origin,status,next_action,next_action_at,notes,value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, contact||'', city||'', origin||'online',
       status||'lead', next_action||'', next_action_at||null,
       notes||'', value||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/master/api/pipeline/:id', requireMaster, async (req, res) => {
  const { name, contact, city, origin, status, next_action, next_action_at, notes, value } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE sales_pipeline SET
         name=$1,contact=$2,city=$3,origin=$4,status=$5,
         next_action=$6,next_action_at=$7,notes=$8,value=$9,updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [name, contact||'', city||'', origin||'online',
       status||'lead', next_action||'', next_action_at||null,
       notes||'', value||null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Lead não encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/master/api/pipeline/:id', requireMaster, async (req, res) => {
  try {
    await pool.query(`DELETE FROM sales_pipeline WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// RELATÓRIO EXPORTÁVEL (CSV)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/master/api/report/csv', requireMaster, async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  try {
    const { rows: tenants } = await pool.query(
      `SELECT t.id, t.name, t.schema_name, t.active, t.monthly_fee, t.plan_expires_at,
              tc.business_name, t.owner_email,
              (SELECT COALESCE(SUM(amount),0) FROM payments
               WHERE tenant_id=t.id AND status='paid'
               AND TO_CHAR(paid_at,'YYYY-MM')=$1) as month_revenue
       FROM tenants t LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
       ORDER BY t.name`,
      [month]
    );

    // Agendamentos do mês por tenant
    for (const t of tenants) {
      try {
        const client = await pool.connect();
        try {
          await client.query(`SET search_path TO "${t.schema_name}", public`);
          const { rows } = await client.query(
            `SELECT COUNT(*) as cnt FROM appointments
             WHERE TO_CHAR(date,'YYYY-MM')=$1 AND status!='cancelled'`,
            [month]
          );
          t.month_appts = rows[0].cnt;
        } finally { client.release(); }
      } catch { t.month_appts = 0; }
    }

    // Monta CSV
    const lines = [
      'Negócio,Profissional (email),Status,Mensalidade (R$),Vencimento,Receita no mês (R$),Agendamentos no mês',
      ...tenants.map(t => [
        '"' + (t.business_name||t.name).replace(/"/g,'') + '"',
        t.owner_email || '',
        t.active ? 'Ativo' : 'Suspenso',
        Number(t.monthly_fee||0).toFixed(2),
        t.plan_expires_at ? t.plan_expires_at.toISOString().slice(0,10) : '',
        Number(t.month_revenue||0).toFixed(2),
        t.month_appts || 0,
      ].join(','))
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      'attachment; filename="belle-planner-' + month + '.csv"');
    const csvContent = lines.join('\r\n');
    res.send(csvContent); // UTF-8
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Toggle isenção do tenant ─────────────────────────────────────────────────
app.patch('/master/api/tenants/:id/exempt', requireMaster, async (req, res) => {
  const { exempt } = req.body;
  if (typeof exempt !== 'boolean') {
    return res.status(400).json({ error: 'Campo exempt deve ser boolean' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE tenants SET exempt=$1,
        -- Se está marcando como isento, limpa trial e vencimento
        trial_ends_at = CASE WHEN $1=TRUE THEN NULL ELSE trial_ends_at END,
        plan_expires_at = CASE WHEN $1=TRUE THEN NULL ELSE plan_expires_at END
       WHERE id=$2 RETURNING slug, exempt, plan_expires_at, trial_ends_at`,
      [exempt, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant não encontrado' });
    _tenantCache.clear();
    await logAction(req.params.id, exempt ? 'tenant_exempted' : 'tenant_unexempted',
      `Tenant ${rows[0].slug} marcado como ${exempt ? 'ISENTO' : 'NÃO ISENTO'}`);
    res.json({ ok: true, exempt: rows[0].exempt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Redefinir login do admin do tenant ───────────────────────────────────────
app.put('/master/api/tenants/:id/reset-login', requireMaster, async (req, res) => {
  const { new_login } = req.body;
  if (!new_login || new_login.trim().length < 3) {
    return res.status(400).json({ error: 'Login mínimo de 3 caracteres' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT schema_name FROM tenants WHERE id=$1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant não encontrado' });
    
    // Atualiza no tenant_configs
    await pool.query(
      `UPDATE tenant_configs SET admin_user=$1 WHERE tenant_id=$2`,
      [new_login.trim(), req.params.id]
    );
    // Atualiza no schema do tenant
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${rows[0].schema_name}", public`);
      await client.query(`UPDATE admin_profile SET login=$1`, [new_login.trim()]);
    } finally { client.release(); }
    
    await logAction(req.params.id, 'login_reset', `Login do admin alterado para: ${new_login.trim()}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Redefinir senha do admin do tenant ───────────────────────────────────────
app.put('/master/api/tenants/:id/reset-password', requireMaster, async (req, res) => {
  const { new_pass } = req.body;
  if (!new_pass || new_pass.trim().length < 6) {
    return res.status(400).json({ error: 'Senha mínima de 6 caracteres' });
  }
  try {
    const bcrypt = require('bcryptjs');
    const hash   = await bcrypt.hash(new_pass.trim(), 10);

    // Atualiza no tenant_configs (master)
    await pool.query(
      `UPDATE tenant_configs SET admin_pass_hash=$1 WHERE tenant_id=$2`,
      [hash, req.params.id]
    );

    // Atualiza no schema do tenant (admin_profile)
    const { rows } = await pool.query(
      `SELECT schema_name FROM tenants WHERE id=$1`, [req.params.id]
    );
    if (rows.length) {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${rows[0].schema_name}", public`);
        await client.query(`UPDATE admin_profile SET pass_hash=$1`, [hash]);
      } finally { client.release(); }
    }

    await logAction(req.params.id, 'password_reset', 'Senha do admin redefinida pelo master');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Re-enviar e-mail de boas-vindas ──────────────────────────────────────────
app.post('/master/api/tenants/:id/resend-welcome', requireMaster, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, tc.business_name, tc.admin_user, tc.primary_color
       FROM tenants t LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
       WHERE t.id=$1 LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant não encontrado' });
    const t = rows[0];

    await sendTenantWelcomeEmail(t, {
      admin_user:    t.admin_user || 'admin',
      admin_pass:    null, // senha não exibida no reenvio
      business_name: t.business_name || t.name,
    });
    await logAction(t.id, 'welcome_email_resent', `E-mail reenviado para ${t.owner_email}`);
    res.json({ ok: true, sent_to: t.owner_email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Sync: move orphan data from public to tenant schema ──────────────────────
app.post('/master/api/sync/:schema', requireMaster, async (req, res) => {
  const { schema } = req.params;
  const results = [];

  const tables = [
    'appointments', 'blocked_dates', 'blocked_slots',
    'released_dates', 'released_slots', 'push_subscriptions',
    'nps_responses', 'push_templates', 'app_settings',
    'promotions', 'commemorative_dates',
  ];

  const client = await pool.connect();
  try {
    for (const tbl of tables) {
      try {
        // Find rows in public that don't exist in tenant schema (by id or date PK)
        let pkCol = 'id';
        if (tbl === 'blocked_dates') pkCol = 'date';
        if (tbl === 'app_settings')  pkCol = 'key';

        // Get columns common to both
        const { rows: colRows } = await client.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
            AND column_name IN (
              SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $2
            )
          ORDER BY ordinal_position
        `, [schema, tbl]);

        if (!colRows.length) continue;
        const cols = colRows.map(r => `"${r.column_name}"`).join(', ');

        const { rowCount } = await client.query(`
          INSERT INTO "${schema}".${tbl} (${cols})
          SELECT ${cols} FROM public.${tbl} src
          WHERE NOT EXISTS (
            SELECT 1 FROM "${schema}".${tbl} dst WHERE dst.${pkCol} = src.${pkCol}
          )
        `);

        if (rowCount > 0) {
          results.push({ table: tbl, synced: rowCount });
          console.log(`[Sync] ${schema}.${tbl}: +${rowCount} registros sincronizados`);
        } else {
          results.push({ table: tbl, synced: 0 });
        }
      } catch (err) {
        results.push({ table: tbl, error: err.message });
        console.warn(`[Sync] Erro em ${tbl}: ${err.message}`);
      }
    }
    res.json({ ok: true, schema, results });
  } finally {
    client.release();
  }
});

// ── Logs ─────────────────────────────────────────────────────────────────────
app.get('/master/api/logs', requireMaster, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT l.*, t.name as tenant_name
      FROM system_logs l
      LEFT JOIN tenants t ON t.id=l.tenant_id
      ORDER BY l.created_at DESC LIMIT 100`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Gera senha aleatória segura para novos tenants
function generatePassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789@#!';
  let pass = '';
  for (let i = 0; i < 10; i++) {
    pass += chars[Math.floor(Math.random() * chars.length)];
  }
  return pass;
}

// ── E-mail de boas-vindas ao novo tenant ────────────────────────────────────
async function sendTenantWelcomeEmail(tenant, { admin_user, admin_pass, business_name }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[Master] RESEND_API_KEY não configurado — e-mail de boas-vindas não enviado');
    return;
  }
  if (!tenant.owner_email) {
    console.warn('[Master] Tenant sem owner_email — e-mail de boas-vindas não enviado');
    return;
  }

  const url = tenant.domain_custom
    ? `https://${tenant.domain_custom}`
    : tenant.subdomain ? `https://${tenant.subdomain}.belleplanner.com.br` : '';

  const adminUrl = url ? `${url}` : '(configure o domínio)';

  // Belle Planner brand colors (same for all tenants)
  const primaryColor = '#E8557A';
  const secondaryColor = '#C49A3C';


  const html = `
    <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#fdf5f8;padding:24px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-family:Georgia,serif;font-size:26px;color:${tenant.primary_color||'#9b4d6a'}">Belle <em>Planner</em></div>
        <div style="font-size:11px;letter-spacing:.1em;color:#b07090;text-transform:uppercase">Sua agenda está no ar!</div>
      </div>
      <div style="background:linear-gradient(135deg,${t.primary_color||'#9b4d6a'},#5a1a30);border-radius:12px;padding:24px;color:white;text-align:center;margin-bottom:20px">
        <div style="font-family:Georgia,serif;font-size:22px;margin-bottom:8px">Olá, ${tenant.owner_name || 'Profissional'}! 🎉</div>
        <p style="opacity:.9;margin:0">Sua agenda <strong>${business_name}</strong> foi criada com sucesso e já está disponível!</p>
      </div>
      <div style="background:white;border-radius:10px;padding:20px;margin-bottom:16px">
        <p style="font-weight:700;color:#333333;margin-bottom:14px;font-size:15px">📋 Seus dados de acesso:</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#8a6070;font-size:13px;width:120px">🌐 Endereço</td><td style="padding:8px 0;font-size:13px"><a href="${adminUrl}" style="color:${primaryColor}">${adminUrl}</a></td></tr>
          <tr><td style="padding:8px 0;color:#8a6070;font-size:13px">👤 Login</td><td style="padding:8px 0;font-size:13px;font-weight:700">${admin_user}</td></tr>
          <tr><td style="padding:8px 0;color:#8a6070;font-size:13px">🔑 Senha</td><td style="padding:8px 0;font-size:13px;font-weight:700;color:${primaryColor}">${admin_pass}</td></tr>
        </table>
        <p style="margin-top:14px;font-size:12px;color:#8a6070;background:#fdf5f8;padding:10px;border-radius:6px">
          ℹ️ Para acessar o painel administrativo, abra o endereço acima e clique em <strong>"Área administrativa"</strong> no rodapé da página.
        </p>
      </div>
      <div style="background:white;border-radius:10px;padding:16px 20px;margin-bottom:16px">
        <p style="font-weight:700;color:#333333;margin-bottom:10px;font-size:14px">🚀 Próximos passos:</p>
        <ol style="padding-left:18px;color:#4a3040;font-size:13px;line-height:2">
          <li>Acesse sua agenda pelo endereço acima</li>
          <li>Entre no painel administrativo</li>
          <li>Cadastre seus procedimentos e cidades</li>
          <li>Configure seus horários de atendimento</li>
          <li>Instale o aplicativo no seu celular</li>
        </ol>
      </div>
      <p style="text-align:center;font-size:11px;color:#aaa;margin-top:16px">
        Belle Planner · Sistema de Agendamento Online<br>
        Dúvidas? Entre em contato com seu consultor.
      </p>
    </div>`;

  console.log('[Master] Enviando e-mail para:', tenant.owner_email, '| From:', MASTER_FROM_EMAIL);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    `Belle Planner <${MASTER_FROM_EMAIL}>`,
        to:      [tenant.owner_email],
        ...(tenant.owner_email !== 'erick.torritezi@gmail.com' ? { bcc: ['erick.torritezi@gmail.com'] } : {}),
        reply_to: 'erick.torritezi@gmail.com',
        subject: `[Belle Planner] ${business_name} — sua agenda está no ar! 🎉`,
        html,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      console.error('[Master] Erro ao enviar e-mail de boas-vindas:', JSON.stringify(result));
    } else {
      console.log(`[Master] E-mail de boas-vindas enviado para ${tenant.owner_email}`);
    }
  } catch (e) {
    console.error('[Master] Exceção ao enviar e-mail de boas-vindas:', e.message);
  }
}

// ── Cron: verifica vencimentos diariamente às 08h00 BRT (= 11h00 UTC) ────────
cron.schedule('0 11 * * *', async () => {
  console.log('[Master Cron] Verificando vencimentos de tenants...');
  try {
    const today = todayBrasilia();

    // 0. Trial de implantação expirado (7 dias sem pagar setup) → suspende
    const { rows: trialExp } = await pool.query(
      `UPDATE tenants SET active=FALSE
       WHERE active=TRUE AND exempt=FALSE
         AND trial_ends_at IS NOT NULL AND trial_ends_at < $1::date
         AND NOT EXISTS (
           SELECT 1 FROM payments
           WHERE tenant_id = tenants.id
             AND type = 'setup'
             AND status = 'paid'
         )
       RETURNING id, slug, owner_email, owner_name`,
      [today]
    );
    for (const t of trialExp) {
      await logAction(t.id, 'trial_expired',
        `Trial de implantação de ${t.slug} expirou — acesso suspenso por falta de pagamento`);
      console.log(`[Cron] Trial implantação expirado: ${t.slug}`);
    }

    // 1. Bloqueia tenants vencidos há mais de 7 dias (apenas não-isentos)
    const { rows: toBlock } = await pool.query(
      `UPDATE tenants SET active=FALSE
       WHERE active=TRUE AND exempt=FALSE
         AND plan_expires_at < ($1::date - interval '7 days')
         AND (trial_ends_at IS NULL OR trial_ends_at < $1::date)
       RETURNING id, slug, owner_email, owner_name`,
      [today]
    );
    for (const t of toBlock) {
      await logAction(t.id, 'tenant_auto_blocked',
        `Bloqueado por falta de pagamento (vencido > 7 dias)`);
      console.log(`[Master Cron] Tenant ${t.slug} bloqueado automaticamente.`);
    }

    // 1b. Email de cobrança urgente — 7 dias após vencimento (acesso suspenso)
    const { rows: overdueWeek } = await pool.query(
      `SELECT t.id, t.owner_email, t.owner_name, t.slug, tc.business_name
       FROM tenants t
       LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
       WHERE t.active=FALSE AND t.exempt=FALSE
         AND t.plan_expires_at IS NOT NULL
         AND t.plan_expires_at::date = ($1::date - interval '7 days')`,
      [today]
    );
    for (const t of overdueWeek) {
      if (!t.owner_email || !process.env.RESEND_API_KEY) continue;
      const businessName = t.business_name || t.slug;
      const htmlOverdue = `
        <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
        <style>
          body{font-family:'Nunito',Arial,sans-serif;background:#f5eff2;margin:0;padding:24px}
          .card{background:#fff;border-radius:16px;max-width:520px;margin:0 auto;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
          .header{background:linear-gradient(135deg,#C0392B,#922B21);padding:28px 32px;text-align:center;color:#fff}
          .header h1{font-size:22px;margin:0 0 6px;font-weight:700}
          .header p{font-size:13px;margin:0;opacity:.85}
          .body{padding:28px 32px}
          .alert-box{background:#fdf0ee;border-left:4px solid #C0392B;border-radius:8px;padding:16px;margin:16px 0;font-size:14px;color:#922B21;font-weight:600}
          .footer{background:#f9f5f7;padding:16px 32px;text-align:center;font-size:11px;color:#B89AAA}
          .btn{display:inline-block;background:linear-gradient(135deg,#9B4D6A,#6B2B46);color:#fff;text-decoration:none;border-radius:50px;padding:12px 28px;font-weight:700;font-size:14px}
        </style></head>
        <body><div class="card">
          <div class="header">
            <h1>⚠️ Acesso Suspenso</h1>
            <p>Belle Planner Pro</p>
          </div>
          <div class="body">
            <p style="font-size:15px;color:#3D2B35">Olá, <strong>${t.owner_name || 'Profissional'}</strong>!</p>
            <div class="alert-box">
              Sua agenda <strong>${businessName}</strong> está suspensa há 7 dias por falta de pagamento da mensalidade.
            </div>
            <p style="font-size:14px;color:#6B5060;line-height:1.7">
              Para reativar seu acesso e não perder seus dados e agendamentos, realize o pagamento o quanto antes e nos envie o comprovante.
            </p>
            <div style="text-align:center;margin:24px 0">
              <a href="https://wa.me/${process.env.SUPPORT_WHATSAPP || '5511949851250'}?text=Olá! Preciso reativar minha agenda ${businessName}" class="btn">
                📲 Falar no WhatsApp agora
              </a>
            </div>
            <p style="font-size:12px;color:#8A6B76;text-align:center">
              Após o comprovante, seu acesso é reativado imediatamente. ✅
            </p>
          </div>
          <div class="footer">Belle Planner Pro · pro.belleplanner.com.br</div>
        </div></body></html>`;

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:     `Belle Planner <${MASTER_FROM_EMAIL}>`,
          to:       [t.owner_email],
          bcc:      ['erick.torritezi@gmail.com'],
          reply_to: 'erick.torritezi@gmail.com',
          subject:  `🚨 ${businessName} — acesso suspenso. Regularize agora`,
          html: htmlOverdue,
        }),
      });
      await logAction(t.id, 'overdue_week_email_sent',
        `Email de cobrança urgente enviado (7 dias vencido)`);
      console.log(`[Master Cron] Email urgente enviado para ${t.owner_email}`);
    }

    // 2. Envia lembrete para tenants vencendo em exatamente 5 dias
    const { rows: expiring } = await pool.query(
      `SELECT t.*, tc.business_name FROM tenants t
       LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
       WHERE t.active=TRUE AND t.exempt=FALSE AND t.plan_expires_at = ($1::date + interval '5 days')`,
      [today]
    );
    for (const t of expiring) {
      if (!t.owner_email || !process.env.RESEND_API_KEY) continue;
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fdf5f8;padding:24px">
          <div style="text-align:center;margin-bottom:20px">
            <div style="font-family:Georgia,serif;font-size:24px;color:${primaryColor}">Belle Planner</div>
          </div>
          <div style="background:linear-gradient(135deg,#E8557A,#C49A3C);border-radius:12px;padding:20px;color:white;text-align:center;margin-bottom:20px">
            <div style="font-size:32px;margin-bottom:8px">⚠️</div>
            <div style="font-family:Georgia,serif;font-size:20px">Sua agenda vence em 5 dias</div>
          </div>
          <div style="background:white;border-radius:10px;padding:18px;margin-bottom:16px">
            <p>Olá, <strong>${t.owner_name || 'Profissional'}</strong>!</p>
            <p>Sua agenda <strong>${t.business_name}</strong> vence em <strong>5 dias</strong>. Para continuar usando sem interrupção, entre em contato para renovar sua assinatura.</p>
            <p style="margin-top:12px"><strong>📱 WhatsApp:</strong> <a href="${process.env.SUPPORT_WHATSAPP ? 'https://wa.me/'+process.env.SUPPORT_WHATSAPP : 'mailto:erick.torritezi@gmail.com'}">Falar com suporte</a></p>
          </div>
          <p style="text-align:center;font-size:11px;color:#aaa">Belle Planner · Sistema de Agendamento Online</p>
        </div>`;
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:    `Belle Planner <${MASTER_FROM_EMAIL}>`,
          to:      [t.owner_email],
          bcc:     ['erick.torritezi@gmail.com'],
          reply_to: 'erick.torritezi@gmail.com',
          subject: `⚠️ ${t.business_name} — sua agenda vence em 5 dias`,
          html,
        }),
      });
      await logAction(t.id, 'expiry_reminder_sent', `Lembrete de vencimento enviado para ${t.owner_email}`);
      console.log(`[Master Cron] Lembrete enviado para ${t.owner_email}`);
    }
    // 4. Mensalidade: 3 dias antes do vencimento → cria cobrança pending + envia email Pix
    const in3days = new Date();
    in3days.setDate(in3days.getDate() + 3);
    const in3str = in3days.toISOString().slice(0,10);

    const { rows: billTenants } = await pool.query(
      `SELECT t.id, t.owner_email, t.owner_name, t.name as tenant_name,
              tc.business_name
       FROM tenants t
       LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
       WHERE t.active=TRUE AND t.exempt=FALSE
         AND t.plan_expires_at::date = $1::date`,
      [in3str]
    );

    for (const t of billTenants) {
      // Só cria se ainda não existe cobrança monthly para este mês
      const refMonth = in3str.slice(0,7); // YYYY-MM
      const { rows: existPay } = await pool.query(
        `SELECT id FROM payments WHERE tenant_id=$1 AND type='monthly' AND reference_month=$2 LIMIT 1`,
        [t.id, refMonth]
      );
      if (!existPay.length) {
        const { rows: payRows } = await pool.query(
          `INSERT INTO payments (tenant_id,type,amount,status,reference_month,notes)
           VALUES ($1,'monthly',149.00,'pending',$2,'Gerado automaticamente 3 dias antes do vencimento')
           RETURNING *`,
          [t.id, refMonth]
        );
        const payData = { ...payRows[0], ...t };
        sendPaymentEmail(payData).catch(e =>
          console.error('[Master Cron] Erro ao enviar email mensalidade:', e.message)
        );
        await logAction(t.id, 'monthly_payment_created',
          `Cobrança de mensalidade ${refMonth} gerada (3 dias antes do vencimento)`);
        console.log(`[Master Cron] Cobrança mensalidade criada para ${t.owner_email}`);
      }
    }

    _tenantCache.clear();
  } catch (err) { console.error('[Master Cron] Erro:', err.message); }
}, { timezone: 'UTC' });

// Serve landing page Belle Planner Pro (pro.belleplanner.com.br)
app.get('*', (req, res, next) => {
  if (req.hostname === 'pro.belleplanner.com.br') {
    return res.sendFile(require('path').join(__dirname, 'public', 'pro.html'));
  }
  next();
});

// Serve o painel master
app.get('/master', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'master.html'));
});
app.get('/master/', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'master.html'));
});

// ── Health Check ─────────────────────────────────────────────────────────────
// Endpoint público — monitorado pelo UptimeRobot e pelo painel master
app.get('/api/health', async (req, res) => {
  const start = Date.now();
  const status = { server: 'ok', database: 'ok', timestamp: new Date().toISOString(), latency_ms: 0 };
  try {
    await pool.query('SELECT 1');
    status.latency_ms = Date.now() - start;
    res.json(status);
  } catch (err) {
    status.database = 'error';
    status.error    = err.message;
    status.latency_ms = Date.now() - start;
    res.status(503).json(status);
  }
});

// ── Master: health de todos os tenants ────────────────────────────────────────
// Verifica saúde diretamente no banco — sem HTTP para fora (evita loops no Railway)
app.get('/master/api/health', requireMaster, async (req, res) => {
  try {
    const { rows: tenants } = await pool.query(
      `SELECT t.id, t.slug, t.active, t.domain_custom, t.subdomain,
              tc.business_name
       FROM tenants t LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
       WHERE t.active=TRUE ORDER BY t.id`
    );

    const results = await Promise.allSettled(
      tenants.map(async t => {
        const url = t.domain_custom
          ? `https://${t.domain_custom}/api/health`
          : t.subdomain ? `https://${t.subdomain}.belleplanner.com.br/api/health` : null;

        // Verifica banco diretamente usando o schema do tenant
        const start = Date.now();
        try {
          await pool.query(`SELECT 1`);
          // Conta agendamentos recentes como indicador de atividade
          const { rows: appts } = await pool.query(
            `SELECT COUNT(*) as cnt FROM appointments WHERE created_at > NOW() - interval '30 days'`
          );
          return {
            id: t.id, slug: t.slug,
            business_name: t.business_name || t.slug,
            url, status: 'ok',
            latency_ms: Date.now() - start,
            db: 'ok',
            recent_appts: Number(appts[0]?.cnt || 0),
            checked_at: new Date().toISOString(),
          };
        } catch (err) {
          await logAction(t.id, 'health_check_failed', `DB error: ${err.message}`);
          return {
            id: t.id, slug: t.slug,
            business_name: t.business_name || t.slug,
            url, status: 'degraded',
            latency_ms: Date.now() - start,
            db: 'error', error: err.message,
            checked_at: new Date().toISOString(),
          };
        }
      })
    );

    res.json(results.map(r =>
      r.status === 'fulfilled' ? r.value : { status: 'error', error: r.reason?.message }
    ));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Master: health history (últimos incidentes) ───────────────────────────────
app.get('/master/api/health/history', requireMaster, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT l.*, t.name as tenant_name, tc.business_name
      FROM system_logs l
      LEFT JOIN tenants t ON t.id=l.tenant_id
      LEFT JOIN tenant_configs tc ON tc.tenant_id=l.tenant_id
      WHERE l.action IN ('health_check_failed','tenant_auto_blocked','expiry_reminder_sent')
      ORDER BY l.created_at DESC LIMIT 50`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Static manifest.json — Belle Planner brand (same for all tenants) ───────
app.get('/manifest.json', (req, res) => {
  res.json({
    name:             'Belle Planner',
    short_name:       'Belle Planner',
    description:      'Sua agenda online — Belle Planner',
    start_url:        '/',
    display:          'standalone',
    orientation:      'portrait',
    background_color: '#FAF0F5',
    theme_color:      '#E8557A',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  });
});

// ── Tenant Config (White Label) ───────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  try {
    if (req.tenant) {
      return res.json({
        business_name:   req.tenant.business_name   || 'Bela Essência',
        tagline:         req.tenant.tagline          || '',
        primary_color:   req.tenant.primary_color    || '#9b4d6a',
        secondary_color: req.tenant.secondary_color  || '#C49A3C',
        accent_color:    req.tenant.accent_color     || '#7b3050',
        logo_url:        req.tenant.logo_url         || null,
        favicon_url:     req.tenant.favicon_url      || null,
        whatsapp_number: req.tenant.whatsapp_number  || '',
        timezone:        req.tenant.timezone         || 'America/Sao_Paulo',
      });
    }
    res.json({
      business_name:   'Belle Planner',
      tagline:         'Agendamento Online',
      primary_color:   '#9b4d6a',
      secondary_color: '#C49A3C',
      accent_color:    '#7b3050',
      logo_url:        null,
      favicon_url:     null,
      whatsapp_number: '',
      timezone:        'America/Sao_Paulo',
    });
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
    const apptRes = await req.db(
      `SELECT id, proc_name, date FROM appointments
       WHERE regexp_replace(phone, '[^0-9]', '', 'g') LIKE $1
         AND status = 'realizado'
       ORDER BY date DESC, et DESC LIMIT 1`,
      [`%${norm.slice(-8)}`]  // busca pelos últimos 8 dígitos (mais tolerante)
    );
    if (!apptRes.rowCount) return res.json({ eligible: false });
    const appt = apptRes.rows[0];

    // Verificar cooldown: última resposta NPS deste telefone
    const lastRes = await req.db(
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
    await req.db(
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
    const { rows: all } = await req.db(
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
    const { rows } = await req.db('SELECT * FROM released_dates ORDER BY date');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/released', requireAdmin, async (req, res) => {
  const { date, city_ids, work_start, work_end, break_start, break_end, reason } = req.body;
  if (!date || !work_start || !work_end) return res.status(400).json({ error: 'Data, início e fim são obrigatórios' });
  const ids = Array.isArray(city_ids) ? city_ids.map(Number) : [];
  try {
    const { rows } = await req.db(
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
    await req.db('DELETE FROM released_dates WHERE date=$1', [req.params.date]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/released-slots', requireAdmin, async (req, res) => {
  try {
    const { rows } = await req.db('SELECT * FROM released_slots ORDER BY date, st');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/released-slots', requireAdmin, async (req, res) => {
  const { date, st, et, city_ids, reason } = req.body;
  if (!date || !st || !et) return res.status(400).json({ error: 'Data, início e fim são obrigatórios' });
  if (timeToMin(st) >= timeToMin(et)) return res.status(400).json({ error: 'Início deve ser antes do fim' });
  const ids = Array.isArray(city_ids) ? city_ids.map(Number) : [];
  try {
    const { rows } = await req.db(
      `INSERT INTO released_slots (date, st, et, city_ids, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [date, st, et, ids, reason||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/released-slots/:id', requireAdmin, async (req, res) => {
  try {
    await req.db('DELETE FROM released_slots WHERE id=$1', [req.params.id]);
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
          await pool.query('DELETE FROM public.push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
          console.log('[Push] Subscription removida (expirada).');
        }
        throw err;
      }
    })
  );

  const ok = results.filter(r => r.status === 'fulfilled').length;
  console.log(`[Push] Resultado: ${ok}/${results.length} enviados com sucesso.`);
}

async function getSubsByRole(role, tenantId) {
  // ALWAYS use 'public.push_subscriptions' explicitly to avoid search_path contamination
  // from tenant connections (connections may have SET search_path TO "tenant_xxx", public)
  const { rows } = await pool.query(
    tenantId
      ? 'SELECT endpoint, p256dh, auth FROM public.push_subscriptions WHERE role=$1 AND tenant_id=$2'
      : 'SELECT endpoint, p256dh, auth FROM public.push_subscriptions WHERE role=$1',
    tenantId ? [role, tenantId] : [role]
  );
  return rows;
}

async function getSubsByAuth(authKey) {
  if (!authKey) return [];
  const { rows } = await pool.query(
    `SELECT endpoint, p256dh, auth FROM public.push_subscriptions
     WHERE role='client' AND auth=$1`,
    [authKey]
  );
  return rows;
}

// Notifica admin sobre novo agendamento
async function notifyAdminNewBooking(appt) {
  // Filter by tenant to avoid cross-tenant push notifications
  const { rows: tRows } = await pool.query(
    `SELECT id FROM tenants WHERE schema_name=$1 LIMIT 1`, [appt._schemaName || 'public']
  ).catch(() => ({ rows: [] }));
  const tenantId = tRows[0]?.id || null;
  const subs = await getSubsByRole('admin', tenantId);
  await sendPush(subs,
    '✨ Novo agendamento!',
    `${appt.name} · ${appt.proc_name} · ${String(appt.date).slice(0,10)} às ${String(appt.st).slice(0,5)}`,
    { url: '/#admin', type: 'new_booking' }
  );
}

// Notifica cliente específico sobre alteração
async function notifyAdminEdit(appt) {
  const { rows: tRows } = await pool.query(
    `SELECT id FROM tenants WHERE schema_name=$1 LIMIT 1`, [appt._schemaName || 'public']
  ).catch(() => ({ rows: [] }));
  const tenantId = tRows[0]?.id || null;
  const subs = await getSubsByRole('admin', tenantId);
  await sendPush(subs,
    '✏️ Agendamento editado',
    `${appt.name} · ${appt.proc_name} · ${String(appt.date).slice(0,10)} às ${String(appt.st).slice(0,5)}`,
    { url: '/#admin', type: 'booking_edited' }
  );
}

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

// ── Email de cobrança de pagamento (Pix) ─────────────────────────────────────
const PIX_SETUP_COPY   = '00020126360014br.gov.bcb.pix0114+55119498512505204000053039865406247.005802BR5915ERICK TORRITEZI6009Sao Paulo62220518daqr943793650724616304960A';
const PIX_MONTHLY_COPY = '00020126360014br.gov.bcb.pix0114+55119498512505204000053039865406149.005802BR5915ERICK TORRITEZI6009Sao Paulo62220518daqr943793651806576304452F';
const PIX_SETUP_QR_B64   = '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';
const PIX_MONTHLY_QR_B64 = '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';

async function sendPaymentEmail(p) {
  const pixCopyPaste = p.type === 'setup' ? PIX_SETUP_COPY : PIX_MONTHLY_COPY;
  const pixQrB64     = p.type === 'setup' ? PIX_SETUP_QR_B64 : PIX_MONTHLY_QR_B64;
  const typeLabel    = p.type === 'setup' ? 'Implantação' : 'Mensalidade';
  const amountFmt    = `R$ ${Number(p.amount).toFixed(2).replace('.', ',')}`;
  const businessName = p.business_name || p.tenant_name;
  const ownerName    = p.owner_name || 'Profissional';

  const qrBlock = `<div style="text-align:center;margin:24px 0">
       <img src="data:image/png;base64,${pixQrB64}" alt="QR Code Pix" style="width:220px;height:220px;border-radius:12px;border:1px solid #E8D5DE">
     </div>`;

  const html = `
    <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
    <style>
      body{font-family:'Nunito',Arial,sans-serif;background:#f5eff2;margin:0;padding:24px}
      .card{background:#fff;border-radius:16px;max-width:520px;margin:0 auto;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
      .header{background:linear-gradient(135deg,#9B4D6A,#6B2B46);padding:28px 32px;text-align:center}
      .header h1{color:#fff;font-size:22px;margin:0;font-weight:700}
      .header p{color:rgba(255,255,255,.8);font-size:13px;margin:6px 0 0}
      .body{padding:28px 32px}
      .amount{text-align:center;margin:20px 0}
      .amount .label{font-size:12px;color:#8A6B76;text-transform:uppercase;letter-spacing:.08em;font-weight:700}
      .amount .value{font-size:42px;font-weight:700;color:#6B2B46;line-height:1.1}
      .pix-box{background:#f9f5f7;border:2px solid #9B4D6A;border-radius:12px;padding:16px;margin:20px 0}
      .pix-label{font-size:11px;font-weight:800;text-transform:uppercase;color:#9B4D6A;margin-bottom:8px}
      .pix-code{font-family:monospace;font-size:11px;color:#3D2B35;word-break:break-all;background:#fff;padding:10px 12px;border-radius:8px;border:1px solid #E8D5DE}
      .footer{background:#f9f5f7;padding:16px 32px;text-align:center;font-size:11px;color:#B89AAA}
      .btn{display:inline-block;background:linear-gradient(135deg,#9B4D6A,#6B2B46);color:#fff;text-decoration:none;border-radius:50px;padding:12px 28px;font-weight:700;font-size:14px;margin-top:8px}
    </style></head>
    <body>
    <div class="card">
      <div class="header">
        <h1>Belle Planner Pro</h1>
        <p>Cobrança — ${typeLabel}</p>
      </div>
      <div class="body">
        <p style="font-size:15px;color:#3D2B35">Olá, <strong>${ownerName}</strong>! 👋</p>
        <p style="font-size:14px;color:#6B5060;line-height:1.6">
          ${p.type === 'setup'
            ? `Sua agenda <strong>${businessName}</strong> está pronta! Para ativarmos seu acesso completo, realize o pagamento da implantação via Pix.`
            : `A mensalidade da sua agenda <strong>${businessName}</strong> está disponível para pagamento.`
          }
        </p>
        <div class="amount">
          <div class="label">${typeLabel}</div>
          <div class="value">${amountFmt}</div>
        </div>
        ${qrBlock}
        <div class="pix-box">
          <div class="pix-label">📋 Pix Copia e Cola</div>
          <div class="pix-code">${pixCopyPaste}</div>
        </div>
        <p style="font-size:12px;color:#8A6B76;text-align:center;margin-top:16px">
          Após o pagamento, envie o comprovante pelo WhatsApp para confirmarmos. ✅
        </p>
      </div>
      <div class="footer">Belle Planner Pro · pro.belleplanner.com.br</div>
    </div>
    </body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:     `Belle Planner <${MASTER_FROM_EMAIL}>`,
      to:       [p.owner_email],
      bcc:      ['erick.torritezi@gmail.com'],
      reply_to: 'erick.torritezi@gmail.com',
      subject:  `💳 Belle Planner — ${typeLabel === 'Implantação' ? 'Pagamento da Implantação' : 'Mensalidade'} · ${amountFmt}`,
      html,
    }),
  });
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
    // ALWAYS use pool (public schema) — push_subscriptions é tabela global
    await pool.query(
      `INSERT INTO public.push_subscriptions (endpoint, p256dh, auth, role, tenant_id)
       VALUES ($1, $2, $3, 'client', (SELECT id FROM tenants WHERE schema_name=$4 LIMIT 1))
       ON CONFLICT (endpoint) DO UPDATE SET p256dh=$2, auth=$3,
         tenant_id=(SELECT id FROM tenants WHERE schema_name=$4 LIMIT 1)`,
      [endpoint, keys.p256dh, keys.auth, req.schemaName || 'public']
    );

    // Liga a subscription ao agendamento para notificações futuras
    if (appointmentId) {
      await req.db(
        `UPDATE appointments SET push_auth=$1 WHERE id=$2`,
        [keys.auth, appointmentId]
      );
    }

    res.json({ ok: true });

    // Envia confirmação push imediatamente após inscrição
    // (resolve o race condition — subscription existe ANTES de enviar)
    if (appointmentId) {
      const { rows } = await req.db('SELECT * FROM appointments WHERE id=$1', [appointmentId]);
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
    const { rows } = await req.db('SELECT * FROM push_templates ORDER BY is_system DESC, id');
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
    const { rows } = await req.db(
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
    const { rows } = await req.db(
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
    const { rowCount } = await req.db(
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
    const { rows: allSubs } = await req.db(
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
    const { rows } = await req.db(
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
    // ALWAYS use pool (public schema) — push_subscriptions é tabela global
    await pool.query(
      `INSERT INTO public.push_subscriptions (endpoint, p256dh, auth, role, tenant_id)
       VALUES ($1, $2, $3, 'admin', (SELECT id FROM tenants WHERE schema_name=$4 LIMIT 1))
       ON CONFLICT (endpoint) DO UPDATE SET p256dh=$2, auth=$3,
         role='admin', tenant_id=(SELECT id FROM tenants WHERE schema_name=$4 LIMIT 1)`,
      [endpoint, keys.p256dh, keys.auth, req.schemaName || 'public']
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. FRONTEND ESTÁTICO
// ══════════════════════════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback – qualquer rota não encontrada retorna o index.html
// ── Subdomínio contratos.belleplanner.com.br — página de aceite contratual
app.get('*', (req, res, next) => {
  if (req.hostname === 'contratos.belleplanner.com.br') {
    return res.sendFile(require('path').join(__dirname, 'public', 'contrato-aceite.html'));
  }
  next();
});

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
      from:    `Belle Planner <${MASTER_FROM_EMAIL}>`,
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

    // Belle Planner brand color for all emails
    const emailColor = '#E8557A';

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
            <td style="padding:10px 14px;border-bottom:1px solid #f0e8ec;color:#333">${a.proc_name}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #f0e8ec;color:#333;white-space:nowrap">${String(a.st).slice(0,5)}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #f0e8ec;color:${emailColor};font-weight:700">${valor}</td>
          </tr>`;
      }).join('');
      return `
        <div style="margin-bottom:28px">
          <div style="background:${emailColor};color:white;padding:10px 16px;border-radius:8px 8px 0 0;font-size:15px;font-weight:700">
            📍 ${city}
          </div>
          <table style="width:100%;border-collapse:collapse;background:white;border-radius:0 0 8px 8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
            <thead>
              <tr style="background:#fdf0f4">
                <th style="padding:8px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:${emailColor};letter-spacing:.06em">Cliente</th>
                <th style="padding:8px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:${emailColor};letter-spacing:.06em">WhatsApp</th>
                <th style="padding:8px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:${emailColor};letter-spacing:.06em">Procedimento</th>
                <th style="padding:8px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:${emailColor};letter-spacing:.06em">Horário</th>
                <th style="padding:8px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:${emailColor};letter-spacing:.06em">Valor</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join('');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;background:#fdf5f8;padding:24px">
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-family:Georgia,serif;font-size:28px;color:${emailColor};font-style:italic">${prof.name || 'Belle Planner'}</div>
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#b07090;margin-top:4px">Agenda do Dia</div>
        </div>
        <div style="background:linear-gradient(135deg,${emailColor},${emailColor}cc);border-radius:12px;padding:20px 24px;margin-bottom:24px;color:white;text-align:center">
          <div style="font-size:14px;opacity:.85;margin-bottom:6px">Sua programação para</div>
          <div style="font-family:Georgia,serif;font-size:24px;font-weight:bold">${dateLabel}</div>
          <div style="font-size:13px;margin-top:8px;opacity:.85">${appts.length} procedimento${appts.length!==1?'s':''} agendado${appts.length!==1?'s':''}</div>
        </div>
        ${cityBlocks}
        <div style="text-align:center;margin-top:24px;font-size:11px;color:#aaa">
          ${prof.name || 'Belle Planner'} · Sistema de Agendamento Online<br>
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

// ── Cron: snapshot à meia-noite BRT (03h00 UTC) ─────────────────────────────
cron.schedule('0 3 * * *', async () => {
  console.log('[Cron] 00h00 BRT — gerando snapshots da agenda do dia...');
  try {
    const today = todayBrasilia();
    const { rows: tenants } = await pool.query(
      `SELECT t.id, t.schema_name, t.name, tc.business_name
       FROM tenants t LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
       WHERE t.active=TRUE`
    );
    for (const t of tenants) {
      try {
        const client = await pool.connect();
        let appts = [];
        try {
          await client.query(`SET search_path TO "${t.schema_name}", public`);
          const { rows } = await client.query(
            `SELECT a.*, c.name as city_name FROM appointments a
             LEFT JOIN cities c ON c.id = a.city_id
             WHERE a.date = $1 AND a.status != 'cancelled'
             ORDER BY a.st`,
            [today]
          );
          appts = rows;
        } finally { client.release(); }
        await pool.query(
          `INSERT INTO daily_agenda_snapshots (tenant_id, snap_date, snapshot, sent)
           VALUES ($1, $2, $3::jsonb, FALSE)
           ON CONFLICT (tenant_id, snap_date)
           DO UPDATE SET snapshot=$3::jsonb, sent=FALSE, created_at=NOW()`,
          [t.id, today, JSON.stringify({ appointments: appts, generated_at: new Date().toISOString() })]
        );
        console.log('[Cron] Snapshot ' + (t.business_name||t.name) + ': ' + appts.length + ' agendamentos');
      } catch (e) { console.error('[Cron] Snapshot erro ' + t.name + ':', e.message); }
    }
  } catch (e) { console.error('[Cron] Snapshot geral:', e.message); }
});

// ── Cron: e-mail diário às 06h30 BRT (09h30 UTC) — usa snapshot da meia-noite
// ── Lembrete push 30min antes do procedimento (a cada 5min) ─────────────────
cron.schedule('*/5 * * * *', async () => {
  try {
    // Busca todos os tenants ativos
    const { rows: tenants } = await pool.query(
      `SELECT id, schema_name FROM tenants WHERE active=TRUE`
    );

    for (const tenant of tenants) {
      const schema = tenant.schema_name;
      try {
        // Agendamentos confirmados que começam entre 28 e 32 minutos a partir de agora (BRT)
        // e ainda não receberam o lembrete
        const { rows: appts } = await pool.query(`
          SELECT a.*, t.schema_name
          FROM ${schema}.appointments a
          CROSS JOIN tenants t
          WHERE t.id = $1
            AND a.status = 'confirmed'
            AND a.reminder_sent = FALSE
            AND a.push_auth IS NOT NULL
            AND (a.date::text || ' ' || a.st::text)::timestamp AT TIME ZONE 'America/Sao_Paulo'
                BETWEEN NOW() AT TIME ZONE 'America/Sao_Paulo' + INTERVAL '28 minutes'
                    AND NOW() AT TIME ZONE 'America/Sao_Paulo' + INTERVAL '32 minutes'
        `, [tenant.id]);

        for (const appt of appts) {
          try {
            const subs = await getSubsByAuth(appt.push_auth);
            if (subs.length > 0) {
              await sendPush(
                subs,
                '⏰ Lembrete de agendamento',
                `Seu procedimento de ${appt.proc_name} começa em 30 minutos! Às ${appt.st.slice(0,5)}.`,
                { type: 'reminder_30min' }
              );
              console.log(`[Push Reminder] Enviado para ${appt.name} — ${schema} — ${appt.date} ${appt.st}`);
            }
            // Marca como enviado independente de ter subscription ativa
            // (evita reenvio a cada 5min)
            await pool.query(
              `UPDATE ${schema}.appointments SET reminder_sent=TRUE WHERE id=$1`,
              [appt.id]
            );
          } catch (e) {
            console.error(`[Push Reminder] Erro para appt ${appt.id}:`, e.message);
          }
        }
      } catch (e) {
        console.error(`[Push Reminder] Erro no tenant ${schema}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Push Reminder] Erro geral:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('30 9 * * *', async () => {
  console.log('[Cron] 06h30 BRT — disparando e-mails da agenda diária...');
  try {
    const today = todayBrasilia();

    // Busca snapshots do dia ainda não enviados
    const { rows: snaps } = await pool.query(
      `SELECT s.*, t.schema_name, t.name as tenant_name,
              tc.business_name, tc.primary_color, tc.resend_from_email,
              tc.whatsapp_number
       FROM daily_agenda_snapshots s
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN tenant_configs tc ON tc.tenant_id = t.id
       WHERE s.snap_date = $1 AND s.sent = FALSE AND t.active = TRUE`,
      [today]
    );

    if (!snaps.length) {
      // Fallback: nenhum snapshot gerado (servidor reiniciou após meia-noite?)
      // Gera snapshot em tempo real e envia
      console.log('[Cron] Sem snapshots — gerando em tempo real...');
      await sendDailyAgendaEmail();
      return;
    }

    for (const snap of snaps) {
      try {
        const data    = snap.snapshot;
        const appts   = data.appointments || [];
        const genAt   = data.generated_at ? new Date(data.generated_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '00h00';

        // Busca email do profissional no schema do tenant
        const client = await pool.connect();
        let prof = null;
        try {
          await client.query(`SET search_path TO "${snap.schema_name}", public`);
          const { rows } = await client.query(`SELECT name, email FROM admin_profile LIMIT 1`);
          prof = rows[0];
        } finally { client.release(); }

        if (!prof?.email) {
          console.log('[Cron] Sem e-mail para ' + (snap.business_name||snap.tenant_name));
          continue;
        }

        const bizName = snap.business_name || snap.tenant_name;
        const color   = '#E8557A'; // Belle Planner brand

        // Monta HTML do email com os agendamentos do snapshot
        const rows_html = appts.length ? appts.map(a =>
          '<tr>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #f0e0e8;font-size:13px;color:#444">' + a.st + ' – ' + a.et + '</td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #f0e0e8;font-size:13px;color:#4a3040;font-weight:600">' + a.name + '</td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #f0e0e8;font-size:13px;color:#6a4060">' + (a.proc_name||'') + '</td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #f0e0e8;font-size:13px;color:#8a6070">' + (a.city_name||'') + '</td>' +
          '</tr>'
        ).join('') : '<tr><td colspan="4" style="padding:16px;text-align:center;color:#8a6070;font-style:italic">Nenhum agendamento para hoje</td></tr>';

        const html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fdf5f8;padding:20px">' +
          '<div style="background:linear-gradient(135deg,' + color + ',#5a1a30);border-radius:10px;padding:20px;color:white;text-align:center;margin-bottom:16px">' +
            '<div style="font-size:20px;font-weight:bold">' + bizName + '</div>' +
            '<div style="opacity:.85;font-size:13px;margin-top:4px">Agenda de hoje · ' + new Date().toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo',weekday:'long',day:'numeric',month:'long'}) + '</div>' +
          '</div>' +
          '<div style="background:white;border-radius:8px;overflow:hidden;margin-bottom:12px">' +
            '<table style="width:100%;border-collapse:collapse">' +
              '<thead><tr style="background:#f5eaef">' +
                '<th style="padding:8px 12px;text-align:left;font-size:11px;color:' + color + ';font-weight:800;text-transform:uppercase">Horário</th>' +
                '<th style="padding:8px 12px;text-align:left;font-size:11px;color:' + color + ';font-weight:800;text-transform:uppercase">Cliente</th>' +
                '<th style="padding:8px 12px;text-align:left;font-size:11px;color:' + color + ';font-weight:800;text-transform:uppercase">Procedimento</th>' +
                '<th style="padding:8px 12px;text-align:left;font-size:11px;color:' + color + ';font-weight:800;text-transform:uppercase">Local</th>' +
              '</tr></thead>' +
              '<tbody>' + rows_html + '</tbody>' +
            '</table>' +
          '</div>' +
          '<p style="text-align:center;font-size:10px;color:#aaa">Agenda gerada às ' + genAt + ' · Belle Planner</p>' +
        '</div>';

        await sendEmail({
          to:      prof.email,
          bcc:     prof.email !== 'erick.torritezi@gmail.com' ? 'erick.torritezi@gmail.com' : undefined,
          subject: bizName + ' · Agenda de hoje ' + new Date().toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit'}),
          html,
        });

        // Marca como enviado
        await pool.query(
          `UPDATE daily_agenda_snapshots SET sent=TRUE WHERE id=$1`,
          [snap.id]
        );
        console.log('[Cron] E-mail enviado: ' + bizName + ' (' + appts.length + ' agendamentos)');
      } catch (e) { console.error('[Cron] Erro no envio para ' + snap.tenant_name + ':', e.message); }
    }
  } catch (e) { console.error('[Cron] Erro geral 06h30:', e.message); }
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
