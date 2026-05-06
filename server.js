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

  // Arquivos estáticos públicos (imagens dos QR Codes, etc) — bypass do tenant
  if (req.path.match(/\.(png|jpg|jpeg|gif|ico|svg|webp)$/i)) {
    return next();
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

// Rotas estáticas dos QR Codes Pix — antes do tenantMiddleware
app.get('/pix-qr/setup',   (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'pix-setup.png')));
app.get('/pix-qr/monthly', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'pix-monthly.png')));

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
             t.monthly_fee, t.setup_fee, t.created_at, t.exempt, t.trial_ends_at,
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
    const payment = rows[0];

    // Ao marcar como pago: ativa tenant e atualiza vencimento
    if (status === 'paid') {
      if (payment.type === 'monthly') {
        const nextExpiry = new Date(paid_at || todayBrasilia());
        nextExpiry.setMonth(nextExpiry.getMonth() + 1);
        const expiryStr = nextExpiry.toISOString().slice(0,10);
        await pool.query(
          `UPDATE tenants SET active=TRUE, plan_expires_at=$1 WHERE id=$2`,
          [expiryStr, payment.tenant_id]
        );
        await logAction(payment.tenant_id, 'payment_confirmed',
          `Mensalidade confirmada via painel. Novo vencimento: ${expiryStr}`);
      } else if (payment.type === 'setup') {
        // Implantação paga: ativa tenant + inicia ciclo de 30 dias para 1ª mensalidade
        const setupExpiry = new Date(paid_at || todayBrasilia());
        setupExpiry.setDate(setupExpiry.getDate() + 30);
        const setupExpiryStr = setupExpiry.toISOString().slice(0,10);
        await pool.query(
          `UPDATE tenants SET active=TRUE, plan_expires_at=$1 WHERE id=$2`,
          [setupExpiryStr, payment.tenant_id]
        );
        await logAction(payment.tenant_id, 'setup_payment_confirmed',
          `Implantação confirmada. Tenant ativado. 1ª mensalidade vence em: ${setupExpiryStr}`);
      }
      _tenantCache.clear();
    }

    res.json(payment);
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
        -- Se isento: ativa imediatamente e limpa trial/vencimento
        active = CASE WHEN $1=TRUE THEN TRUE ELSE active END,
        trial_ends_at = CASE WHEN $1=TRUE THEN NULL ELSE trial_ends_at END,
        plan_expires_at = CASE WHEN $1=TRUE THEN NULL ELSE plan_expires_at END
       WHERE id=$2 RETURNING slug, exempt, active, plan_expires_at, trial_ends_at`,
      [exempt, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant não encontrado' });
    _tenantCache.clear();

    // Removendo isenção → inicia ciclo de cobrança imediatamente
    if (!exempt) {
      // Seta plan_expires_at = hoje + 30 dias (primeira mensalidade)
      const firstExpiry = new Date(todayBrasilia());
      firstExpiry.setDate(firstExpiry.getDate() + 30);
      const firstExpiryStr = firstExpiry.toISOString().slice(0,10);
      await pool.query(
        `UPDATE tenants SET plan_expires_at=$1 WHERE id=$2`,
        [firstExpiryStr, req.params.id]
      );

      // Cria cobrança de mensalidade pendente imediatamente
      const refMonth = firstExpiryStr.slice(0,7);
      const { rows: existPay } = await pool.query(
        `SELECT id FROM payments WHERE tenant_id=$1 AND type='monthly' AND reference_month=$2 LIMIT 1`,
        [req.params.id, refMonth]
      );
      if (!existPay.length) {
        const { rows: payRows } = await pool.query(
          `INSERT INTO payments (tenant_id,type,amount,status,reference_month,notes)
           VALUES ($1,'monthly',149.00,'pending',$2,'Gerado ao remover isenção — 1ª mensalidade')
           RETURNING *`,
          [req.params.id, refMonth]
        );
        // Busca dados do tenant para enviar email
        const { rows: tData } = await pool.query(
          `SELECT t.owner_email, t.owner_name, t.name as tenant_name, tc.business_name
           FROM tenants t LEFT JOIN tenant_configs tc ON tc.tenant_id=t.id
           WHERE t.id=$1`, [req.params.id]
        );
        if (tData.length) {
          const payData = { ...payRows[0], ...tData[0] };
          sendPaymentEmail(payData).catch(e =>
            console.error('[Exempt→Paid] Erro email mensalidade:', e.message)
          );
        }
      }
      await logAction(req.params.id, 'tenant_unexempted',
        `Isenção removida. 1ª mensalidade vence em ${firstExpiryStr}. Email de cobrança enviado.`);
    } else {
      await logAction(req.params.id, 'tenant_exempted',
        `Tenant ${rows[0].slug} marcado como ISENTO`);
    }

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

async function sendPaymentEmail(p) {
  const pixCopyPaste = p.type === 'setup' ? PIX_SETUP_COPY : PIX_MONTHLY_COPY;
  const typeLabel    = p.type === 'setup' ? 'Implantação' : 'Mensalidade';
  const amountFmt    = `R$ ${Number(p.amount).toFixed(2).replace('.', ',')}`;
  const businessName = p.business_name || p.tenant_name;
  const ownerName    = p.owner_name || 'Profissional';

  const baseUrl   = (process.env.MASTER_BASE_URL || '').replace(/\/$/, '');
  const qrPath    = p.type === 'setup' ? '/pix-qr/setup' : '/pix-qr/monthly';
  const qrBlock   = baseUrl
    ? `<div style="text-align:center;margin:24px 0">
         <img src="${baseUrl}${qrPath}" alt="QR Code Pix" width="220" height="220" style="width:220px;height:220px;border-radius:12px;border:1px solid #E8D5DE;display:block;margin:0 auto">
       </div>`
    : '';

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
                BETWEEN (NOW() AT TIME ZONE 'America/Sao_Paulo') + INTERVAL '28 minutes'
                    AND (NOW() AT TIME ZONE 'America/Sao_Paulo') + INTERVAL '32 minutes'
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
