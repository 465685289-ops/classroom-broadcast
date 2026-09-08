'use strict';

const {
  normalizeClassTimetable,
  validateClassTimetableStructure
} = require('./class-timetable');
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

    const current = normalizeClassTimetable(cls.timetable);
    if (!current.structure.configured) {
      return res.status(400).json({ error: '请先确认本班课程结构，再填写课程表' });
    }
    const timetable = normalizeClassTimetable({
      entries: req.body && req.body.entries,
      structure: current.structure,
      // 教师端「教室与班级」的显示开关独立维护；只改 entries 的保存不得重置它
      visible: current.visible,
      updated_at: new Date().toISOString()
    });
    cls.timetable = dbStore.saveClassTimetable(cls.id, timetable);
    if (state.io) state.io.to(`class:${cls.id}`).emit('class-timetable-update', cls.timetable);
    return res.json({ timetable: cls.timetable, is_owner: true });
  });

  app.put('/api/classes/:classId/timetable/structure', userAuth, requireActivePlan, (req, res) => {
    const cls = visibleClass(req.params.classId, req.user.id);
    if (!cls) return res.status(404).json({ error: '班级不存在' });
    if (cls.user_id !== req.user.id) {
      return res.status(403).json({ error: '只有班级创建者可以修改课程结构' });
    }
    try {
      const current = normalizeClassTimetable(cls.timetable);
      const structure = validateClassTimetableStructure(req.body);
      const timetable = normalizeClassTimetable({
        entries: current.entries,
        structure,
        visible: current.visible,
        updated_at: new Date().toISOString()
      });
      cls.timetable = dbStore.saveClassTimetable(cls.id, timetable);
      if (state.io) state.io.to(`class:${cls.id}`).emit('class-timetable-update', cls.timetable);
      return res.json({ timetable: cls.timetable, is_owner: true });
    } catch (error) {
      return res.status(400).json({ error: String(error && error.message || '课程结构设置无效') });
    }
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
    const current = normalizeClassTimetable(cls.timetable);
    const timetable = normalizeClassTimetable({
      entries: current.entries,
      structure: current.structure,
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
