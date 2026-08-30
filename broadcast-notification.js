'use strict';

function normalizeBroadcastMode(value) {
  return value === 'text' ? 'text' : 'voice';
}

module.exports = {
  normalizeBroadcastMode
};
