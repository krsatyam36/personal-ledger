const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/personal_ledger';

// --- SECURITY HARDENING & DEFENSE IN DEPTH ---
// 1. Strict CORS policy: Allow only local web frontend
const allowedOrigins = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser agents (like curl, background daemons) and local origins
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Blocked by CORS policy: Unauthorized origin.'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// 2. Security Headers (Anti-Clickjacking, MIME-Sniffing, XSS protection)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://localhost:11434 http://127.0.0.1:11434;");
  next();
});

// 3. NoSQL Injection Guard: strip dangerous keys like $where, $ne, $gt, etc.
function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
    } else if (typeof obj[key] === 'object') {
      sanitizeObject(obj[key]);
    }
  }
  return obj;
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    sanitizeObject(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    sanitizeObject(req.query);
  }
  next();
});

// --- Mongoose Schemas & Models ---
// Strict: false allows optional fields like isLent, borrowerName, settled without altering existing documents
const TaskSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  text: { type: String, default: '' },
  done: { type: Boolean, default: false },
  amount: { type: Number, default: 0 },
  tag: { type: String, default: '' },
  itemDate: { type: String, default: '' },
  photoIds: { type: [String], default: [] },
  isLent: { type: Boolean, default: false },
  borrowerName: { type: String, default: '' },
  settled: { type: Boolean, default: false },
  createdAt: { type: Number, default: () => Date.now() },
  updatedAt: { type: Number, default: () => Date.now() }
}, { versionKey: false, strict: false });

const PhotoSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  base64: { type: String, required: true }
}, { versionKey: false });

const MetaSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed }
}, { versionKey: false });

const Task = mongoose.model('Task', TaskSchema);
const Photo = mongoose.model('Photo', PhotoSchema);
const Meta = mongoose.model('Meta', MetaSchema);

// --- Static Frontend Files ---
const staticPath = path.resolve(__dirname, process.env.STATIC_PATH || '../src');
app.use(express.static(staticPath));

// --- FEATURE 4: Server-Side Tax-Ready CSV Export Endpoint ---
app.get('/api/export/csv', async (req, res) => {
  try {
    const tasks = await Task.find({}).sort({ itemDate: -1, createdAt: -1 });

    const escapeCsvField = (field) => {
      if (field === null || field === undefined) return '""';
      const str = String(field).replace(/"/g, '""');
      return `"${str}"`;
    };

    const todayStr = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pocket_ledger_tax_export_${todayStr}.csv"`);

    // Stream header
    res.write('ID,Date,Item,Amount,Tag,Status,HasReceipt,IsLent,Borrower,Settled\n');

    for (const t of tasks) {
      const hasReceipt = (Array.isArray(t.photoIds) && t.photoIds.length > 0) ? 'Yes' : 'No';
      const status = t.done ? 'Done' : 'Pending';
      const isLent = t.isLent ? 'Yes' : 'No';
      const borrower = t.borrowerName || '';
      const settled = t.settled ? 'Yes' : 'No';

      const line = [
        escapeCsvField(t.id),
        escapeCsvField(t.itemDate || ''),
        escapeCsvField(t.text || ''),
        t.amount || 0,
        escapeCsvField(t.tag || ''),
        escapeCsvField(status),
        escapeCsvField(hasReceipt),
        escapeCsvField(isLent),
        escapeCsvField(borrower),
        escapeCsvField(settled)
      ].join(',') + '\n';

      res.write(line);
    }

    res.end();
  } catch (err) {
    console.error('CSV export failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to export CSV: ' + err.message });
    }
  }
});

// --- Tasks CRUD Endpoints ---
// GET all tasks
app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await Task.find({}).sort({ createdAt: -1 });
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single task
app.get('/api/tasks/:id', async (req, res) => {
  try {
    const task = await Task.findOne({ id: req.params.id });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create task
app.post('/api/tasks', async (req, res) => {
  try {
    const taskData = req.body;
    if (!taskData.id) {
      taskData.id = 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    }
    const task = new Task(taskData);
    await task.save();
    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT / PATCH update task
app.put('/api/tasks/:id', async (req, res) => {
  try {
    const updated = await Task.findOneAndUpdate(
      { id: req.params.id },
      { ...req.body, updatedAt: req.body.updatedAt || Date.now() },
      { new: true, upsert: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE single task
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const deleted = await Task.findOneAndDelete({ id: req.params.id });
    if (!deleted) return res.status(404).json({ error: 'Task not found' });
    res.json({ message: 'Task deleted', task: deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Photos CRUD Endpoints ---
// GET all photo IDs
app.get('/api/photos', async (req, res) => {
  try {
    const photos = await Photo.find({}, 'id');
    res.json(photos.map(p => p.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single photo
app.get('/api/photos/:id', async (req, res) => {
  try {
    const photo = await Photo.findOne({ id: req.params.id });
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    res.json(photo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST save photo
app.post('/api/photos', async (req, res) => {
  try {
    const { id, base64 } = req.body;
    if (!id || !base64) return res.status(400).json({ error: 'id and base64 required' });
    const photo = await Photo.findOneAndUpdate(
      { id },
      { id, base64 },
      { new: true, upsert: true }
    );
    res.status(201).json({ id: photo.id, message: 'Photo saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE single photo
app.delete('/api/photos/:id', async (req, res) => {
  try {
    const deleted = await Photo.findOneAndDelete({ id: req.params.id });
    if (!deleted) return res.status(404).json({ error: 'Photo not found' });
    res.json({ message: 'Photo deleted', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Meta CRUD Endpoints ---
// GET meta
app.get('/api/meta', async (req, res) => {
  try {
    const entries = await Meta.find({});
    const result = {};
    entries.forEach(e => { result[e.key] = e.value; });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single meta key
app.get('/api/meta/:key', async (req, res) => {
  try {
    const entry = await Meta.findOne({ key: req.params.key });
    if (!entry) return res.status(404).json({ error: 'Key not found' });
    res.json({ key: entry.key, value: entry.value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / PUT update meta
app.post('/api/meta', async (req, res) => {
  try {
    const data = req.body;
    if (data.key !== undefined && data.value !== undefined) {
      await Meta.findOneAndUpdate({ key: data.key }, { value: data.value }, { upsert: true });
    } else {
      for (const [k, v] of Object.entries(data)) {
        await Meta.findOneAndUpdate({ key: k }, { value: v }, { upsert: true });
      }
    }
    const entries = await Meta.find({});
    const result = {};
    entries.forEach(e => { result[e.key] = e.value; });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/meta/:key', async (req, res) => {
  try {
    const { value } = req.body;
    const entry = await Meta.findOneAndUpdate(
      { key: req.params.key },
      { value },
      { new: true, upsert: true }
    );
    res.json({ key: entry.key, value: entry.value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback to index.html for SPA/frontend routes
app.get('*', (req, res) => {
  res.sendFile(path.join(staticPath, 'index.html'));
});

// --- Seeding MongoDB Function (Initial Boot Only) ---
async function seedDatabaseIfEmpty() {
  try {
    const taskCount = await Task.countDocuments();
    if (taskCount > 0) {
      console.log(`[Seed] Database already has ${taskCount} tasks. Skipping initial seed.`);
      return;
    }

    const backupPaths = [
      path.resolve(__dirname, 'backup.json'),
      path.resolve(__dirname, '../backup-jsons/pocket_ledger_backup_2026-09-04.json'),
      path.resolve(__dirname, 'backup-jsons/pocket_ledger_backup_2026-09-04.json'),
      path.resolve(__dirname, '../backup-jsons/pocket_ledger_backup_2026-09-04 (3).json'),
      path.resolve(__dirname, 'backup-jsons/pocket_ledger_backup_2026-09-04 (3).json')
    ];

    let backupFile = backupPaths.find(p => fs.existsSync(p));

    if (!backupFile) {
      console.warn('[Seed] Backup file not found. Checked:', backupPaths);
      return;
    }

    console.log(`[Seed] Initializing seed from ${backupFile}...`);
    const data = JSON.parse(fs.readFileSync(backupFile, 'utf8'));

    // Seed Meta (budget, recurring, version)
    if (data.budget !== undefined) {
      await Meta.findOneAndUpdate({ key: 'budget' }, { value: data.budget }, { upsert: true });
    }
    if (data.recurring !== undefined) {
      await Meta.findOneAndUpdate({ key: 'recurring' }, { value: data.recurring }, { upsert: true });
    }
    if (data.version !== undefined) {
      await Meta.findOneAndUpdate({ key: 'version' }, { value: data.version }, { upsert: true });
    }

    // Seed Tasks
    if (Array.isArray(data.tasks) && data.tasks.length > 0) {
      const taskOps = data.tasks.map(t => ({
        updateOne: {
          filter: { id: t.id },
          update: { $set: t },
          upsert: true
        }
      }));
      await Task.bulkWrite(taskOps);
      console.log(`[Seed] Successfully seeded ${data.tasks.length} tasks.`);
    }

    // Seed Photos
    if (data.photos && typeof data.photos === 'object') {
      const photoEntries = Object.entries(data.photos);
      if (photoEntries.length > 0) {
        const photoOps = photoEntries.map(([id, base64]) => ({
          updateOne: {
            filter: { id },
            update: { $set: { id, base64 } },
            upsert: true
          }
        }));
        await Photo.bulkWrite(photoOps);
        console.log(`[Seed] Successfully seeded ${photoEntries.length} photos.`);
      }
    }

    console.log('[Seed] Database initialization complete.');
  } catch (err) {
    console.error('[Seed] Error during seeding:', err);
  }
}

// --- FEATURE 3: Automated 6-Hour DB Snapshots (JSON Backup Daemon) ---
function getSnapshotTimestampStrings(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());

  const timeStr = `${hours}-${minutes}-${seconds}`;
  const dateStr = `${year}-${month}-${day}`;
  return { timeStr, dateStr };
}

async function runBackupSnapshot() {
  try {
    const backupDir = path.resolve(__dirname, '../backup-jsons');
    const altBackupDir = path.resolve(__dirname, 'backup-jsons');
    const targetDir = fs.existsSync(backupDir) ? backupDir : (fs.existsSync(altBackupDir) ? altBackupDir : backupDir);

    if (!fs.existsSync(targetDir)) {
      try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {}
    }

    const { timeStr, dateStr } = getSnapshotTimestampStrings();
    // Naming convention requested: time-date-backup.json (e.g. 16-52-00-2026-09-05-backup.json)
    const targetFileName = `${timeStr}-${dateStr}-backup.json`;
    const targetFilePath = path.join(targetDir, targetFileName);

    // Fetch complete collections with all base64 photo data
    const [tasks, photosList, metaList] = await Promise.all([
      Task.find({}).lean(),
      Photo.find({}).lean(),
      Meta.find({}).lean()
    ]);

    const photosObj = {};
    photosList.forEach(p => { photosObj[p.id] = p.base64; });

    let budget = 20000;
    let recurring = [];
    let version = 9;

    metaList.forEach(m => {
      if (m.key === 'budget') budget = m.value;
      if (m.key === 'recurring') recurring = m.value;
      if (m.key === 'version') version = m.value;
    });

    const snapshot = {
      version,
      budget,
      recurring,
      tasks,
      photos: photosObj,
      snapshotTimestamp: Date.now(),
      generatedAt: new Date().toISOString()
    };

    fs.writeFileSync(targetFilePath, JSON.stringify(snapshot, null, 2), 'utf8');
    console.log(`[BackupDaemon] Saved 6-hour snapshot: ${targetFilePath} (${tasks.length} tasks, ${photosList.length} photos)`);

    // Retention policy: Keep the last 28 snapshots (7 full days @ 4 snapshots/day)
    try {
      const files = fs.readdirSync(targetDir);
      const backupFiles = files
        .filter(f => (f.endsWith('-backup.json') || f.startsWith('pocket_ledger_backup_')) && f.endsWith('.json'))
        .map(f => ({
          name: f,
          path: path.join(targetDir, f),
          time: fs.statSync(path.join(targetDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

      if (backupFiles.length > 28) {
        const toDelete = backupFiles.slice(28);
        for (const item of toDelete) {
          try {
            fs.unlinkSync(item.path);
            console.log(`[BackupDaemon] Pruned old backup: ${item.name}`);
          } catch (e) {
            console.warn(`[BackupDaemon] Could not prune ${item.name}:`, e.message);
          }
        }
      }
    } catch (cleanErr) {
      console.warn('[BackupDaemon] Error pruning backups:', cleanErr.message);
    }
  } catch (err) {
    console.error('[BackupDaemon] Snapshot failed:', err);
  }
}

function initSixHourBackupDaemon() {
  // 1. Run immediately starting right now
  runBackupSnapshot();

  // 2. Schedule every 6 hours (6 * 60 * 60 * 1000 = 21,600,000 ms)
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  setInterval(() => {
    runBackupSnapshot();
  }, SIX_HOURS_MS);
}

// Connect to MongoDB and start server
async function start() {
  try {
    console.log(`Connecting to MongoDB at ${MONGO_URI}...`);
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB.');

    await seedDatabaseIfEmpty();

    // Start background 6-hour snapshot daemon
    initSixHourBackupDaemon();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`personal-ledger server running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
