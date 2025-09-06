/**
 * OCR libreta de vehículo – Backend Node.js
 * Autor: Branco & ChatGPT
 * ----------------------------------------
 * End-point: POST /detectar-texto   (form-data: field "imagen")
 */

require('dotenv').config(); // Lee variables de .env

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const sharp   = require('sharp');
const vision  = require('@google-cloud/vision');
const fs      = require('fs');

const app = express();
app.use(cors());

// 1. ─────────────  Google Vision  ─────────────
const client = new vision.ImageAnnotatorClient({
  // O bien poné GOOGLE_APPLICATION_CREDENTIALS en .env
  keyFilename: process.env.GCP_KEYFILE || '../../tallerwebtesis-a1a21c5a421b.json'
});

// 2. ─────────────  Multer (tmp dir)  ──────────
const upload = multer({ dest: 'uploads/' });

// 3. ─────────────  Utils  ─────────────────────

// Mejora contraste + escala de grises + resize
async function cleanImage(inputPath) {
  return sharp(inputPath)
    .resize({ width: 1600, withoutEnlargement: true })
    .grayscale()
    .normalise()
    .modulate({ brightness: 1.1, saturation: 1.2 })
    .toBuffer();
}

// Prueba 0°, 90°, 180°, 270°  y devuelve el texto con más “hits”
async function ocrBestRotation(buffer) {
  const angles = [0, 90, 180, 270];
  let best = { text: '', hits: -1 };

  for (const angle of angles) {
    const rotated = await sharp(buffer).rotate(angle).toBuffer();

    const [res] = await client.annotateImage({
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

// Extrae datos con regex
function parseTexto(texto) {
  const lineas = texto.split('\n').map(l => l.trim());
  const plano  = texto.replace(/\n/g, ' ');

  const vin = plano.match(/([A-HJ-NPR-Za-hj-npr-z0-9]{17})/)?.[1] ?? null;
  const motor = plano.match(/motor\s*[:\-]?\s*([A-Z0-9\-]{6,})/i)?.[1] ?? null;

  const simple = tag => plano.match(new RegExp(`${tag}\\s*[:\\-]?\\s*([^\\s]{2,30})`, 'i'))?.[1] ?? null;
  const marca      = simple('marca');
  const modelo     = plano.match(/modelo\s*[:\-]?\s*([A-Z0-9 \-]{2,40})/i)?.[1] ?? null;
  const anio       = plano.match(/(año|a\u00f1o)\s*[:\-]?\s*(\d{4})/i)?.[2] ?? null;
  const cilindrada = plano.match(/cilindrada\s*[:\-]?\s*([\d.]{3,5})/i)?.[1] ?? null;
  const matricula  = plano.match(/matr[ií]cula\s*[:\-]?\s*([A-Z]{2,3}\s?\d{3,4})/i)?.[1] ?? null;

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

// 4. ─────────────  Ruta principal  ────────────
app.post('/detectar-texto', upload.single('imagen'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se envió imagen' });

  try {
    const cleaned = await cleanImage(req.file.path);
    const texto   = await ocrBestRotation(cleaned);

    fs.unlink(req.file.path, () => {}); // borra tmp

    if (!texto) return res.json({ error: 'No se detectó texto en la imagen.' });

    const datos = parseTexto(texto);
    return res.json(datos);

  } catch (err) {
    console.error('OCR error:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// 5. ─────────────  Arranque  ──────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀  OCR listo en http://localhost:${PORT}`));
