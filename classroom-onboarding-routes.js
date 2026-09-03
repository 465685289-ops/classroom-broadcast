'use strict';

const dbStore = require('./db');
const { userAuth } = require('./middleware');
const state = require('./state');

function ownedClasses(userId) {
  const store = state.store || { classes: [] };
  return (store.classes || [])
    .filter(cls => cls.user_id === userId)
    .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')) || String(left.id).localeCompare(String(right.id)));
}

function firstHistoricNotification(userId, classes) {
  const classIds = new Set(classes.map(cls => cls.id));
  const store = state.store || { notifications: [] };
  return (store.notifications || [])
    .filter(notification => notification.user_id === userId && classIds.has(notification.class_id))
    .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')) || Number(left.id) - Number(right.id))[0] || null;
}

function onlineCounts() {
  const counts = {};
  if (!state.io) return counts;
  for (const [, socket] of state.io.of('/').sockets) {
    if (socket.classId) counts[socket.classId] = (counts[socket.classId] || 0) + 1;
  }
  return counts;
}

function classroomResponse(cls, count) {
  if (!cls) return null;
  return {
    id: cls.id,
    name: cls.name,
    grade: cls.grade || 'junior',
    bind_code: cls.bind_code,
    online: count || 0
  };
}

function backfillClassroomOnboarding(userId) {
  const classes = ownedClasses(userId);
  let record = dbStore.getClassroomOnboarding(userId);
  if (record && record.first_class_id && !classes.some(cls => cls.id === record.first_class_id)) {
    dbStore.clearClassroomOnboardingForClass(userId, record.first_class_id);
    record = null;
  }
  if (record || !classes.length) return record;

  const historic = firstHistoricNotification(userId, classes);
  if (historic) {
    dbStore.rememberOnboardingClass(userId, historic.class_id, historic.created_at);
    dbStore.markOnboardingScreenConnected(userId, historic.class_id, historic.created_at);
    return dbStore.markOnboardingFirstNotification(userId, historic.class_id, historic.id, historic.created_at);
  }
  return dbStore.rememberOnboardingClass(userId, classes[0].id, classes[0].created_at);
}

function classroomOnboardingState(userId) {
  const record = backfillClassroomOnboarding(userId);
  const classes = ownedClasses(userId);
  const classroom = record ? classes.find(cls => cls.id === record.first_class_id) || null : null;
  const steps = {
    class_created: !!classroom,
    screen_connected: !!(record && record.screen_connected_at),
    first_notice_sent: !!(record && record.first_notification_at)
  };
  const completed = steps.class_created && steps.screen_connected && steps.first_notice_sent;
  const nextStep = !steps.class_created
    ? 'create_class'
    : !steps.screen_connected
      ? 'connect_screen'
      : !steps.first_notice_sent
        ? 'send_test_notice'
        : 'complete';
  const counts = onlineCounts();
  return {
    classroom: classroomResponse(classroom, classroom && counts[classroom.id]),
    steps,
    next_step: nextStep,
    completed
  };
}

function rememberClassroomOnboardingClass(userId, classId, at) {
  return dbStore.rememberOnboardingClass(userId, classId, at);
}

function markClassroomOnboardingScreenConnected(userId, classId, at) {
  return dbStore.markOnboardingScreenConnected(userId, classId, at);
}

function markClassroomOnboardingFirstNotification(userId, classId, notificationId, at) {
  return dbStore.markOnboardingFirstNotification(userId, classId, notificationId, at);
}

function clearClassroomOnboardingForClass(userId, classId) {
  return dbStore.clearClassroomOnboardingForClass(userId, classId);
}

function installClassroomOnboardingRoutes(app) {
  app.get('/api/classroom-onboarding', userAuth, (req, res) => {
    return res.json(classroomOnboardingState(req.user.id));
  });
}

module.exports = {
  installClassroomOnboardingRoutes,
  rememberClassroomOnboardingClass,
  markClassroomOnboardingScreenConnected,
  markClassroomOnboardingFirstNotification,
  clearClassroomOnboardingForClass
};
