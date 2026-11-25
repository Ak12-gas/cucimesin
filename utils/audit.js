const db = require('../db/database');

async function writeAudit(entityType, entityId, action, actor, detail = null, connection) {
  if (!actor) return;
  await db.run(`
    INSERT INTO audit_log (entity_type, entity_id, action, actor_id, actor_role, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    entityType,
    entityId == null ? null : Number(entityId),
    action,
    actor.id || null,
    actor.role || null,
    detail ? JSON.stringify(detail) : null
  ], connection);
}

module.exports = { writeAudit };
