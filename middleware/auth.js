const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../utils/security');
const db = require('../db/database');

module.exports = function auth(requiredRoles = []) {
  return async (req, res, next) => {
    const hdr = req.headers.authorization || '';
    let token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;

    if (!token) return res.status(401).json({ error: 'Token diperlukan' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ error: 'Token tidak valid' });
    }

    let user;
    try {
      user = await db.get('SELECT id, nama, email, telepon, role, mitra_id, aktif FROM users WHERE id=?', [payload.id]);
    } catch (error) {
      return next(error);
    }

    if (!user || !user.aktif) {
      return res.status(401).json({ error: 'Akun tidak aktif' });
    }
    req.user = user;
    if (requiredRoles.length && !requiredRoles.includes(user.role)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    return next();
  };
};