// Personal documents on a learner's or staff member's profile (supabase/migrations/0003_user_documents.sql).
// The owner manages their own (portal "My details" / admin "My account"); administrators see and manage anyone's
// on that person's page. Files are uploaded straight to private storage (purpose "document" in storage.js).
const { db } = require('./db');
const storage = require('./storage');

const TYPES = {
  id: 'Proof of ID', address: 'Proof of address', qualification: 'Qualification certificate', cv: 'CV',
  dbs: 'DBS check', right_to_work: 'Right to work', other: 'Other',
};

const listFor = userId => db.all(`SELECT d.*, u.name uploaded_by_name FROM user_documents d
  LEFT JOIN users u ON u.id=d.uploaded_by WHERE d.user_id=? ORDER BY d.created_at DESC, d.id DESC`, userId);

const find = id => db.get('SELECT * FROM user_documents WHERE id=?', id);

// Saves the document the browser just uploaded for userId. Returns an error message, or '' when saved.
async function save(userId, uploadedBy, body) {
  const file = await storage.receive(body, 'document');
  if (!file) return 'Choose the file to upload: PDF, Word, JPG or PNG, up to 20 MB.';
  const kind = Object.prototype.hasOwnProperty.call(TYPES, body.kind) ? body.kind : 'other';
  try {
    await db.run('INSERT INTO user_documents (user_id,kind,title,file,original_name,uploaded_by) VALUES (?,?,?,?,?,?)',
      userId, kind, String(body.title || '').trim().slice(0, 120) || null, file.filename, file.originalname, uploadedBy);
  } catch (err) {
    await storage.remove('documents', file.filename);
    throw err;
  }
  return '';
}

// Deletes a document and its file
async function remove(doc) {
  await db.run('DELETE FROM user_documents WHERE id=?', doc.id);
  await storage.remove('documents', doc.file);
}

// Deletes the files of every document a user has (call before deleting the account; the rows go with it)
async function removeAllFor(userId) {
  const files = (await db.all('SELECT file FROM user_documents WHERE user_id=?', userId)).map(d => d.file);
  for (let i = 0; i < files.length; i += 100) await storage.remove('documents', ...files.slice(i, i + 100));
}

// A short-lived link that opens the file (PDFs and images in the browser; Word files download under their own name)
const link = doc => storage.signedUrl('documents', doc.file, 300, /\.(pdf|jpe?g|png)$/i.test(doc.file) ? undefined : (doc.original_name || doc.file));

module.exports = { TYPES, listFor, find, save, remove, removeAllFor, link };
