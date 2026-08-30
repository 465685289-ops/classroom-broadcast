'use strict';

const { normalizeClassTimetable } = require('./class-timetable');
const dbStore = require('./db');
const { userAuth } = require('./middleware');
const state = require('./state');

function visibleClass(classId, userId) {
  const store = state.store || { classes: [] };
  return store.classes.find(cls => cls.id === classId && (
    cls.user_id === userId || (cls.member_ids || []).includes(userId)
  ));
}

function installTimetableRoutes(app, options = {}) {
  const requireActivePlan = options.requireActivePlan;
  if (typeof requireActivePlan !== 'function') {
    throw new Error('installTimetableRoutes requires requireActivePlan');
  }

  app.get('/api/classes/:classId/timetable', userAuth, (req, res) => {
    const cls = visibleClass(req.params.classId, req.user.id);
    if (!cls) return res.status(404).json({ error: '班级不存在' });
    return res.json({
      timetable: normalizeClassTimetable(cls.timetable),
      is_owner: cls.user_id === req.user.id
    });
  });

  app.put('/api/classes/:classId/timetable', userAuth, requireActivePlan, (req, res) => {
    const cls = visibleClass(req.params.classId, req.user.id);
    if (!cls) return res.status(404).json({ error: '班级不存在' });
    if (cls.user_id !== req.user.id) {
      return res.status(403).json({ error: '只有班级创建者可以修改课程表' });
    }

    const timetable = normalizeClassTimetable({
      entries: req.body && req.body.entries,
      updated_at: new Date().toISOString()
    });
    cls.timetable = dbStore.saveClassTimetable(cls.id, timetable);
    if (state.io) state.io.to(`class:${cls.id}`).emit('class-timetable-update', cls.timetable);
    return res.json({ timetable: cls.timetable, is_owner: true });
  });
}

module.exports = {
  installTimetableRoutes
};
