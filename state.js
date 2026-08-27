'use strict';
// 全局运行态容器：store(内存业务数据) / io(Socket.IO 实例)。
// server.js 启动时注入；其他模块经此读取，避免循环 require。
// store 初始化后从不整体重绑定，此处引用始终有效。
module.exports = {};
