const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'local-development-secret-change-me');
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET wajib diatur pada environment production');
}

function signUser(user) {
  return jwt.sign(
    { id: user.id, role: user.role, nama: user.nama, mitra_id: user.mitra_id || null },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

module.exports = { JWT_SECRET, JWT_EXPIRES, signUser };
