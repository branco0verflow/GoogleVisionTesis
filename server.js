

require('dotenv').config();

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const sharp   = require('sharp');
const vision  = require('@google-cloud/vision');

const app = express();

// ───────────────── CORS ─────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_ORIGIN || '*',
    'https://tallervidesol.com',
    'https://www.tallervidesol.com',
    'https://tesis-taller-front-git-main-branco0verflows-projects.vercel.app'
  ],
  credentials: true
}));


// ─────────── Google Vision Client ───────
// Opción A: Pegar JSON completo en GOOGLE_CLOUD_KEY_JSON
// Opción B: Pegar JSON en base64 en GOOGLE_CLOUD_KEY_BASE64
// Opción C: Si definís GOOGLE_APPLICATION_CREDENTIALS (path) Render tiene que generar ese file, no recomendado.
let visionClient;
(() => {
  const json = process.env.GOOGLE_CLOUD_KEY_JSON;
  const b64  = process.env.GOOGLE_CLOUD_KEY_BASE64;

  if (json) {
    const creds = JSON.parse(json);
    visionClient = new vision.ImageAnnotatorClient({
      credentials: {
        client_email: creds.client_email,
        private_key: creds.private_key,
      },
      projectId: creds.project_id,
    });
  } else if (b64) {
    const creds = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    visionClient = new vision.ImageAnnotatorClient({
      credentials: {
        client_email: creds.client_email,
        private_key: creds.private_key,
      },
      projectId: creds.project_id,
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Path a un archivo montado/manual (menos práctico en Render)
    visionClient = new vision.ImageAnnotatorClient();
  } else {
    throw new Error('No se encontraron credenciales para Google Cloud Vision.');
  }
})();

// ─────────── Multer en memoria ──────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }, // 6MB
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(file.mimetype);
    cb(ok ? null : new Error('Formato de imagen no permitido (usa jpg/png/webp/heic)'), ok);
  }
});

// ─────────── Utils de imagen/OCR ────────
async function cleanImage(buffer) {
  return sharp(buffer)
    .rotate() // auto-rotate por metadatos EXIF
    .resize({ width: 1600, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .modulate({ brightness: 1.08, saturation: 1.15 })
    .toBuffer();
}

async function ocrBestRotation(buffer) {
  const angles = [0, 90, 180, 270];
  let best = { text: '', hits: -1 };

  for (const angle of angles) {
    const rotated = await sharp(buffer).rotate(angle).toBuffer();

    const [res] = await visionClient.annotateImage({
      image: { content: rotated },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      imageContext: { languageHints: ['es'] }
    });

    const txt  = res.fullTextAnnotation?.text ?? '';
    const hits = (txt.match(/(Matric|Motor|Chasis|Titular)/gi) || []).length;

    if (hits > best.hits) best = { text: txt, hits };
  }
  return best.text;
}

function parseTexto(texto) {
  const lineas = texto.split('\n').map(l => l.trim());
  const plano  = texto.replace(/\n/g, ' ');

  const vin       = plano.match(/([A-HJ-NPR-Za-hj-npr-z0-9]{17})/)?.[1] ?? null;
  const motor     = plano.match(/motor\s*[:\-]?\s*([A-Z0-9\-]{6,})/i)?.[1] ?? null;
  const matricula = plano.match(/matr[ií]cula\s*[:\-]?\s*([A-Z]{2,3}\s?\d{3,4})/i)?.[1] ?? null;
  const modelo    = plano.match(/modelo\s*[:\-]?\s*([A-Z0-9 \-]{2,40})/i)?.[1] ?? null;
  const anio      = plano.match(/(año|a\u00f1o)\s*[:\-]?\s*(\d{4})/i)?.[2] ?? null;
  const cilindrada= plano.match(/cilindrada\s*[:\-]?\s*([\d.]{3,5})/i)?.[1] ?? null;

  const simple = tag => plano.match(new RegExp(`${tag}\\s*[:\\-]?\\s*([^\\s]{2,30})`, 'i'))?.[1] ?? null;
  const marca  = simple('marca');

  let titulares = null;
  for (let i = 0; i < lineas.length; i++) {
    if (/titulares?[:\-]?/i.test(lineas[i])) {
      titulares = lineas[i].replace(/titulares?[:\-]?/i, '').trim();
      const stop = /(chasis|motor|marca|modelo|año|cilindrada|matr[ií]cula)/i;
      let j = i + 1;
      while (j < lineas.length && !stop.test(lineas[j])) {
        titulares += ' ' + lineas[j];
        j++;
      }
      titulares = titulares.trim();
      break;
    }
  }

  return { chasis: vin, motor, marca, modelo, anio, cilindrada, matricula, titulares };
}

// ─────────── Rutas ───────────────────────
app.get('/', (_req, res) => res.send('OK')); // healthcheck para Render

app.post('/detectar-texto', upload.single('imagen'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se envió imagen' });

  try {
    const cleaned = await cleanImage(req.file.buffer);
    const texto   = await ocrBestRotation(cleaned);

    if (!texto) return res.json({ error: 'No se detectó texto en la imagen.' });

    const datos = parseTexto(texto);
    return res.json(datos);

  } catch (err) {
    console.error('OCR error:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────── Arranque ────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 OCR listo en puerto ${PORT}`));
