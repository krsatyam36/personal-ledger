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
const TaskSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  text: { type: String, default: '' },
  done: { type: Boolean, default: false },
  amount: { type: Number, default: 0 },
  tag: { type: String, default: '' },
  itemDate: { type: String, default: '' },
  photoIds: { type: [String], default: [] },
  createdAt: { type: Number, default: () => Date.now() },
  updatedAt: { type: Number, default: () => Date.now() }
}, { versionKey: false });

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

// POST / PUT update meta (accepts object or single key)
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

// --- Seeding MongoDB Function ---
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
      path.resolve(__dirname, 'backup-jsons/pocket_ledger_backup_2026-09-04.json')
    ];

    let backupFile = backupPaths.find(p => fs.existsSync(p));

    if (!backupFile) {
      console.warn('[Seed] Backup file pocket_ledger_backup_2026-09-04.json not found. Checked:', backupPaths);
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

// Connect to MongoDB and start server
async function start() {
  try {
    console.log(`Connecting to MongoDB at ${MONGO_URI}...`);
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB.');

    await seedDatabaseIfEmpty();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`personal-ledger server running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
