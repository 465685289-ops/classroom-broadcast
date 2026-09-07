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
      // 教师端「教室与班级」的显示开关独立维护；只改 entries 的保存不得重置它
      visible: !(cls.timetable && cls.timetable.visible === false),
      updated_at: new Date().toISOString()
    });
    cls.timetable = dbStore.saveClassTimetable(cls.id, timetable);
    if (state.io) state.io.to(`class:${cls.id}`).emit('class-timetable-update', cls.timetable);
    return res.json({ timetable: cls.timetable, is_owner: true });
  });

  app.put('/api/classes/:classId/timetable/visibility', userAuth, (req, res) => {
    const cls = visibleClass(req.params.classId, req.user.id);
    if (!cls) return res.status(404).json({ error: '班级不存在' });
    if (cls.user_id !== req.user.id) {
      return res.status(403).json({ error: '只有班级创建者可以修改课程表' });
    }

    const requested = req.body ? req.body.visible : undefined;
    if (typeof requested !== 'boolean') {
      return res.status(400).json({ error: 'visible 必须为布尔值' });
    }
    const timetable = normalizeClassTimetable({
      entries: cls.timetable && cls.timetable.entries,
      visible: requested,
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
