// pm2 start ecosystem.config.js  — pm2 restarts the bot automatically if it crashes or the watchdog exits it.
module.exports = {
  apps: [{
    name: 'monday-sheets-sync',
    script: 'src/index.js',
    autorestart: true,
    restart_delay: 10000,
    max_memory_restart: '300M',
    time: true,
  }],
};
