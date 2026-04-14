require('dotenv').config();
const express  = require('express');
const multer   = require('multer');
const axios    = require('axios');
const FormData = require('form-data');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');

const app  = express();
const PORT = 5000;

// ── CORS ─────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(__dirname));

// ── Keys ─────────────────────────────────────────
const SE_USER   = process.env.SE_USER   || '';
const SE_SECRET = process.env.SE_SECRET || '';

// ── File Upload ───────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, crypto.randomBytes(8).toString('hex') + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/quicktime'];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error('Invalid file type. Use JPG/PNG/MP4'));
  }
});

// ── DB ────────────────────────────────────────────
let casesDB = [];
const DB_FILE = path.join(__dirname, 'cases.json');
if (fs.existsSync(DB_FILE)) {
  try { casesDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { casesDB = []; }
}
function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(casesDB, null, 2)); }

// ── Hash ──────────────────────────────────────────
function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ── Evidence Chain ────────────────────────────────
function initChain(caseId, hash, confidence) {
  const block = {
    index: 0, action: 'CASE_CREATED',
    caseId, mediaHash: hash, confidence,
    timestamp: new Date().toISOString(),
    prevHash: '0'.repeat(64)
  };
  block.hash = crypto.createHash('sha256')
    .update(JSON.stringify({...block, hash: undefined})).digest('hex');
  return [block];
}

function appendChain(chain, caseId, hash, confidence, action) {
  const prev  = chain[chain.length - 1];
  const block = {
    index: chain.length, action,
    caseId, mediaHash: hash, confidence,
    timestamp: new Date().toISOString(),
    prevHash: prev.hash
  };
  block.hash = crypto.createHash('sha256')
    .update(JSON.stringify({...block, hash: undefined})).digest('hex');
  chain.push(block);
  return chain;
}

// ── AI Detection ──────────────────────────────────
async function detectWithAI(filePath, mimetype) {

  // ── Sightengine — Deepfake + AI Generated ──────
  if (SE_USER && SE_SECRET) {
    console.log('   Mode: Sightengine AI (Deepfake + AI Generated)');
    try {
      const form = new FormData();
      form.append('media',      fs.createReadStream(filePath));
      form.append('models', 'deepfake,genai,face-attributes');  // ✅ FIXED: 'ai-generated' → 'genai'
      form.append('api_user',   SE_USER);
      form.append('api_secret', SE_SECRET);

      const url = mimetype.startsWith('video')
        ? 'https://api.sightengine.com/1.0/video/check-sync.json'
        : 'https://api.sightengine.com/1.0/check.json';

      const resp = await axios.post(url, form, { headers: form.getHeaders(), timeout: 30000 });
      const data = resp.data;

      console.log('   Sightengine raw response:', JSON.stringify(data, null, 2));

      // ── Deepfake score ─────────────────────────
      let deepfakeScore = 0;
      if (data.type && data.type.deepfake !== undefined)   deepfakeScore = data.type.deepfake;
      else if (data.deepfake !== undefined)                 deepfakeScore = data.deepfake;

      // ── AI Generated score ─────────────────────
      // Sightengine 'genai' model returns: data.type.ai_generated  (0 to 1)
      let aiGenScore = 0;
      if (data.type && data.type.ai_generated !== undefined) {
        aiGenScore = data.type.ai_generated;                // ✅ FIXED: correct response path
      } else if (data.ai_generated && data.ai_generated.score !== undefined) {
        aiGenScore = data.ai_generated.score;               // fallback
      }

      let faceManipScore = 0;
      if (data.faces && data.faces[0]) {
        const face = data.faces[0];
        if (face.attributes && face.attributes.multicultural !== undefined) {
          faceManipScore = face.attributes.multicultural;
        }
      }
      console.log(`   Face Manipulation: ${faceManipScore}`);
      console.log(`   Deepfake score    : ${deepfakeScore}`);
      console.log(`   AI Generated score: ${aiGenScore}`);

      // ── Detection type decide ──────────────────
      const isDeepfake    = deepfakeScore >= 0.5;
      const isAIGenerated = aiGenScore    >= 0.5;

      let detectionType = 'authentic';
      let primaryScore  = Math.max(deepfakeScore, aiGenScore);

      if (isDeepfake && isAIGenerated) {
        detectionType = deepfakeScore >= aiGenScore ? 'deepfake' : 'ai_generated';
      } else if (isDeepfake) {
        detectionType = 'deepfake';
        primaryScore  = deepfakeScore;
      } else if (isAIGenerated) {
        detectionType = 'ai_generated';
        primaryScore  = aiGenScore;
      } else {
        primaryScore = Math.max(1 - deepfakeScore, 1 - aiGenScore);
      }

      const isFake     = detectionType !== 'authentic';
      const confidence = Math.round(primaryScore * 100);

      let severity = 'low';
      if (primaryScore >= 0.85)      severity = 'critical';
      else if (primaryScore >= 0.70) severity = 'high';
      else if (primaryScore >= 0.50) severity = 'medium';

      return {
        isDeepfake:     isFake,
        detectionType,
        deepfakeScore,
        aiGenScore,
        confidence,
        score:          parseFloat(primaryScore.toFixed(4)),
        severity,
        mode:           'Sightengine AI'
      };

    } catch(err) {
      console.log(`   Sightengine error: ${err.message}`);
      if (err.response) {
        console.log(`   Response data:`, JSON.stringify(err.response.data, null, 2));
      }
      throw new Error('Sightengine detection failed: ' + err.message);
    }
  }

  // ── DEMO mode (no keys) ────────────────────────
  console.log('   Mode: DEMO (add SE_USER/SE_SECRET in .env for real AI)');
  const size  = fs.statSync(filePath).size;
  const score = (size % 100) / 200;
  const demoType = score > 0.4 ? 'deepfake' : score > 0.2 ? 'ai_generated' : 'authentic';
  return {
    isDeepfake:    demoType !== 'authentic',
    detectionType: demoType,
    deepfakeScore: score,
    aiGenScore:    score * 0.6,
    confidence:    Math.round(60 + (size % 35)),
    score,
    severity: score > 0.6 ? 'high' : score > 0.3 ? 'medium' : 'low',
    mode: 'DEMO MODE'
  };
}

// ── POST /api/detect ──────────────────────────────
app.post('/api/detect', upload.single('file'), async (req, res) => {
  console.log('\n══════════════════════════════════════');
  if (!req.file) {
    console.log('❌ No file received');
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }
  console.log(`📥 File    : ${req.file.originalname}`);
  console.log(`📦 Size    : ${(req.file.size / 1024).toFixed(1)} KB`);
  console.log('🤖 Analyzing...');

  const hash   = fileHash(req.file.path);
  const caseId = `DF-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  try {
    const ai = await detectWithAI(req.file.path, req.file.mimetype);

    let verdictLabel = 'AUTHENTIC MEDIA';
    if (ai.detectionType === 'deepfake')     verdictLabel = 'DEEPFAKE DETECTED';
    if (ai.detectionType === 'ai_generated') verdictLabel = 'AI GENERATED IMAGE';

    console.log(`\n🎯 VERDICT      : ${ai.isDeepfake ? '🔴 ' + verdictLabel : '🟢 AUTHENTIC MEDIA'}`);
    console.log(`🔍 Type         : ${ai.detectionType}`);
    console.log(`📊 Confidence   : ${ai.confidence}%`);
    console.log(`📈 Deepfake     : ${(ai.deepfakeScore * 100).toFixed(1)}%`);
    console.log(`🤖 AI Generated : ${(ai.aiGenScore * 100).toFixed(1)}%`);
    console.log(`⚠️  Severity     : ${ai.severity.toUpperCase()}`);
    console.log(`🔑 Case ID      : ${caseId}`);
    console.log('══════════════════════════════════════\n');

    const record = {
      caseId,
      fileName:      req.file.originalname,
      fileType:      req.file.mimetype,
      fileSize:      req.file.size,
      mediaHash:     hash,
      isDeepfake:    ai.isDeepfake,
      detectionType: ai.detectionType,
      deepfakeScore: parseFloat(ai.deepfakeScore.toFixed(4)),
      aiGenScore:    parseFloat(ai.aiGenScore.toFixed(4)),
      confidence:    ai.confidence,
      score:         ai.score,
      severity:      ai.severity,
      status:        'pending',
      govtRef:       null,
      maskedUid:     `CIT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      evidenceChain: initChain(caseId, hash, ai.confidence),
      timestamp:     new Date().toISOString()
    };

    casesDB.push(record);
    saveDB();
    try { fs.unlinkSync(req.file.path); } catch(e) {}

    res.json({
      success:        true,
      caseId:         record.caseId,
      isDeepfake:     record.isDeepfake,
      detectionType:  record.detectionType,
      deepfakeScore:  record.deepfakeScore,
      aiGenScore:     record.aiGenScore,
      confidence:     record.confidence,
      severity:       record.severity,
      verdict:        verdictLabel,
      mediaHash:      record.mediaHash,
      status:         record.status,
      model:          ai.mode
    });

  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/report ──────────────────────────────
app.post('/api/report', (req, res) => {
  const { caseId, description, location } = req.body;
  const record = casesDB.find(c => c.caseId === caseId);
  if (!record) return res.status(404).json({ success: false, error: 'Case not found' });
  record.description   = description;
  record.location      = location || null;
  record.status        = 'under_review';
  record.evidenceChain = appendChain(record.evidenceChain, caseId, record.mediaHash, record.confidence, 'REPORT_FILED');
  saveDB();
  console.log(`📋 Report filed: ${caseId}`);
  res.json({ success: true, caseId, status: 'under_review' });
});

// ── POST /api/escalate ────────────────────────────
app.post('/api/escalate', (req, res) => {
  const { caseId } = req.body;
  const record = casesDB.find(c => c.caseId === caseId);
  if (!record) return res.status(404).json({ success: false, error: 'Case not found' });
  const govtRef      = `MHA/${new Date().getFullYear()}/CYB/${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  record.status      = 'escalated';
  record.govtRef     = govtRef;
  record.evidenceChain = appendChain(record.evidenceChain, caseId, record.mediaHash, record.confidence, `ESCALATED:${govtRef}`);
  saveDB();
  console.log(`🏛️  GOVT ESCALATED: ${caseId} → ${govtRef}`);
  res.json({
    success:   true,
    caseId,
    govtRef,
    authority: 'Cyber Crime Wing, Ministry of Home Affairs',
    portal:    'https://cybercrime.gov.in',
    status:    'escalated'
  });
});

// ── GET /api/cases ────────────────────────────────
app.get('/api/cases', (req, res) => {
  res.json({
    success: true,
    total:   casesDB.length,
    cases:   casesDB.map(c => ({
      caseId:        c.caseId,
      fileName:      c.fileName,
      isDeepfake:    c.isDeepfake,
      detectionType: c.detectionType || 'deepfake',
      deepfakeScore: c.deepfakeScore || 0,
      aiGenScore:    c.aiGenScore    || 0,
      confidence:    c.confidence,
      severity:      c.severity,
      status:        c.status,
      govtRef:       c.govtRef,
      maskedUid:     c.maskedUid,
      timestamp:     c.timestamp
    }))
  });
});

// ── GET /api/stats ────────────────────────────────
app.get('/api/stats', (req, res) => {
  const total     = casesDB.length;
  const fakes     = casesDB.filter(c => c.isDeepfake).length;
  const escalated = casesDB.filter(c => c.status === 'escalated').length;
  const resolved  = casesDB.filter(c => c.status === 'resolved').length;
  const now       = Date.now();
  const week      = Array.from({length: 7}, (_, i) => {
    const d   = new Date(now - (6 - i) * 86400000);
    const day = d.toISOString().slice(0, 10);
    return {
      day:   ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()],
      count: casesDB.filter(c => c.timestamp && c.timestamp.startsWith(day)).length
    };
  });
  res.json({ success: true, total, fakes, escalated, resolved, week });
});

// ── GET /api/cases/:id/chain ──────────────────────
app.get('/api/cases/:id/chain', (req, res) => {
  const record = casesDB.find(c => c.caseId === req.params.id);
  if (!record) return res.status(404).json({ success: false, error: 'Case not found' });
  let valid = true;
  for (let i = 0; i < record.evidenceChain.length; i++) {
    const b        = record.evidenceChain[i];
    const copy     = {...b, hash: undefined};
    const computed = crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');
    if (computed !== b.hash || (i > 0 && b.prevHash !== record.evidenceChain[i-1].hash)) {
      valid = false; break;
    }
  }
  res.json({ success: true, caseId: req.params.id, valid, chain: record.evidenceChain });
});

// ── Start ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🛡  DeepShield: http://localhost:${PORT}`);
  if (SE_USER && SE_SECRET) console.log('✅ Sightengine AI ready — Deepfake + AI Generated detection');
  else                      console.log('⚠  DEMO mode — add SE_USER/SE_SECRET in .env for real AI');
  console.log('');
});