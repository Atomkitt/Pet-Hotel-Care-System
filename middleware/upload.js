// middleware/upload.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// Public folder strictly for non-sensitive Pet Avatars
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
// Private non-public storage for sensitive documents (Vaccine Certificates & Payment Slips)
const PRIVATE_VACCINE_DIR = path.join(__dirname, '..', 'storage', 'vaccines');
const PRIVATE_SLIP_DIR = path.join(__dirname, '..', 'storage', 'slips');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PRIVATE_VACCINE_DIR, { recursive: true });
fs.mkdirSync(PRIVATE_SLIP_DIR, { recursive: true });

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp'
]);

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Inspects actual binary file header (Magic Bytes) for JPEG, PNG, and WEBP.
 */
function hasValidImageMagicBytes(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, header, 0, 12, 0);
    if (bytesRead < 4) return false;

    // JPEG: FF D8 FF
    const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    const isPng =
      bytesRead >= 8 &&
      header[0] === 0x89 &&
      header[1] === 0x50 &&
      header[2] === 0x4e &&
      header[3] === 0x47 &&
      header[4] === 0x0d &&
      header[5] === 0x0a &&
      header[6] === 0x1a &&
      header[7] === 0x0a;
    // WEBP: "RIFF" (0..3) .... "WEBP" (8..11)
    const isWebp =
      bytesRead >= 12 &&
      header.toString('ascii', 0, 4) === 'RIFF' &&
      header.toString('ascii', 8, 12) === 'WEBP';

    return isJpeg || isPng || isWebp;
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }
}

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mimeOk = ALLOWED_MIME_TYPES.has(String(file.mimetype).toLowerCase());
  const extOk = ALLOWED_EXTENSIONS.has(ext);

  if (!mimeOk || !extOk) {
    const err = new Error('Invalid file type. Only JPG, JPEG, PNG, and WEBP images are allowed.');
    err.status = 400;
    err.code = 'INVALID_FILE_TYPE';
    return cb(err, false);
  }

  return cb(null, true);
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    if (file.fieldname === 'vaccine_card') {
      return cb(null, PRIVATE_VACCINE_DIR);
    }
    if (file.fieldname === 'slip') {
      return cb(null, PRIVATE_SLIP_DIR);
    }
    return cb(null, UPLOAD_DIR);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : '.png';
    let safePrefix = 'pet';
    if (file.fieldname === 'vaccine_card') safePrefix = 'vaccine';
    if (file.fieldname === 'slip') safePrefix = 'slip';
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    cb(null, `${safePrefix}-${uniqueSuffix}${safeExt}`);
  }
});

const uploadInstance = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 2
  },
  fileFilter
});

const uploadPetFields = uploadInstance.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'vaccine_card', maxCount: 1 }
]);

const uploadSlipSingle = uploadInstance.single('slip');

function unlinkQuietly(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

function formatMulterError(res, err) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File size exceeds the 5MB limit. Please upload a smaller image.'
      });
    }
    return res.status(400).json({
      error: `Upload error: ${err.message}`
    });
  }

  return res.status(err.status || 400).json({
    error: err.message || 'Invalid file upload.'
  });
}

/**
 * Express middleware handling multipart/form-data pet uploads + Magic-Byte verification.
 */
function handlePetUploads(req, res, next) {
  uploadPetFields(req, res, (err) => {
    if (err) return formatMulterError(res, err);

    const uploadedList = [];
    if (req.files && req.files.photo && req.files.photo[0]) uploadedList.push(req.files.photo[0]);
    if (req.files && req.files.vaccine_card && req.files.vaccine_card[0]) uploadedList.push(req.files.vaccine_card[0]);

    for (const fileObj of uploadedList) {
      if (!hasValidImageMagicBytes(fileObj.path)) {
        for (const f of uploadedList) unlinkQuietly(f.path);
        return res.status(400).json({
          error: 'Invalid image file content: binary signature does not match JPEG, PNG, or WEBP.'
        });
      }
    }

    return next();
  });
}

/**
 * Express middleware handling optional/required PromptPay payment slip image upload + Magic-Byte verification.
 */
function handlePaymentSlipUpload(req, res, next) {
  uploadSlipSingle(req, res, (err) => {
    if (err) return formatMulterError(res, err);

    if (req.file && !hasValidImageMagicBytes(req.file.path)) {
      unlinkQuietly(req.file.path);
      return res.status(400).json({
        error: 'Invalid payment slip image: binary signature does not match JPEG, PNG, or WEBP.'
      });
    }

    return next();
  });
}

function removeUploadedFile(publicUrlPath) {
  if (!publicUrlPath || !String(publicUrlPath).startsWith('/uploads/')) return;
  const filename = path.basename(publicUrlPath);
  if (filename.startsWith('sample-')) return;
  fs.unlink(path.join(UPLOAD_DIR, filename), () => {});
}

function removePrivateVaccineFile(storedRef) {
  if (!storedRef) return;
  const filename = path.basename(String(storedRef));
  if (!filename || filename.startsWith('sample-')) return;
  fs.unlink(path.join(PRIVATE_VACCINE_DIR, filename), () => {});
}

function removePrivateSlipFile(storedRef) {
  if (!storedRef) return;
  const filename = path.basename(String(storedRef));
  if (!filename || filename.startsWith('sample-')) return;
  fs.unlink(path.join(PRIVATE_SLIP_DIR, filename), () => {});
}

module.exports = {
  UPLOAD_DIR,
  PRIVATE_VACCINE_DIR,
  PRIVATE_SLIP_DIR,
  handlePetUploads,
  handlePaymentSlipUpload,
  removeUploadedFile,
  removePrivateVaccineFile,
  removePrivateSlipFile
};
