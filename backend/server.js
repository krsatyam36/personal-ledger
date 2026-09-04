const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/personal_ledger';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

// --- FEATURE 3: Automated Daily DB Snapshots (JSON Backup Daemon) ---
async function runDailyBackupSnapshot() {
  try {
    const backupDir = path.resolve(__dirname, '../backup-jsons');
    const altBackupDir = path.resolve(__dirname, 'backup-jsons');
    const targetDir = fs.existsSync(backupDir) ? backupDir : (fs.existsSync(altBackupDir) ? altBackupDir : backupDir);

    if (!fs.existsSync(targetDir)) {
      try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {}
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const targetFileName = `pocket_ledger_backup_${todayStr}.json`;
    const targetFilePath = path.join(targetDir, targetFileName);

    // Fetch collections
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
      snapshotTimestamp: Date.now()
    };

    fs.writeFileSync(targetFilePath, JSON.stringify(snapshot, null, 2), 'utf8');
    console.log(`[BackupDaemon] Saved daily snapshot: ${targetFilePath} (${tasks.length} tasks, ${photosList.length} photos)`);

    // Retention policy: Keep only the last 7 daily backup files
    try {
      const files = fs.readdirSync(targetDir);
      const backupFiles = files
        .filter(f => f.startsWith('pocket_ledger_backup_') && f.endsWith('.json'))
        .map(f => ({
          name: f,
          path: path.join(targetDir, f),
          time: fs.statSync(path.join(targetDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

      if (backupFiles.length > 7) {
        const toDelete = backupFiles.slice(7);
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

function initDailyBackupDaemon() {
  // Run on startup
  runDailyBackupSnapshot();
  // Schedule every 24 hours (86,400,000 ms)
  setInterval(() => {
    runDailyBackupSnapshot();
  }, 24 * 60 * 60 * 1000);
}

// Connect to MongoDB and start server
async function start() {
  try {
    console.log(`Connecting to MongoDB at ${MONGO_URI}...`);
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB.');

    await seedDatabaseIfEmpty();

    // Start background daily snapshot daemon
    initDailyBackupDaemon();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`personal-ledger server running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
