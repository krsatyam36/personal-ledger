# Pocket Ledger

A personal finance tracker application designed for offline-first operation with optional cloud sync via MongoDB. Completely client-side driven with a Node.js backend for API services, photo storage, and automated daily backups.

---

## Architecture Overview

The system follows a two-tier architecture:

- **Frontend**: Static HTML/JS application running under nginx, supporting IndexedDB and localStorage for offline data persistence
- **Backend**: Express API server with MongoDB persistence, handling CRUD operations, CSV exports, and daily snapshot backups

```mermaid
flowchart LR
    subgraph Client [Browser / NGINX]
        direction LR
        IDB [IndexedDB Store: photos, tasks]
        LS [localStorage: budget, PIN, themes, scratchpad]
        UI [React-like DOM UI]
    end

    subgraph Server [API Server]
        direction LR
        REST [Express REST Endpoints]
        Mongoose [Mongoose Models: Task, Photo, Meta]
        Mongo [MongoDB Atlas/Local]
        FS [Filesystem: daily JSON backups]
    end

    UI <--> REST <--> Mongoose <--> Mongo
    IDB <-->|savePhotoBlob, getPhotoBlob| REST
    LS <-->|budget, PIN persistence| Server
```

---

## Data Model

### Task (Transaction) Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Unique transaction ID (generated: `tx_` + timestamp + random) |
| `text` | String | Transaction description/merchant name |
| `done` | Boolean | Whether the transaction is settled/done |
| `amount` | Number | Amount in INR (supports `1.5k` → `1500` parsing) |
| `tag` | String | Category hashtag (e.g. `#groceries`, `#dining`) |
| `itemDate` | String | Date in `YYYY-MM-DD` format |
| `photoIds` | [String] | References to attached photo IDs |
| `isLent` | Boolean | Whether this is a lent/split amount IOU |
| `borrowerName` | String | Name of the borrower (when `isLent=true`) |
| `settled` | Boolean | Whether the IOU has been settled |
| `createdAt` | Number | Unix epoch ms |
| `updatedAt` | Number | Unix epoch ms |

### Photo Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Unique photo identifier |
| `base64` | String | Compressed base64-encoded JPEG image |

### Meta Schema

| Key | Value Type | Description |
|-----|------------|-------------|
| `budget` | Number | Monthly budget limit (default: 20000) |
| `recurring` | Array | List of recurring subscription identifiers |
| `version` | Number | Database schema version |

---

## Feature Workflow

### 1. Adding a New Transaction

```mermaid
flowchart TD
    A[User taps FAB +] --> B[Expense sheet opens]
    B --> C[User enters: title, amount, date, tags]
    C --> D{Is Lent?}
    D -- Yes --> E[Show borrower name field]
    D -- No --> F[Skip borrower field]
    E --> G[User adds optional receipt photos]
    G -->| compressReceipt() | H[Base64 compress → JPEG 0.72 quality]
    H --> I[stagedPhotos array]
    I --> J[Save Entry → POST /api/tasks]
    J --> K[Task saved to MongoDB]
    K --> L[IndexedDB cache updated]
    L --> M[LEDGER feed refreshes]
    M --> N[Wallet hero updates: total, progress bar]
```

**Amount parsing** (`parseAmount`): Accepts `377`, `6.5k`, `₹1,200`, all converted to numeric paise/units.

**Smart tag autofill** (`handleTxTitleAutofill`): Scans existing tasks for matching merchant text and auto-selects the previously used hashtag.

### 2. Photo Handling & Storage

Dual-storage strategy with backend API as primary, IndexedDB/localStorage as fallback:

```mermaid
flowchart TD
    A[User selects receipt photo] --> B[compressReceipt: canvas draw, JPEG 0.72 quality]
    B --> C{API /api/photos POST?}
    C -- Success --> D[Save base64 to MongoDB via API]
    D --> E[Cache copy in IndexedDB]
    C -- Fail --> F{Fallback?}
    F -- db exists --> G[Save to IndexedDB objectStore 'photos']
    F -- no db --> H[Save to localStorage as img_{id}]
    G & H --> I[Return true]
    I --> J[Display in staged-photos-strip]
```

**Retrieval priority**: API → IndexedDB → localStorage

### 3. LEDGER Feed Rendering

Tasks are grouped by date (`day-section`), each containing transaction cards (`card-item`):

- **Done transactions**: Strike-through title, muted color, checkmark ✓ in checkbox
- **Pending transactions**: Normal appearance
- **IOU tags**: Special `iou-badge` for lent amounts
- **Settled IOUs**: Green color variant
- **Tag badges**: Colored pill-shaped category tags
- **Multi-thumbnail strip**: Up to 3 receipt photos per transaction card

### 4. AI Analyst Features

Three interactive pills generate data payloads:

| Pill | Function |
|------|----------|
| 📊 Month Breakdown | Generates category distribution data for donut chart |
| 💸 Top Expenses | Lists top N highest-amount transactions |
| 📈 Daily Burn Rate | Calculates average daily spend from month start |

**Donut chart** (`donut-card`): SVG-generated pie chart showing spend distribution across categories. Legend displays each category with color dot + label + total value.

**Edge Gallery payload** (`copyEdgePayload`): Serializes tasks + meta into a format compatible with Google's AI Edge Gallery / Gemma models for on-device analysis.

### 5. PIN Security

- PIN stored in `localStorage` (`pkt_pin`) or `IndexedDB`
- On app start: if PIN exists, lock screen is displayed
- `verifyPin(val)`: compares 4-digit input against stored PIN
- `togglePinSecurity()`: enable/disable PIN from settings drawer

### 6. Theming

Three preset themes controlled via `data-theme` attribute on `<body>`:

| Theme | Variables |
|-------|-----------|
| `dark` | Default dark mode (--bg: #0b0d14) |
| `amoled` | Pure black (#000000) for maximum OLED savings |
| `nord` | Nord color palette (--bg: #242933) |

### 7. Daily Automatic Backups

**Backup daemon** runs on server startup then every 24 hours via `setInterval`:

```mermaid
flowchart TD
    A[Server starts] --> B[seedDatabaseIfEmpty()]
    B --> C[initDailyBackupDaemon()]
    C --> D[runDailySnapshot() immediately]
    D --> E[Fetch tasks, photos, meta from MongoDB]
    E --> F[Construct snapshot JSON]
    F --> G[Write to backup-jsons/pocket_ledger_backup_YYYY-MM-DD.json]
    G --> H[Retention: keep last 7 daily files, prune older]
    H --> I[Log: "Saved daily snapshot: ... (N tasks, M photos)"]
```

**Snapshot contents**:
- `version`, `budget`, `recurring` (from Meta collection)
- `tasks` array (full task documents)
- `photos` object (id → base64 mapping)
- `snapshotTimestamp` (epoch ms)

**Retention policy**: Automatically deletes files beyond the 7 most recent daily backups.

### 8. CSV Tax Export

**Endpoint**: `GET /api/export/csv`

Generates a tax-ready CSV with columns:
`ID,Date,Item,Amount,Tag,Status,HasReceipt,IsLent,Borrower,Settled`

Each row is written via `res.write()` for streaming, then `res.end()`. Includes:
- Receipt presence (Yes/No based on `photoIds` count)
- Status (Done/Pending)
- IsLent (Yes/No)
- Borrower name (when applicable)
- Settled status (Yes/No)

### 9. Settings & Data Drawer

Accessible via ⚙️ header button. Features:

- **Theme switching**: dark / amoled / nord
- **PIN lock**: enable/disable 4-digit app lock
- **Export Spreadsheet**: downloads CSV via `/api/export/csv`
- **Full Backup (with Photos)**: triggers `exportFullJsonBackup()` → downloads JSON snapshot
- **Restore from Backup**: file upload → `importFullJsonBackup()`
- **Data disclaimer**: "Pocket Ledger · 100% Offline Device Storage"

### 10. Bottom Navigation Tabs

Four-tab interface with persistent state:

| Tab | Panel | Key Content |
|-----|-------|-------------|
| 📋 Ledger | `#panelLedger` | Wallet hero, transaction feed, FAB + |
| 🤖 Analyst | `#panelAI` | AI chat, donut chart, category pills |
| 🔁 Recurring | `#panelRecurring` | Monthly subscriptions list |
| 📝 Notes | `#panelNotes` | Free-text notes textarea |

Tab selection persists via URL hash and localStorage; active panel is toggled via CSS `.active` class.

---

## Offline-First Strategy

1. **All CRUD operations** first attempt API calls, then fall back to localStorage/IndexedDB
2. **Photo storage**: API → IndexedDB → localStorage fallback chain
3. **Task recovery**: On startup, tries `/api/tasks` first; if unavailable, restores from `localStorage.pkt_tasks` or `localStorage.v_tasks` with hardcoded recovery entries
4. **Budget/pin/theme**: Stored in `localStorage` with `pkt_` prefix
5. **PIN security**: Optional; if not set, app starts unlocked

---

## Development & Deployment

### Local Development

```bash
# Start MongoDB + API + NGINX via Docker Compose
docker-compose up -d

# Or start backend only
cd backend && node server.js

# Frontend available at http://localhost:8080
```

### Docker Services

| Service | Role | Port |
|---------|------|------|
| `mongo` | MongoDB 6 | 27017 |
| `api` | Express/Node.js backend | 8080 |
| (nginx implied) | Static file server | 8080 |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | API server port |
| `MONGO_URI` | `mongodb://mongo:27017/personal_ledger` | MongoDB connection string |
| `STATIC_PATH` | `/app/src` | Path to frontend static files |

### API Endpoints Summary

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tasks` | Fetch all tasks (sorted by createdAt desc) |
| `GET` | `/api/tasks/:id` | Fetch single task by ID |
| `POST` | `/api/tasks` | Create new task |
| `PUT` | `/api/tasks/:id` | Update task (full replace) |
| `DELETE` | `/api/tasks/:id` | Delete task |
| `GET` | `/api/photos` | List all photo IDs |
| `GET` | `/api/photos/:id` | Fetch single photo |
| `POST` | `/api/photos` | Save photo (id + base64) |
| `DELETE` | `/api/photos/:id` | Delete photo |
| `GET` | `/api/meta` | Fetch all meta key-value pairs |
| `GET` | `/api/meta/:key` | Fetch single meta key |
| `POST` | `/api/meta` | Update/create meta entries |
| `PUT` | `/api/meta/:key` | Update meta key value |
| `GET` | `/api/export/csv` | Tax-ready CSV export |

### Seeding on First Start

On initial server launch (`taskCount === 0`), the server attempts to auto-seed from backup JSON files in this priority order:

1. `./backup.json` (local)
2. `./backup-jsons/pocket_ledger_backup_2026-09-04.json`
3. `./backup-jsons/pocket_ledger_backup_2026-09-04 (3).json`

Seeded data includes `Meta` (budget, recurring, version) and `Tasks` + `Photos` collections.

### Prerequisites

- Node.js ≥ 18
- MongoDB (local or Atlas)
- Docker (optional, for docker-compose setup)
- Browser with IndexedDB support (Chrome, Firefox, Edge, Safari)