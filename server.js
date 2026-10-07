require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const root = __dirname;
const dataDir = path.join(root, 'data');
const uploadDir = path.join(root, 'public', 'uploads');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const db = new sqlite3.Database(
  path.join(dataDir, 'fahims-dark-house.sqlite3')
);

const run = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      err
        ? reject(err)
        : resolve({ id: this.lastID, changes: this.changes });
    })
  );

const get = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.get(sql, params, (e, r) => (e ? reject(e) : resolve(r)))
  );

const all = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (e, r) => (e ? reject(e) : resolve(r)))
  );

async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS admins(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS posts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      image TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS products(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price REAL NOT NULL,
      stock INTEGER DEFAULT 0,
      image TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS videos(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      thumbnail TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS orders(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT DEFAULT '',
      qty INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT DEFAULT 'New'
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const admin = await get('SELECT id FROM admins LIMIT 1');

  if (!admin) {
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    const password =
      process.env.ADMIN_PASSWORD ||
      crypto.randomBytes(12).toString('base64url');

    await run(
      'INSERT INTO admins(email,password_hash,created_at) VALUES(?,?,?)',
      [
        email,
        await bcrypt.hash(password, 12),
        new Date().toISOString()
      ]
    );

    console.log(`\nInitial admin email: ${email}`);

    if (!process.env.ADMIN_PASSWORD) {
      console.log(`Initial admin password: ${password}`);
    }

    console.log('Change the password after first login.\n');
  }

  const defaults = {
    brand: "FAHIM'S DARK HOUSE",
    tagline: 'A Dark World Of Creativity',
    subtag: 'Content, Creativity & Business...',
    name: 'Nadimul Islam Fahim',
    about: 'A Professional Business Men & IT Developer...',
    phone: '+8801608633425',
    email: 'Fahimkhanfamu@gmail.com',
    whatsapp: '+8801608633425',
    facebook: 'https://www.facebook.com/kitkat.fahim.26',
    instagram: 'https://www.instagram.com/fams_famu',
    youtube: '',
    tiktok: '',
    bkash: '01608633425',
    nagad: '',
    logoText: "FAHIM'S DARK HOUSE"
  };

  for (const [k, v] of Object.entries(defaults)) {
    await run(
      'INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)',
      [k, v]
    );
  }
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    const safe = crypto.randomBytes(10).toString('hex') + ext;
    cb(null, safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime))$/.test(
        file.mimetype
      );

    cb(
      ok ? null : new Error('Only image and supported video files are allowed.'),
      ok
    );
  }
});

app.use(
  session({
    store: new SQLiteStore({
      db: 'sessions.sqlite3',
      dir: dataDir
    }),
    secret: process.env.SESSION_SECRET || 'dev-only-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

app.use(express.static(path.join(root, 'public')));

function auth(req, res, next) {
  if (req.session.adminId) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function cleanUrl(v) {
  return typeof v === 'string' && /^https:\/\//i.test(v) ? v : '';
}

app.get('/api/site', async (req, res) => {
  const rows = await all('SELECT key,value FROM settings');
  const site = Object.fromEntries(rows.map(x => [x.key, x.value]));
  res.json(site);
});

app.get('/api/posts', async (req, res) =>
  res.json(await all('SELECT * FROM posts ORDER BY id DESC'))
);

app.get('/api/products', async (req, res) =>
  res.json(await all('SELECT * FROM products ORDER BY id DESC'))
);

app.get('/api/videos', async (req, res) =>
  res.json(await all('SELECT * FROM videos ORDER BY id DESC'))
);

app.post('/api/orders', async (req, res) => {
  const { product_id, name, phone, address = '', qty = 1 } = req.body;

  if (!product_id || !name || !phone || Number(qty) < 1) {
    return res.status(400).json({
      error: 'Name, phone, product and quantity are required.'
    });
  }

  const p = await get('SELECT * FROM products WHERE id=?', [product_id]);

  if (!p) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const q = Math.min(Number(qty), Math.max(1, p.stock || 1));

  await run(
    'INSERT INTO orders(product_id,name,phone,address,qty,created_at,status) VALUES(?,?,?,?,?,?,?)',
    [
      product_id,
      name,
      phone,
      address,
      q,
      new Date().toISOString(),
      'New'
    ]
  );

  res.json({
    ok: true,
    message: 'Order received'
  });
});

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;

  const a = await get(
    'SELECT * FROM admins WHERE lower(email)=lower(?)',
    [email || '']
  );

  if (
    !a ||
    !(await bcrypt.compare(password || '', a.password_hash))
  ) {
    return res.status(401).json({ error: 'Invalid login' });
  }

  req.session.adminId = a.id;
  req.session.adminEmail = a.email;

  res.json({
    ok: true,
    email: a.email
  });
});

app.post('/api/admin/logout', (req, res) =>
  req.session.destroy(() => res.json({ ok: true }))
);

app.get('/api/admin/me', auth, (req, res) =>
  res.json({ email: req.session.adminEmail })
);

app.post('/api/admin/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!newPassword || newPassword.length < 10) {
    return res.status(400).json({
      error: 'New password must be at least 10 characters.'
    });
  }

  const a = await get(
    'SELECT * FROM admins WHERE id=?',
    [req.session.adminId]
  );

  if (
    !a ||
    !(await bcrypt.compare(currentPassword || '', a.password_hash))
  ) {
    return res.status(400).json({
      error: 'Current password is incorrect.'
    });
  }

  await run(
    'UPDATE admins SET password_hash=? WHERE id=?',
    [await bcrypt.hash(newPassword, 12), a.id]
  );

  res.json({ ok: true });
});

/*
  ADMIN PASSWORD RESET
  Uses the live Render website instead of localhost.
*/

app.post('/api/admin/forgot-password', async (req, res) => {
  const { email } = req.body;

  const a = await get(
    'SELECT * FROM admins WHERE lower(email)=lower(?)',
    [email || '']
  );

  if (a) {
    const token = crypto.randomBytes(32).toString('hex');

    const hash = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    await run(`
      CREATE TABLE IF NOT EXISTS reset_tokens(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER,
        token_hash TEXT,
        expires_at TEXT
      )
    `);

    await run(
      'DELETE FROM reset_tokens WHERE admin_id=?',
      [a.id]
    );

    await run(
      'INSERT INTO reset_tokens(admin_id,token_hash,expires_at) VALUES(?,?,?)',
      [
        a.id,
        hash,
        new Date(Date.now() + 15 * 60 * 1000).toISOString()
      ]
    );

    /*
      FIXED:
      Always generate the reset link using the live website.
    */
    const link =
      `https://fahims-dark-house.onrender.com/admin/reset.html?token=${token}`;

    if (process.env.SMTP_HOST) {
      const t = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure:
          Number(process.env.SMTP_PORT || 587) === 465,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });

      await t.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: a.email,
        subject: "FAHIM'S DARK HOUSE password reset",
        text:
          `Reset your admin password: ${link}\n` +
          `This link expires in 15 minutes.`
      });
    } else {
      console.log(
        `PASSWORD RESET LINK for ${a.email}: ${link}`
      );
    }
  }

  res.json({
    message:
      'If that email belongs to an admin, a reset link has been sent.'
  });
});

app.post('/api/admin/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  if (
    !token ||
    !newPassword ||
    newPassword.length < 10
  ) {
    return res.status(400).json({
      error: 'Invalid request'
    });
  }

  const hash = crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

  const r = await get(
    'SELECT * FROM reset_tokens WHERE token_hash=? AND expires_at>?',
    [hash, new Date().toISOString()]
  );

  if (!r) {
    return res.status(400).json({
      error: 'Reset link is invalid or expired.'
    });
  }

  await run(
    'UPDATE admins SET password_hash=? WHERE id=?',
    [await bcrypt.hash(newPassword, 12), r.admin_id]
  );

  await run(
    'DELETE FROM reset_tokens WHERE id=?',
    [r.id]
  );

  res.json({ ok: true });
});

app.post(
  '/api/admin/upload',
  auth,
  upload.single('file'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded.'
      });
    }

    res.json({
      ok: true,
      url: '/uploads/' + req.file.filename,
      originalName: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size
    });
  }
);

app.put('/api/admin/settings', auth, async (req, res) => {
  const allowed = [
    'brand',
    'tagline',
    'subtag',
    'name',
    'about',
    'phone',
    'email',
    'whatsapp',
    'facebook',
    'instagram',
    'youtube',
    'tiktok',
    'bkash',
    'nagad'
  ];

  for (const k of allowed) {
    if (k in req.body) {
      await run(
        `INSERT INTO settings(key,value)
         VALUES(?,?)
         ON CONFLICT(key)
         DO UPDATE SET value=excluded.value`,
        [k, String(req.body[k] ?? '')]
      );
    }
  }

  res.json({ ok: true });
});

app.post('/api/admin/posts', auth, async (req, res) => {
  const { title, body, image = '' } = req.body;

  if (!title || !body) {
    return res.status(400).json({
      error: 'Title and body are required'
    });
  }

  const r = await run(
    'INSERT INTO posts(title,body,image,created_at) VALUES(?,?,?,?)',
    [
      title,
      body,
      image,
      new Date().toISOString()
    ]
  );

  res.json(
    await get(
      'SELECT * FROM posts WHERE id=?',
      [r.id]
    )
  );
});

app.put('/api/admin/posts/:id', auth, async (req, res) => {
  const { title, body, image = '' } = req.body;

  if (!title || !body) {
    return res.status(400).json({
      error: 'Title and body are required'
    });
  }

  await run(
    'UPDATE posts SET title=?,body=?,image=? WHERE id=?',
    [title, body, image, req.params.id]
  );

  res.json(
    await get(
      'SELECT * FROM posts WHERE id=?',
      [req.params.id]
    )
  );
});

app.delete('/api/admin/posts/:id', auth, async (req, res) => {
  await run(
    'DELETE FROM posts WHERE id=?',
    [req.params.id]
  );

  res.json({ ok: true });
});

app.post('/api/admin/products', auth, async (req, res) => {
  const {
    name,
    description = '',
    price,
    stock = 0,
    image = ''
  } = req.body;

  if (
    !name ||
    Number.isNaN(Number(price))
  ) {
    return res.status(400).json({
      error: 'Product name and price are required'
    });
  }

  const r = await run(
    `INSERT INTO products
     (name,description,price,stock,image,created_at)
     VALUES(?,?,?,?,?,?)`,
    [
      name,
      description,
      Number(price),
      Number(stock),
      image,
      new Date().toISOString()
    ]
  );

  res.json(
    await get(
      'SELECT * FROM products WHERE id=?',
      [r.id]
    )
  );
});

app.put('/api/admin/products/:id', auth, async (req, res) => {
  const {
    name,
    description = '',
    price,
    stock = 0,
    image = ''
  } = req.body;

  if (
    !name ||
    Number.isNaN(Number(price))
  ) {
    return res.status(400).json({
      error: 'Product name and price are required'
    });
  }

  await run(
    `UPDATE products
     SET name=?,description=?,price=?,stock=?,image=?
     WHERE id=?`,
    [
      name,
      description,
      Number(price),
      Number(stock),
      image,
      req.params.id
    ]
  );

  res.json(
    await get(
      'SELECT * FROM products WHERE id=?',
      [req.params.id]
    )
  );
});

app.delete('/api/admin/products/:id', auth, async (req, res) => {
  await run(
    'DELETE FROM products WHERE id=?',
    [req.params.id]
  );

  res.json({ ok: true });
});

app.post('/api/admin/videos', auth, async (req, res) => {
  const {
    title,
    url,
    thumbnail = ''
  } = req.body;

  if (!title || !url) {
    return res.status(400).json({
      error: 'Video title and URL are required'
    });
  }

  const r = await run(
    `INSERT INTO videos
     (title,url,thumbnail,created_at)
     VALUES(?,?,?,?)`,
    [
      title,
      url,
      thumbnail,
      new Date().toISOString()
    ]
  );

  res.json(
    await get(
      'SELECT * FROM videos WHERE id=?',
      [r.id]
    )
  );
});

app.delete('/api/admin/videos/:id', auth, async (req, res) => {
  await run(
    'DELETE FROM videos WHERE id=?',
    [req.params.id]
  );

  res.json({ ok: true });
});

app.get('/api/admin/orders', auth, async (req, res) =>
  res.json(
    await all(`
      SELECT o.*,p.name product_name
      FROM orders o
      LEFT JOIN products p ON p.id=o.product_id
      ORDER BY o.id DESC
    `)
  )
);

app.patch('/api/admin/orders/:id', auth, async (req, res) => {
  const statuses = [
    'New',
    'Confirmed',
    'Processing',
    'Shipped',
    'Completed',
    'Cancelled'
  ];

  if (!statuses.includes(req.body.status)) {
    return res.status(400).json({
      error: 'Invalid status'
    });
  }

  await run(
    'UPDATE orders SET status=? WHERE id=?',
    [req.body.status, req.params.id]
  );

  res.json({ ok: true });
});

app.get('/admin', (req, res) =>
  res.sendFile(
    path.join(root, 'public/admin/index.html')
  )
);

app.get('/admin/reset.html', (req, res) =>
  res.sendFile(
    path.join(root, 'public/admin/reset.html')
  )
);

init()
  .then(() =>
    app.listen(PORT, () =>
      console.log(
        `FAHIM'S DARK HOUSE running at http://localhost:${PORT}`
      )
    )
  )
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
