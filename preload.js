'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// окну игры доступно только одно: поиск слов песни
contextBridge.exposeInMainWorld('cbApp', {
  findLyrics: (q) => ipcRenderer.invoke('lyrics:find', q),
});
